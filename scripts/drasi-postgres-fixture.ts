import { Buffer } from 'node:buffer';

import { z } from 'zod';

import {
  ResultChange,
  Trigger,
} from '../vendor/watch-contract/typescript/drasi/watch/v1/service';

const required = z.string().min(1);
const runIdSchema = z.uuid().refine((value) => value === value.toLowerCase());
const object = z.record(z.string(), z.json());
const reference = z.strictObject({
  provider: required,
  key: required,
  version: required,
});
const component = z
  .strictObject({
    catalogId: required,
    id: required,
    version: required,
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    component: required,
    configuration: object,
    secrets: z.record(required, reference),
  })
  .refine(
    ({ configuration, secrets }) =>
      Object.keys(secrets).length > 0 &&
      Object.keys(secrets).every((key) => !(key in configuration)),
    'Separate immutable credential references are required.',
  );
const loopback = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
});
const fixtureSchema = z.object({
  namespace: required,
  taskQueue: required,
  controlURL: loopback,
  controlToken: required,
  consumerWorkflowType: required,
  signalWorkflowId: required,
  signalName: required,
  postgres: z
    .strictObject({ source: component, bootstrap: component })
    .refine(({ source, bootstrap }) => source.digest !== bootstrap.digest),
});
const row = z.strictObject({
  item_id: required,
  name: required,
  amount: z.number(),
});
const preparedSchema = z.strictObject({
  runId: runIdSchema,
  source: component,
  bootstrap: component,
  queryText: required,
  bootstrapRow: row,
  insertRow: row,
  updatedRow: row,
});
const operationSchema = z.enum(['insert', 'update', 'delete']);
const receiptSchema = z.strictObject({
  runId: runIdSchema,
  operation: operationSchema,
});

export type PostgresFixture = z.infer<typeof fixtureSchema>;
export type PreparedPostgresRun = z.infer<typeof preparedSchema>;
export type PostgresRow = z.infer<typeof row>;
export type PostgresOperation = z.infer<typeof operationSchema>;

export const decodePostgresResult = (
  value: unknown,
  completed = false,
): ResultChange => {
  try {
    const payload = z
      .object({
        metadata: z.object({ encoding: z.literal('anNvbi9wbGFpbg==') }),
        data: required,
      })
      .parse(value);
    const decoded: unknown = JSON.parse(
      Buffer.from(payload.data, 'base64').toString('utf8'),
    );
    const body: unknown = completed
      ? JSON.parse(z.string().parse(decoded))
      : decoded;
    const change = ResultChange.fromJSON(
      z.record(z.string(), z.unknown()).parse(body),
    );
    required.parse(change.actionId);
    z.string()
      .regex(/^[1-9]\d*$/)
      .parse(change.output?.queryRevision);
    required.parse(change.output?.rowIdentity);
    z.union([
      z.literal(Trigger.TRIGGER_ENTER),
      z.literal(Trigger.TRIGGER_UPDATE),
      z.literal(Trigger.TRIGGER_LEAVE),
    ]).parse(change.trigger);
    return change;
  } catch {
    throw new Error('SDK payload is not a canonical appended ResultChange.');
  }
};

export const parsePostgresFixture = (value: unknown): PostgresFixture => {
  const result = fixtureSchema.safeParse(value);
  if (!result.success) {
    throw new Error('A valid private signed PostgreSQL fixture is required.');
  }
  return result.data;
};

const samePin = (
  actual: PostgresFixture['postgres']['source'],
  expected: PostgresFixture['postgres']['source'],
) =>
  actual.catalogId === expected.catalogId &&
  actual.id === expected.id &&
  actual.version === expected.version &&
  actual.digest === expected.digest &&
  actual.component === expected.component;

export const parsePreparedPostgresRun = (
  value: unknown,
  fixture: PostgresFixture,
  runId: string,
): PreparedPostgresRun => {
  const result = preparedSchema.safeParse(value);
  if (!result.success) {
    throw new Error('PostgreSQL prepare returned an invalid private response.');
  }
  const run = result.data;
  if (
    run.runId !== runId ||
    !samePin(run.source, fixture.postgres.source) ||
    !samePin(run.bootstrap, fixture.postgres.bootstrap) ||
    !run.queryText.includes(runId) ||
    run.bootstrapRow.item_id === run.insertRow.item_id ||
    run.bootstrapRow.name !== 'bootstrap' ||
    run.bootstrapRow.amount !== 12 ||
    run.insertRow.name !== 'inserted' ||
    run.insertRow.amount !== 18 ||
    run.updatedRow.item_id !== run.bootstrapRow.item_id ||
    run.updatedRow.name !== run.bootstrapRow.name ||
    run.updatedRow.amount !== 24
  ) {
    throw new Error('PostgreSQL prepare changed its pinned run contract.');
  }
  return run;
};

export const createPostgresControls = (
  fixture: PostgresFixture,
  request: typeof fetch = fetch,
) => {
  const post = async (action: string, body: object): Promise<unknown> => {
    let response: Response;
    try {
      response = await request(
        `${fixture.controlURL.replace(/\/$/, '')}/postgres/${action}`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
          headers: {
            Authorization: `Bearer ${fixture.controlToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
    } catch {
      throw new Error(`PostgreSQL ${action} control transport failed.`);
    }
    if (!response.ok) {
      throw new Error(
        `PostgreSQL ${action} control returned HTTP ${response.status}.`,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new Error(`PostgreSQL ${action} control returned invalid JSON.`);
    }
  };
  return {
    prepare: async (runId: string) => {
      runIdSchema.parse(runId);
      return parsePreparedPostgresRun(
        await post('prepare', { runId }),
        fixture,
        runId,
      );
    },
    mutate: async (runId: string, operation: PostgresOperation) => {
      runIdSchema.parse(runId);
      operationSchema.parse(operation);
      const result = receiptSchema.safeParse(
        await post('mutate', { runId, operation }),
      );
      if (
        !result.success ||
        result.data.runId !== runId ||
        result.data.operation !== operation
      ) {
        throw new Error('PostgreSQL mutate returned an invalid receipt.');
      }
    },
  };
};
