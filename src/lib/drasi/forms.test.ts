import {
  InitialResults,
  ResultPayload,
  Trigger,
  WatchSpec,
} from '@drasi-project/temporal-watch-contracts/v1';
import { describe, expect, it } from 'vitest';

import { parseConfiguration, secretReferencesSchema } from './configuration';
import { buildWatchSpec, emptyWatchDraft } from './forms';

const draft = () => ({
  ...emptyWatchDraft(),
  queryId: 'matching-workflows',
  queryRevision: '9007199254740993',
  workflowId: 'action-{action_id}',
  workflowType: 'ProcessResult',
  taskQueue: 'result-workers',
});

describe('watch behavioral contract', () => {
  it('ignores existing rows for recurring watches and appends the result payload', () => {
    const spec = buildWatchSpec(draft());
    expect(spec.initialResults).toBe(InitialResults.INITIAL_RESULTS_IGNORE);
    expect(spec.lifetime?.$case).toBe('persistent');
    expect(spec.action?.resultPayload).toBe(
      ResultPayload.RESULT_PAYLOAD_APPEND,
    );
    expect(spec.query?.revision).toBe('9007199254740993');
  });

  it.each(['start', 'signal', 'signalWithStart'] as const)(
    'builds the %s action and gateway wire union',
    (operation) => {
      const spec = buildWatchSpec({
        ...draft(),
        operation,
        signalName: 'result',
        input: '[{"key":"value"}]',
      });
      expect(spec.action?.operation?.$case).toBe(operation);
      const wire = WatchSpec.toJSON(spec);
      expect(JSON.stringify(wire)).not.toContain('$case');
      const restored = WatchSpec.fromJSON(wire);
      expect(restored.action?.operation?.$case).toBe(operation);
      expect(restored.query?.revision).toBe('9007199254740993');
      expect(JSON.stringify(wire)).toContain('anNvbi9wbGFpbg==');
      expect(JSON.stringify(wire)).toContain('eyJrZXkiOiJ2YWx1ZSJ9');
    },
  );

  it('pins one-shot ENTER delivery to the exact owner run', () => {
    const spec = buildWatchSpec({
      ...draft(),
      once: true,
      trigger: Trigger.TRIGGER_LEAVE,
      operation: 'start',
      ownerWorkflowId: 'owner',
      ownerRunId: '4c644425-13b7-41fa-8519-b0a11f2916cb',
      deadline: new Date(Date.now() + 60_000).toISOString(),
      signalName: 'condition',
    });
    expect(spec.trigger).toBe(Trigger.TRIGGER_ENTER);
    expect(spec.lifetime?.$case).toBe('once');
    expect(spec.action?.operation).toMatchObject({
      $case: 'signal',
      value: {
        target: {
          $case: 'run',
          value: {
            workflowId: 'owner',
            runId: '4c644425-13b7-41fa-8519-b0a11f2916cb',
          },
        },
      },
    });
  });

  it('rejects expired deadlines, missing owners and non-array input', () => {
    expect(() =>
      buildWatchSpec({
        ...draft(),
        once: true,
        deadline: '2000-01-01',
        signalName: 'condition',
      }),
    ).toThrow();
    expect(() => buildWatchSpec({ ...draft(), input: '{}' })).toThrow();
  });

  it('requires immutable secret versions without accepting secret values', () => {
    expect(
      secretReferencesSchema.safeParse({
        password: { provider: 'vault', key: 'db/password' },
      }).success,
    ).toBe(false);
    expect(
      secretReferencesSchema.safeParse({
        password: {
          provider: 'vault',
          key: 'db/password',
          version: 'v3',
          value: 'not-allowed',
        },
      }).success,
    ).toBe(false);
    expect(
      secretReferencesSchema.parse({
        password: { provider: 'vault', key: 'db/password', version: 'v3' },
      }),
    ).toEqual({
      password: { provider: 'vault', key: 'db/password', version: 'v3' },
    });
  });

  it('rejects recursive SDK references but permits embedded literal text', () => {
    expect(() =>
      parseConfiguration('{"nested":[{"kind":"Secret","name":"password"}]}'),
    ).toThrow('SDK configuration');
    expect(() => parseConfiguration('{"nested":"${DB_PASSWORD}"}')).toThrow(
      'immutable secret',
    );
    expect(
      parseConfiguration('{"literal":"prefix ${not-an-interpolation} suffix"}'),
    ).toEqual({ literal: 'prefix ${not-an-interpolation} suffix' });
  });
});
