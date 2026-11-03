import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';
import { z } from 'zod';

import {
  createPostgresControls,
  decodePostgresResult,
  parsePostgresFixture,
  type PostgresFixture,
  type PostgresRow,
} from '../../scripts/drasi-postgres-fixture';
import {
  OutputIdentity,
  ResultChange,
  Trigger,
} from '../../vendor/watch-contract/typescript/drasi/watch/v1/service';

const manifestPath = process.env.DRASI_FIXTURE_MANIFEST;
if (process.env.DRASI_POSTGRES_E2E !== '1' || !manifestPath) {
  throw new Error(
    'Explicit positive PostgreSQL mode and fixture are required.',
  );
}
const fixture = parsePostgresFixture(
  JSON.parse(readFileSync(manifestPath, 'utf8')),
);
const api = `/api/v1/namespaces/${encodeURIComponent(fixture.namespace)}/drasi`;
const ns = `/namespaces/${encodeURIComponent(fixture.namespace)}/drasi`;
const temporal = `/api/v1/namespaces/${encodeURIComponent(fixture.namespace)}/workflows`;
const resourceSchema = z.object({
  id: z.string().min(1),
  revision: z.string().regex(/^[1-9]\d*$/),
  status: z
    .object({
      state: z.string().optional(),
      observedRevision: z.string().optional(),
    })
    .optional(),
});
const executionSchema = z.object({
  workflowId: z.string().min(1),
  runId: z.uuid(),
});
const deliverySchema = z.object({
  actionId: z.string().min(1),
  watch: z.object({ id: z.string(), revision: z.string() }),
  output: z.object({
    queryRevision: z.string(),
    rowIdentity: z.string().min(1),
    incarnation: z.string().optional(),
    sequence: z.string().optional(),
    diffOrdinal: z.number().optional(),
  }),
  state: z.string(),
  execution: executionSchema.optional(),
});
const historySchema = z.object({
  history: z.object({
    events: z.array(
      z.object({
        workflowExecutionStartedEventAttributes: z
          .object({
            input: z.object({ payloads: z.array(z.unknown()).min(1) }),
          })
          .optional(),
        workflowExecutionSignaledEventAttributes: z
          .object({
            signalName: z.string(),
            input: z.object({ payloads: z.array(z.unknown()).min(1) }),
          })
          .optional(),
        workflowExecutionCompletedEventAttributes: z
          .object({
            result: z.object({ payloads: z.array(z.unknown()).min(1) }),
          })
          .optional(),
      }),
    ),
  }),
});

