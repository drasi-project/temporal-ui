import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (
  process.env.DRASI_POSTGRES_E2E !== undefined &&
  !['0', '1'].includes(process.env.DRASI_POSTGRES_E2E)
) {
  throw new Error('DRASI_POSTGRES_E2E must be 0 or 1.');
}
const port = Number(process.env.DRASI_UI_PORT ?? 8085);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('DRASI_UI_PORT must be an unprivileged TCP port.');
}
const scratch = await mkdtemp(join(tmpdir(), 'temporal-drasi-ui-'));
const url = `http://127.0.0.1:${port}`;
const manifestPath = process.env.DRASI_FIXTURE_MANIFEST
  ? resolve(process.env.DRASI_FIXTURE_MANIFEST)
  : join(scratch, 'fixture.json');
let gateway;
let native;
let manifest;
const startupErrors = new WeakMap();

const start = (command, args, options = {}) => {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    ...options,
  });
  child.on('error', (error) => startupErrors.set(child, error));
  return child;
};
const wait = (child, label) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(new Error(`${label} exited ${child.exitCode}.`));
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${label} exited ${code ?? signal}.`)),
    );
  });
};
const run = (command, args, options) =>
  wait(start(command, args, options), command);
const ready = async (probe, child, label, timeout = 120_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (startupErrors.has(child)) throw startupErrors.get(child);
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`${label} exited before readiness.`);
    }
    if (await probe()) return;
    await delay(250);
  }
  throw new Error(`${label} did not become ready.`);
};
const stop = async (child) => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
};
const shutdownNative = async () => {
  if (!native || !manifest) return stop(native);
  try {
    const response = await fetch(`${manifest.controlURL}/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${manifest.controlToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`Native fixture stop returned ${response.status}.`);
    await Promise.race([
      wait(native, 'Native fork fixture'),
      delay(20_000).then(() => {
        throw new Error(
          'Native fixture did not stop after its control request.',
        );
      }),
    ]);
  } catch (error) {
    await stop(native);
    throw error;
  }
};

try {
  await run('node', ['scripts/verify-watch-contract.mjs']);
  if (!process.env.DRASI_FIXTURE_MANIFEST) {
    if (!process.env.DRASI_SERVER_WORKTREE) {
      throw new Error(
        'Set DRASI_FIXTURE_MANIFEST or DRASI_SERVER_WORKTREE. Stock Temporal CLI and mocks are not supported.',
      );
    }
    const cwd = resolve(process.env.DRASI_SERVER_WORKTREE);
    await run('bash', ['native/drasi/build.sh'], { cwd });
    native = start(
      'go',
      [
        'test',
        '-count=1',
        '-tags',
        'test_dep,integration,temporal_with_drasi',
        './temporal',
        '-run',
        '^TestDrasiUIFixture$',
        '-v',
        '-timeout',
        '25m',
      ],
      {
        cwd,
        env: {
          ...process.env,
          TEMPORAL_DRASI_UI_FIXTURE: manifestPath,
          TEMPORAL_DRASI_UI_POSTGRES:
            process.env.DRASI_POSTGRES_E2E === '1' ? '1' : undefined,
          TEMPORAL_DRASI_PLUGIN_CONFIG:
            process.env.DRASI_PLUGIN_CONFIG ??
            join(cwd, 'native/drasi/tests/postgres-catalog.json'),
          GOMAXPROCS: '2',
          CGO_ENABLED: '1',
          RUST_LOG: 'error',
          TEMPORAL_TEST_LOG_LEVEL: 'error',
        },
      },
    );
    await ready(
      async () => {
        try {
          await readFile(manifestPath);
          return true;
        } catch (error) {
          if (error.code === 'ENOENT') return false;
          throw error;
        }
      },
      native,
      'Native fork fixture',
      240_000,
    );
  }
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    manifest.authorizer !== 'test-only-default-allow-all' ||
    !manifest.temporalAddress ||
    !manifest.controlURL ||
    !manifest.controlToken
  ) {
    throw new Error(
      'A private test-only native fork fixture manifest is required.',
    );
  }
  await run('pnpm', ['build:server']);
  const binary = join(scratch, 'ui-server');
  await run('go', ['build', '-o', binary, './cmd/server'], {
    cwd: join(root, 'server'),
    env: { ...process.env, TMPDIR: scratch },
  });
  gateway = start(binary, ['--env', 'docker', 'start'], {
    cwd: join(root, 'server'),
    env: {
      ...process.env,
      TEMPORAL_ADDRESS: manifest.temporalAddress,
      TEMPORAL_UI_PORT: String(port),
      TEMPORAL_UI_ENABLED: 'true',
      TEMPORAL_UI_PUBLIC_PATH: '',
      TEMPORAL_AUTH_ENABLED: 'false',
      TEMPORAL_DISABLE_WRITE_ACTIONS: 'false',
      TEMPORAL_CSRF_COOKIE_INSECURE: 'true',
      TEMPORAL_CORS_ORIGINS: url,
    },
  });
  await ready(
    async () => {
      const response = await fetch(
        `${url}/api/v1/namespaces/${encodeURIComponent(manifest.namespace)}/drasi/capabilities`,
      ).catch((error) => {
        if (error.cause?.code === 'ECONNREFUSED') return undefined;
        throw error;
      });
      return response?.ok === true;
    },
    gateway,
    'Go gateway',
  );
  await run(
    'pnpm',
    [
      'exec',
      'playwright',
      'test',
      '--config',
      process.env.DRASI_POSTGRES_E2E === '1'
        ? 'playwright.drasi-postgres.config.ts'
        : 'playwright.drasi.config.ts',
      ...process.argv.slice(2),
    ],
    {
      env: {
        ...process.env,
        DRASI_UI_URL: url,
        DRASI_FIXTURE_MANIFEST: manifestPath,
      },
    },
  );
} finally {
  try {
    await stop(gateway);
  } finally {
    try {
      await shutdownNative();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
