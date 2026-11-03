import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import {
  createPostgresControls,
  decodePostgresResult,
  parsePostgresFixture,
  parsePreparedPostgresRun,
} from './drasi-postgres-fixture';
import { Trigger } from '../vendor/watch-contract/typescript/drasi/watch/v1/service';

const runId = 'c3305882-100c-40ee-b936-81fc298f770b';
const component = {
  catalogId: 'trusted',
  id: 'postgres-source',
  version: 'reviewed',
  digest: `sha256:${'a'.repeat(64)}`,
  component: 'postgres',
  configuration: { host: '127.0.0.1', slot: 'base' },
  secrets: {
    password: { provider: 'fixture', key: 'postgres', version: 'generation-1' },
  },
};
const rawFixture = {
  namespace: 'postgres-proof',
  taskQueue: 'postgres-proof',
  controlURL: 'http://127.0.0.1:32100',
  controlToken: 'test-only-control',
  consumerWorkflowType: 'Consumer',
  signalWorkflowId: 'SignalOwner',
  signalName: 'result',
  postgres: {
    source: component,
    bootstrap: {
      ...component,
      id: 'postgres-bootstrap',
      digest: `sha256:${'b'.repeat(64)}`,
      component: 'snapshot',
    },
  },
};
const fixture = parsePostgresFixture(rawFixture);
const prepared = {
  runId,
  source: {
    ...component,
    configuration: { ...component.configuration, slot: runId },
  },
  bootstrap: fixture.postgres.bootstrap,
  queryText: `MATCH (n:drasi_ui_watch_items) WHERE n.run_id = '${runId}' RETURN n.item_id AS item_id, n.name AS name, n.amount AS amount`,
  bootstrapRow: { item_id: 'seed', name: 'bootstrap', amount: 12 },
  insertRow: { item_id: 'cdc', name: 'inserted', amount: 18 },
  updatedRow: { item_id: 'seed', name: 'bootstrap', amount: 24 },
};

describe('positive PostgreSQL fixture boundary', () => {
  it('requires real pins and separate exact-version credential maps', () => {
    expect(() => parsePostgresFixture({})).toThrow('fixture is required');
    expect(() =>
      parsePostgresFixture({
        ...rawFixture,
        postgres: { source: component, bootstrap: component },
      }),
    ).toThrow('fixture is required');
    for (const source of [
      { ...component, digest: 'latest' },
      { ...component, secrets: {} },
      {
        ...component,
        secrets: { password: { provider: 'fixture', key: 'postgres' } },
      },
      {
        ...component,
        configuration: { password: 'inline' },
      },
    ]) {
      expect(() =>
        parsePostgresFixture({
          ...rawFixture,
          postgres: { ...rawFixture.postgres, source },
        }),
      ).toThrow('fixture is required');
    }
  });

  it('rejects remote, credential-bearing and redirectable control origins', () => {
    for (const controlURL of [
      'https://remote.test',
      'http://user:password@localhost',
      'http://localhost?token=private',
    ]) {
      expect(() => parsePostgresFixture({ ...rawFixture, controlURL })).toThrow(
        'fixture is required',
      );
    }
  });

  it('uses authoritative per-run connection config without allowing pin drift', () => {
    expect(
      parsePreparedPostgresRun(prepared, fixture, runId).source.configuration
        .slot,
    ).toBe(runId);
    for (const response of [
      { ...prepared, runId: '23b55794-0326-4bdb-93ef-aaf7adb55178' },
      { ...prepared, queryText: 'MATCH (n) RETURN n' },
      {
        ...prepared,
        source: { ...prepared.source, digest: `sha256:${'b'.repeat(64)}` },
      },
      { ...prepared, updatedRow: prepared.insertRow },
    ]) {
      expect(() => parsePreparedPostgresRun(response, fixture, runId)).toThrow(
        'pinned run contract',
      );
    }
  });

  it('sends only closed run-scoped operations and preserves retry identity', async () => {
    const request = vi.fn<typeof fetch>();
    request.mockResolvedValueOnce(Response.json(prepared));
    const controls = createPostgresControls(fixture, request);
    await controls.prepare(runId);
    request.mockImplementation(async () =>
      Response.json({ runId, operation: 'insert' }),
    );
    await controls.mutate(runId, 'insert');
    await controls.mutate(runId, 'insert');
    expect(request.mock.calls[0][0]).toBe(
      `${fixture.controlURL}/postgres/prepare`,
    );
    expect(request.mock.calls[1][1]?.body).toBe(request.mock.calls[2][1]?.body);
    expect(request.mock.calls[1][1]).toMatchObject({
      redirect: 'error',
      body: JSON.stringify({ runId, operation: 'insert' }),
    });
    await expect(controls.prepare(runId.toUpperCase())).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('rejects mismatched receipts and redacts control response/transport data', async () => {
    const request = vi.fn<typeof fetch>();
    const controls = createPostgresControls(fixture, request);
    request.mockResolvedValueOnce(
      Response.json({ runId, operation: 'delete' }),
    );
    await expect(controls.mutate(runId, 'insert')).rejects.toThrow(
      'invalid receipt',
    );
    request.mockResolvedValueOnce(
      new Response(fixture.controlToken, { status: 500 }),
    );
    await expect(controls.prepare(runId)).rejects.toThrow('HTTP 500');
    request.mockRejectedValueOnce(new Error(fixture.controlToken));
    await expect(controls.prepare(runId)).rejects.toThrow(
      'PostgreSQL prepare control transport failed.',
    );
    request.mockResolvedValueOnce(new Response(fixture.controlToken));
    await expect(controls.prepare(runId)).rejects.toThrow('invalid JSON');
  });

  it('decodes direct signal/start payloads and the SDK completed outer JSON string', () => {
    const change = {
      actionId: 'actual-action',
      output: { queryRevision: '9007199254740993', rowIdentity: 'actual-row' },
      trigger: 'TRIGGER_ENTER',
      after: prepared.bootstrapRow,
    };
    const payload = (value: unknown) => ({
      metadata: { encoding: Buffer.from('json/plain').toString('base64') },
      data: Buffer.from(JSON.stringify(value)).toString('base64'),
    });
    const direct = decodePostgresResult(payload(change));
    expect(direct.output?.queryRevision).toBe('9007199254740993');
    expect(direct.trigger).toBe(Trigger.TRIGGER_ENTER);
    expect(direct.after).toEqual(prepared.bootstrapRow);
    expect(direct.before).toBeUndefined();
    expect(direct.output?.diffOrdinal).toBe(0);
    expect(decodePostgresResult(payload(JSON.stringify(change)), true)).toEqual(
      direct,
    );
    for (const invalid of [
      {},
      payload({}),
      payload(JSON.stringify(change)),
      { ...payload(change), metadata: { encoding: 'json/protobuf' } },
    ]) {
      expect(() => decodePostgresResult(invalid)).toThrow('canonical appended');
    }
    expect(() => decodePostgresResult(payload(change), true)).toThrow(
      'canonical appended',
    );
  });
});
