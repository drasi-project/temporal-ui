import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const expected =
  '5b427db4c7d216a8a5603378a26f94d1fe816e6b4659c04015649200c50dfa9d';
const archive = new URL('../vendor/watch-contract.tgz', import.meta.url);
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
if (digest !== expected) {
  throw new Error(`Watch contract checksum mismatch: ${digest}`);
}
const archivePath = fileURLToPath(archive);
const extracted = fileURLToPath(
  new URL('../vendor/watch-contract/', import.meta.url),
);
const files = new Set(
  execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((name) => !name.endsWith('/'))
    .map((name) => {
      if (!name.startsWith('package/') || name.split('/').includes('..')) {
        throw new Error(`Unexpected contract archive path: ${name}`);
      }
      return name.slice('package/'.length);
    }),
);
for (const name of files) {
  const path = join(extracted, name);
  if (!lstatSync(path).isFile())
    throw new Error(`Contract is not a regular file: ${name}`);
  const packaged = execFileSync(
    'tar',
    ['-xOzf', archivePath, `package/${name}`],
    { maxBuffer: 8 << 20 },
  );
  if (!packaged.equals(readFileSync(path)))
    throw new Error(`Extracted contract drift: ${name}`);
}
const visit = (directory, prefix = '') => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) visit(join(directory, entry.name), `${name}/`);
    else if (!entry.isFile() || !files.has(name))
      throw new Error(`Unpackaged contract entry: ${name}`);
  }
};
visit(extracted);
console.log(
  `Watch development contract archive and ${files.size} extracted files verified: ${digest}`,
);