test('signed PostgreSQL bootstrap and CDC drive native Watches and actual SDK effects', async ({
  page,
  request,
}) => {
  const runId = crypto.randomUUID();
  const controls = createPostgresControls(fixture);
  const run = await controls.prepare(runId);
  const sourceId = `pg-source-${runId}`;
  const queryId = `pg-query-${runId}`;
  const owned: { collection: string; id: string }[] = [];
  const revisions = new Map<string, string>();
  const seen = new Set<string>();
  let queryRevision: string;
  let bodyError: unknown;
  let bodyFailed = false;

  const readyResource = async (collection: string, id: string) => {
    let revision = '';
    await expect
      .poll(async () => {
        const response = await request.get(`${api}/${collection}/${id}`);
        expect(response.ok()).toBe(true);
        const resource = resourceSchema.parse(await response.json());
        revision = resource.revision;
        return (
          resource.status?.state === 'LIFECYCLE_STATE_RUNNING' &&
          resource.status.observedRevision === revision
        );
      })
      .toBe(true);
    return revision;
  };
  const saved = async (collection: string, id: string) => {
    owned.push({ collection, id });
    await expect(
      page.getByRole('heading', { name: id, exact: true }),
    ).toBeVisible();
  };
  const install = async (
    pin: PostgresFixture['postgres']['source'],
    category: string,
  ) => {
    await page.goto('/drasi/plugins');
    await page.locator('#plugin-catalog').selectOption(pin.catalogId);
    await page.locator('#plugin-search').fill(pin.id);
    const searched = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/drasi/plugins' &&
        new URL(response.url()).searchParams.get('catalogId') === pin.catalogId,
    );
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    expect((await searched).ok()).toBe(true);
    const card = page
      .getByRole('region', { name: 'Plugins', exact: true })
      .locator('article')
      .filter({
        has: page.getByRole('heading', {
          name: `${pin.id} ${pin.version}`,
          exact: true,
        }),
      });
    await expect(card.getByText(pin.digest, { exact: true })).toBeVisible();
    await card
      .getByRole('button', { name: 'Verify and install', exact: true })
      .click();
    const installation = page
      .getByRole('region', { name: 'Installations', exact: true })
      .locator('article')
      .filter({ hasText: pin.digest });
    await expect(installation).toBeVisible();
    await installation
      .getByRole('button', { name: 'Request host loading', exact: true })
      .click();
    await expect
      .poll(async () => {
        const response = await request.get(
          `/api/v1/drasi/plugins/installations/${encodeURIComponent(pin.digest)}`,
        );
        expect(response.ok()).toBe(true);
        const observed = z
          .object({
            plugin: z.object({ digest: z.literal(pin.digest) }),
            hosts: z
              .array(
                z.object({
                  state: z.string(),
                  verifiedSignerIdentity: z.string().optional(),
                }),
              )
              .optional(),
          })
          .parse(await response.json());
        return (
          Boolean(observed.hosts?.length) &&
          observed.hosts?.every(
            (host) =>
              host.state === 'PLUGIN_HOST_STATE_LOADED' &&
              Boolean(host.verifiedSignerIdentity),
          )
        );
      })
      .toBe(true);
    const details = await request.get(
      `/api/v1/drasi/plugins/catalogs/${encodeURIComponent(pin.catalogId)}/plugins/${encodeURIComponent(pin.id)}/versions/${encodeURIComponent(pin.version)}`,
    );
    expect(details.ok()).toBe(true);
    const plugin = z
      .object({
        digest: z.literal(pin.digest),
        compatible: z.literal(true),
        descriptors: z
          .array(
            z.object({
              component: z.string(),
              category: z.string(),
              supported: z.boolean(),
              configurationSchema: z.record(z.string(), z.unknown()),
            }),
          )
          .min(1),
      })
      .parse(await details.json());
    expect(
      plugin.descriptors.some(
        (descriptor) =>
          descriptor.component === pin.component &&
          descriptor.category === category &&
          descriptor.supported,
      ),
    ).toBe(true);
  };
  const createWatch = async (
    id: string,
    trigger: Trigger,
    owner?: z.infer<typeof executionSchema>,
  ) => {
    await page.goto(`${ns}/watches`);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.locator('#watch-id').fill(id);
    await page.locator('#watch-query').selectOption(queryId);
    await page.locator('#watch-trigger').selectOption(String(trigger));
    if (trigger === Trigger.TRIGGER_ENTER) {
      await page.locator('#watch-include-existing').press('Space');
    }
    if (owner) {
      await page.locator('#watch-action').selectOption('signal');
      await page.locator('#watch-workflow-id').fill(owner.workflowId);
      await page.locator('#watch-run-id').fill(owner.runId);
      await page.locator('#watch-signal-name').fill(fixture.signalName);
    } else {
      await page.locator('#watch-workflow-id').fill(`${id}-{action_id}`);
      await page
        .locator('#watch-workflow-type')
        .fill(fixture.consumerWorkflowType);
      await page.locator('#watch-task-queue').fill(fixture.taskQueue);
    }
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await saved('watches', id);
    revisions.set(id, await readyResource('watches', id));
  };
  const effect = async (
    id: string,
    trigger: Trigger,
    before: PostgresRow | undefined,
    after: PostgresRow | undefined,
    owner?: z.infer<typeof executionSchema>,
  ) => {
    await expect
      .poll(async () => {
        const response = await request.get(`${api}/watches/${id}/deliveries`, {
          params: { pageSize: '200' },
        });
        expect(response.ok()).toBe(true);
        const deliveries =
          z
            .object({
              deliveries: z.array(deliverySchema).optional(),
            })
            .parse(await response.json()).deliveries ?? [];
        for (const delivery of deliveries) {
          expect([
            'DELIVERY_STATE_BLOCKED',
            'DELIVERY_STATE_AMBIGUOUS',
          ]).not.toContain(delivery.state);
          if (
            delivery.state !== 'DELIVERY_STATE_DELIVERED' ||
            seen.has(delivery.actionId)
          )
            continue;
          const execution = executionSchema.parse(delivery.execution);
          expect(delivery.watch).toEqual({ id, revision: revisions.get(id) });
          expect(delivery.output.queryRevision).toBe(queryRevision);
          expect(execution.workflowId).toBe(
            owner?.workflowId ?? `${id}-${delivery.actionId}`,
          );
          if (owner) expect(execution.runId).toBe(owner.runId);
          const describe = await request.get(
            `${temporal}/${encodeURIComponent(execution.workflowId)}`,
            {
              params: { 'execution.runId': execution.runId },
            },
          );
          expect(describe.ok()).toBe(true);
          const status = z
            .object({
              workflowExecutionInfo: z.object({
                status: z.string(),
                execution: executionSchema,
              }),
            })
            .parse(await describe.json()).workflowExecutionInfo;
          expect(status.execution).toEqual(execution);
          if (status.status !== 'WORKFLOW_EXECUTION_STATUS_COMPLETED')
            return false;
          const history = await request.get(
            `${temporal}/${encodeURIComponent(execution.workflowId)}/history`,
            {
              params: { 'execution.runId': execution.runId },
            },
          );
          expect(history.ok()).toBe(true);
          const events = historySchema.parse(await history.json()).history
            .events;
          const input = owner
            ? events.find(
                (event) =>
                  event.workflowExecutionSignaledEventAttributes?.signalName ===
                  fixture.signalName,
              )?.workflowExecutionSignaledEventAttributes?.input
            : events.find(
                (event) => event.workflowExecutionStartedEventAttributes,
              )?.workflowExecutionStartedEventAttributes?.input;
          const change = decodePostgresResult(input?.payloads.at(-1));
          expect(change.actionId).toBe(delivery.actionId);
          expect(change.output).toEqual(
            OutputIdentity.fromJSON(delivery.output),
          );
          expect(change.trigger).toBe(trigger);
          expect(change.before).toEqual(before);
          expect(change.after).toEqual(after);
          const completed = events.find(
            (event) => event.workflowExecutionCompletedEventAttributes,
          )?.workflowExecutionCompletedEventAttributes?.result;
          expect(
            ResultChange.toJSON(
              decodePostgresResult(completed?.payloads.at(-1), true),
            ),
          ).toEqual(ResultChange.toJSON(change));
          seen.add(delivery.actionId);
          return true;
        }
        return false;
      })
      .toBe(true);
  };

  try {
    await install(run.source, 'PLUGIN_CATEGORY_SOURCE');
    await install(run.bootstrap, 'PLUGIN_CATEGORY_BOOTSTRAP');
    await expect
      .poll(async () => {
        const response = await request.get(`${api}/capabilities`);
        expect(response.ok()).toBe(true);
        const capabilities = z
          .object({
            apiVersion: z.literal('v1'),
            enabled: z.literal(true),
            externalSources: z.boolean().optional(),
            queryLanguages: z
              .array(z.string())
              .refine((languages) => languages.includes('cypher')),
          })
          .parse(await response.json());
        return capabilities.externalSources === true;
      })
      .toBe(true);

    await page.goto(`${ns}/sources`);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.locator('#source-id').fill(sourceId);
    await page.locator('#source-type').selectOption('external');
    await page
      .locator('#source-component')
      .selectOption(`${run.source.digest}/${run.source.component}`);
    await page
      .locator('#source-configuration')
      .fill(JSON.stringify(run.source.configuration));
    await page
      .locator('#source-secrets')
      .fill(JSON.stringify(run.source.secrets));
    await page
      .locator('#bootstrap-component')
      .selectOption(`${run.bootstrap.digest}/${run.bootstrap.component}`);
    await page
      .locator('#bootstrap-configuration')
      .fill(JSON.stringify(run.bootstrap.configuration));
    await page
      .locator('#bootstrap-secrets')
      .fill(JSON.stringify(run.bootstrap.secrets));
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await saved('sources', sourceId);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    const sourceRevision = await readyResource('sources', sourceId);
    const savedSource = await request.get(`${api}/sources/${sourceId}`);
    expect(savedSource.ok()).toBe(true);
    const sourceSpec = z
      .object({
        spec: z.object({
          external: z.object({
            plugin: z.object({ digest: z.string(), component: z.string() }),
            configuration: z.record(z.string(), z.json()),
            secrets: z.record(z.string(), z.unknown()),
          }),
          bootstrap: z.object({
            plugin: z.object({ digest: z.string(), component: z.string() }),
            configuration: z.record(z.string(), z.json()),
            secrets: z.record(z.string(), z.unknown()),
          }),
        }),
      })
      .parse(await savedSource.json()).spec;
    for (const [actual, expected] of [
      [sourceSpec.external, run.source],
      [sourceSpec.bootstrap, run.bootstrap],
    ] as const) {
      expect(actual).toEqual({
        plugin: { digest: expected.digest, component: expected.component },
        configuration: expected.configuration,
        secrets: expected.secrets,
      });
    }

    await page.goto(`${ns}/queries`);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.locator('#query-id').fill(queryId);
    await page.locator('#query-text').fill(run.queryText);
    await page.locator('#query-language').selectOption('cypher');
    await page.locator(`#query-source-${sourceId}`).press('Space');
    await expect(page.locator('#query-source-revision-0')).toHaveValue(
      sourceRevision,
    );
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await saved('queries', queryId);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    queryRevision = await readyResource('queries', queryId);

    const enter = `pg-enter-${runId}`;
    const update = `pg-update-${runId}`;
    const leave = `pg-leave-${runId}`;
    const signal = `pg-signal-${runId}`;
    await createWatch(enter, Trigger.TRIGGER_ENTER);
    await effect(enter, Trigger.TRIGGER_ENTER, undefined, run.bootstrapRow);
    await createWatch(update, Trigger.TRIGGER_UPDATE);
    await createWatch(leave, Trigger.TRIGGER_LEAVE);

    const describedOwner = await request.get(
      `${temporal}/${encodeURIComponent(fixture.signalWorkflowId)}`,
    );
    expect(describedOwner.ok()).toBe(true);
    const type = z
      .object({
        workflowExecutionInfo: z.object({
          type: z.object({ name: z.string().min(1) }),
        }),
      })
      .parse(await describedOwner.json()).workflowExecutionInfo.type;
    const csrf = z
      .string()
      .min(1)
      .parse(
        (await page.context().cookies()).find(
          (cookie) => cookie.name === '_csrf',
        )?.value,
      );
    const startOwner = await page
      .context()
      .request.post(`${temporal}/pg-owner-${runId}`, {
        headers: { 'X-CSRF-Token': csrf },
        data: {
          namespace: fixture.namespace,
          workflowId: `pg-owner-${runId}`,
          workflowType: type,
          taskQueue: { name: fixture.taskQueue },
          requestId: crypto.randomUUID(),
        },
      });
    expect(startOwner.ok()).toBe(true);
    const owner = {
      workflowId: `pg-owner-${runId}`,
      runId: z.object({ runId: z.uuid() }).parse(await startOwner.json()).runId,
    };
    await createWatch(signal, Trigger.TRIGGER_UPDATE, owner);
    await controls.mutate(runId, 'insert');
    await effect(enter, Trigger.TRIGGER_ENTER, undefined, run.insertRow);
    await controls.mutate(runId, 'update');
    await effect(
      update,
      Trigger.TRIGGER_UPDATE,
      run.bootstrapRow,
      run.updatedRow,
    );
    await effect(
      signal,
      Trigger.TRIGGER_UPDATE,
      run.bootstrapRow,
      run.updatedRow,
      owner,
    );
    await controls.mutate(runId, 'delete');
    await effect(leave, Trigger.TRIGGER_LEAVE, run.insertRow, undefined);
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
  }
  const errors: Error[] = [];
  for (const { collection, id } of owned.reverse()) {
    try {
      const response = await request.get(`${api}/${collection}/${id}`);
      if (response.status() === 404) continue;
      expect(response.ok()).toBe(true);
      const resource = resourceSchema.parse(await response.json());
      const csrf = z
        .string()
        .min(1)
        .parse(
          (await page.context().cookies()).find(
            (cookie) => cookie.name === '_csrf',
          )?.value,
        );
      const deleted = await page
        .context()
        .request.delete(`${api}/${collection}/${id}`, {
          headers: { 'X-CSRF-Token': csrf },
          params: {
            expectedRevision: resource.revision,
            requestId: crypto.randomUUID(),
          },
        });
      expect(deleted.ok()).toBe(true);
    } catch {
      errors.push(
        new Error(`Failed to delete owned PostgreSQL ${collection}/${id}.`),
      );
    }
  }
  if (errors.length) {
    throw new AggregateError(
      bodyFailed ? [bodyError, ...errors] : errors,
      'PostgreSQL resource cleanup failed.',
    );
  }
  if (bodyFailed) throw bodyError;
});
