import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

import { expect, test } from '@playwright/test';
import { z } from 'zod';

const manifestSchema = z.object({
  namespace: z.string().min(1),
  taskQueue: z.string().min(1),
  temporalAddress: z.string().min(1),
  queryText: z.string().min(1),
  consumerWorkflowType: z.string().min(1),
  signalWorkflowId: z.string().min(1),
  signalName: z.string().min(1),
  controlURL: z.url(),
  controlToken: z.string().min(1),
  externalSourcesVerified: z.boolean(),
});
const path = process.env.DRASI_FIXTURE_MANIFEST;
if (!path) throw new Error('A real server fork fixture manifest is required.');
const fixture = manifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
const api = `/api/v1/namespaces/${encodeURIComponent(fixture.namespace)}/drasi`;
const ns = `/namespaces/${encodeURIComponent(fixture.namespace)}/drasi`;
const resourceSchema = z.object({
  id: z.string(),
  revision: z.string(),
  status: z.object({ state: z.string().optional() }).optional(),
});

test('native Sources, Queries, recurring and once Watches use the real Go gateway and SDK worker', async ({
  page,
  request,
}) => {
  const suffix = Date.now().toString(36);
  const sourceId = `ui-source-${suffix}`;
  const queryId = `ui-query-${suffix}`;
  const watchId = `ui-watch-${suffix}`;
  const producerId = `ui-producer-${suffix}`;
  const alias = /\bMATCH\s*\((\w+):Workflow\)/i.exec(fixture.queryText)?.[1];
  const returnAt = fixture.queryText.search(/\bRETURN\b/i);
  if (!alias || returnAt < 0)
    throw new Error(
      'Fixture query must expose a Workflow alias and RETURN clause.',
    );
  const queryText = `${fixture.queryText.slice(0, returnAt)} AND ${alias}.workflow_id = '${producerId}' ${fixture.queryText.slice(returnAt)}`;
  const capabilityResponse = await request.get(`${api}/capabilities`);
  expect(capabilityResponse.ok()).toBe(true);
  const capabilities = z
    .object({
      apiVersion: z.literal('v1'),
      enabled: z.literal(true),
      temporalSource: z.literal(true),
      allowedMethods: z.array(z.string()),
      externalSources: z.boolean().optional(),
    })
    .parse(await capabilityResponse.json());
  expect(capabilities.allowedMethods).toContain(
    '/drasi.watch.v1.WatchService/CreateWatch',
  );

  await page.goto(`${ns}/sources`);
  await expect(
    page.getByRole('heading', { name: 'Sources', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.locator('#source-id').fill(sourceId);
  await expect(
    page.getByText('No plugin installation is required.', { exact: false }),
  ).toBeVisible();
  await expect(
    page.locator('#source-type option[value=external]'),
  ).toHaveJSProperty('disabled', capabilities.externalSources !== true);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: sourceId, exact: true }),
  ).toBeVisible();
  console.info('Created builtin source through native form.');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect
    .poll(async () => {
      const response = await request.get(`${api}/sources/${sourceId}`);
      return resourceSchema.parse(await response.json()).status?.state;
    })
    .toBe('LIFECYCLE_STATE_RUNNING');
  console.info('Observed builtin source running.');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByText('RUNNING', { exact: true }).first(),
  ).toBeVisible();
  console.info('Source detail shows observed runtime state.');

  await page.goto(`${ns}/queries`);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.locator('#query-id').fill(queryId);
  await page.locator('#query-text').fill(queryText);
  await page.locator(`#query-source-${sourceId}`).press('Space');
  await expect(
    page.getByRole('checkbox', {
      name: new RegExp(`^${sourceId} \\(Revision `),
    }),
  ).toBeChecked();
  console.info('Configured native query with pinned source revision.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: queryId, exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect
    .poll(async () => {
      const response = await request.get(`${api}/queries/${queryId}`);
      return resourceSchema.parse(await response.json()).status?.state;
    })
    .toBe('LIFECYCLE_STATE_RUNNING');
  console.info('Observed query running.');

  await page.goto(`${ns}/watches`);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.locator('#watch-id').fill(watchId);
  await page.locator('#watch-query').selectOption(queryId);
  await expect(
    page.getByRole('checkbox', {
      name: 'Include existing matches',
      exact: true,
    }),
  ).not.toBeChecked();
  await page
    .locator('#watch-workflow-id')
    .fill(`ui-result-${suffix}-{action_id}`);
  await page.locator('#watch-workflow-type').fill(fixture.consumerWorkflowType);
  await page.locator('#watch-task-queue').fill(fixture.taskQueue);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: watchId, exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const response = await request.get(`${api}/watches/${watchId}`);
      return resourceSchema.parse(await response.json()).status?.state;
    })
    .toBe('LIFECYCLE_STATE_RUNNING');
  console.info('Observed recurring watch running before producer execution.');

  const produce = await request.post(`${fixture.controlURL}/produce`, {
    headers: { Authorization: `Bearer ${fixture.controlToken}` },
    data: { workflowId: producerId },
  });
  expect(produce.ok()).toBe(true);
  await expect
    .poll(async () => {
      const response = await request.get(
        `${api}/watches/${watchId}/deliveries`,
      );
      const body = z
        .object({
          deliveries: z
            .array(
              z.object({
                state: z.string(),
                execution: z
                  .object({ workflowId: z.string(), runId: z.string() })
                  .optional(),
              }),
            )
            .optional(),
        })
        .parse(await response.json());
      return (
        body.deliveries?.filter(
          (item) =>
            item.state === 'DELIVERY_STATE_DELIVERED' && item.execution?.runId,
        ).length ?? 0
      );
    })
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByText('DELIVERED', { exact: false }).first(),
  ).toBeVisible();
  const execution = page.getByRole('link', { name: /^Execution:/ }).first();
  await expect(execution).toBeVisible();
  await execution.scrollIntoViewIfNeeded();
  await mkdir('audits', { recursive: true });
  await page.screenshot({ path: 'audits/drasi-real-watch-delivery.png' });
  await execution.click();
  await expect(page).toHaveURL(/\/workflows\/ui-result-/);
  await expect(
    page.getByText('Completed', { exact: true }).first(),
  ).toBeVisible();

  const describe = await request.get(
    `/api/v1/namespaces/${encodeURIComponent(fixture.namespace)}/workflows/${encodeURIComponent(fixture.signalWorkflowId)}`,
  );
  expect(describe.ok()).toBe(true);
  const ownerInfo = z
    .object({
      workflowExecutionInfo: z.object({
        execution: z.object({ workflowId: z.string(), runId: z.string() }),
        type: z.object({ name: z.string() }),
      }),
    })
    .parse(await describe.json()).workflowExecutionInfo;
  const ownerWorkflowId = `ui-once-owner-${suffix}`;
  const csrf = z
    .string()
    .min(1)
    .parse(
      (await page.context().cookies()).find((cookie) => cookie.name === '_csrf')
        ?.value,
    );
  const startOwner = await page
    .context()
    .request.post(
      `/api/v1/namespaces/${encodeURIComponent(fixture.namespace)}/workflows/${ownerWorkflowId}`,
      {
        headers: { 'X-CSRF-Token': csrf },
        data: {
          namespace: fixture.namespace,
          workflowId: ownerWorkflowId,
          workflowType: ownerInfo.type,
          taskQueue: { name: fixture.taskQueue },
          requestId: crypto.randomUUID(),
        },
      },
    );
  expect(startOwner.ok()).toBe(true);
  const owner = {
    workflowId: ownerWorkflowId,
    runId: z.object({ runId: z.string() }).parse(await startOwner.json()).runId,
  };
  const onceId = `ui-once-${suffix}`;
  await page.goto(`${ns}/watches`);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.locator('#watch-id').fill(onceId);
  await page.locator('#watch-query').selectOption(queryId);
  await page.locator('#watch-lifetime').selectOption('once');
  await page.locator('#watch-owner-workflow').fill(owner.workflowId);
  await page.locator('#watch-owner-run').fill(owner.runId);
  await page
    .locator('#watch-deadline')
    .fill(new Date(Date.now() + 300_000).toISOString().slice(0, 16));
  await page.locator('#watch-signal-name').fill(fixture.signalName);
  await expect(page.locator('#watch-action')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: onceId, exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const response = await request.get(`${api}/watches/${onceId}`);
      return resourceSchema.parse(await response.json()).status?.state;
    })
    .toBe('LIFECYCLE_STATE_COMPLETED');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByRole('link', {
      name: `Execution: ${owner.workflowId} / ${owner.runId}`,
      exact: true,
    }),
  ).toBeVisible();
  const history = await request.get(
    `/api/v1/namespaces/${encodeURIComponent(fixture.namespace)}/workflows/${encodeURIComponent(owner.workflowId)}/history`,
    { params: { 'execution.runId': owner.runId } },
  );
  expect(history.ok()).toBe(true);
  const events = z
    .object({
      history: z.object({
        events: z.array(
          z.object({
            workflowExecutionSignaledEventAttributes: z
              .object({ signalName: z.string() })
              .optional(),
          }),
        ),
      }),
    })
    .parse(await history.json()).history.events;
  expect(
    events.some(
      (event) =>
        event.workflowExecutionSignaledEventAttributes?.signalName ===
        fixture.signalName,
    ),
  ).toBe(true);
  const swsId = `ui-signal-start-${suffix}`;
  const swsWorkflow = `ui-signal-start-target-${suffix}`;
  await page.goto(`${ns}/watches`);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.locator('#watch-id').fill(swsId);
  await page.locator('#watch-query').selectOption(queryId);
  await page.locator('#watch-action').selectOption('signalWithStart');
  await page.locator('#watch-include-existing').press('Space');
  await expect(
    page.getByRole('checkbox', {
      name: 'Include existing matches',
      exact: true,
    }),
  ).toBeChecked();
  await page.locator('#watch-workflow-id').fill(swsWorkflow);
  await page.locator('#watch-workflow-type').fill(ownerInfo.type.name);
  await page.locator('#watch-task-queue').fill(fixture.taskQueue);
  await page.locator('#watch-signal-name').fill(fixture.signalName);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: swsId, exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const response = await request.get(`${api}/watches/${swsId}/deliveries`);
      const deliveries =
        z
          .object({
            deliveries: z
              .array(
                z.object({
                  state: z.string(),
                  execution: z
                    .object({ workflowId: z.string(), runId: z.string() })
                    .optional(),
                }),
              )
              .optional(),
          })
          .parse(await response.json()).deliveries ?? [];
      return deliveries.some(
        (delivery) =>
          delivery.state === 'DELIVERY_STATE_DELIVERED' &&
          delivery.execution?.workflowId === swsWorkflow &&
          Boolean(delivery.execution.runId),
      );
    })
    .toBe(true);
  await expect
    .poll(async () => {
      const response = await request.get(
        `/api/v1/namespaces/${encodeURIComponent(fixture.namespace)}/workflows/${encodeURIComponent(swsWorkflow)}`,
      );
      return z
        .object({ workflowExecutionInfo: z.object({ status: z.string() }) })
        .parse(await response.json()).workflowExecutionInfo.status;
    })
    .toBe('WORKFLOW_EXECUTION_STATUS_COMPLETED');
});

test('trusted catalog discovery reports actual compatibility or host refusal without false success', async ({
  page,
  request,
}) => {
  const pluginWrites: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === 'POST' &&
      path.startsWith('/api/v1/drasi/plugins/installations')
    ) {
      pluginWrites.push(path);
    }
  });
  const response = await request.get('/api/v1/drasi/plugins/capabilities');
  expect(response.ok()).toBe(true);
  const catalogResponse = await request.get('/api/v1/drasi/plugins/catalogs');
  expect(catalogResponse.ok()).toBe(true);
  const catalogs = z
    .object({
      catalogs: z
        .array(z.object({ id: z.string(), displayName: z.string() }))
        .min(1),
    })
    .parse(await catalogResponse.json()).catalogs;
  await page.goto('/drasi/plugins');
  await expect(
    page.getByRole('heading', { name: 'Plugins', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Only administrator-configured OCI or local catalogs', {
      exact: false,
    }),
  ).toBeVisible();
  await page.locator('#plugin-catalog').selectOption(catalogs[0].id);
  const discoveryResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/drasi/plugins' &&
      new URL(response.url()).searchParams.get('catalogId') === catalogs[0].id,
  );
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const discovery = await discoveryResponse;
  expect(discovery.ok()).toBe(true);
  const pluginSchema = z.object({
    id: z.string(),
    version: z.string(),
    digest: z.string(),
    compatible: z.boolean().default(false),
    message: z.string().optional(),
    descriptors: z.array(z.object({ category: z.string() })).optional(),
  });
  const plugins = z
    .object({ plugins: z.array(pluginSchema).min(1) })
    .parse(await discovery.json()).plugins;
  const plugin = pluginSchema.parse(
    plugins.find((plugin) => plugin.id.endsWith('-source')),
  );
  const card = page
    .getByRole('region', { name: 'Plugins', exact: true })
    .locator('article')
    .filter({
      has: page.getByRole('heading', {
        name: `${plugin.id} ${plugin.version}`,
        exact: true,
      }),
    });
  await expect(card.getByText(plugin.digest, { exact: true })).toBeVisible();
  const detailsResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname.includes('/versions/'),
  );
  await card.getByRole('button', { name: 'Details', exact: true }).click();
  const details = await detailsResponse;
  expect(details.ok()).toBe(true);
  const current = pluginSchema.parse(await details.json());
  expect(current.digest).toBe(plugin.digest);
  expect(current.compatible).toBe(plugin.compatible);
  let refusal = card.getByText('Incompatible', { exact: true });
  if (!current.compatible) {
    const message = z.string().min(1).parse(current.message);
    await expect(refusal).toBeVisible();
    await expect(card.getByText(message, { exact: true })).toBeVisible();
    await expect(
      card.getByRole('button', { name: 'Verify and install', exact: true }),
    ).toBeDisabled();
    expect(current.descriptors ?? []).toHaveLength(0);
    await expect(card.getByText('LOADED', { exact: true })).toHaveCount(0);
    expect(pluginWrites).toEqual([]);
  } else {
    await expect(card.getByText('Compatible', { exact: true })).toBeVisible();
    const installResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          '/api/v1/drasi/plugins/installations' &&
        response.request().method() === 'POST',
    );
    await card
      .getByRole('button', { name: 'Verify and install', exact: true })
      .click();
    expect((await installResponse).ok()).toBe(true);
    const installation = page
      .getByRole('region', { name: 'Installations', exact: true })
      .locator('article')
      .filter({ hasText: plugin.digest });
    await expect(installation).toBeVisible();
    const loadResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/load') &&
        response.request().method() === 'POST',
    );
    await installation
      .getByRole('button', { name: 'Request host loading', exact: true })
      .click();
    expect((await loadResponse).ok()).toBe(true);
    const observationSchema = z.object({
      hosts: z
        .array(
          z.object({
            state: z.string().optional(),
            message: z.string().optional(),
          }),
        )
        .optional(),
    });
    await expect
      .poll(async () => {
        const response = await request.get(
          `/api/v1/drasi/plugins/installations/${encodeURIComponent(plugin.digest)}`,
        );
        expect(response.ok()).toBe(true);
        const observation = observationSchema.parse(await response.json());
        return (
          observation.hosts?.some(
            (host) =>
              [
                'PLUGIN_HOST_STATE_FAILED',
                'PLUGIN_HOST_STATE_INCOMPATIBLE',
              ].includes(host.state ?? '') && Boolean(host.message),
          ) ?? false
        );
      })
      .toBe(true);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    refusal = installation.getByText(/^(FAILED|INCOMPATIBLE)$/).first();
    await expect(refusal).toBeVisible();
    await expect(installation.getByText('LOADED', { exact: true })).toHaveCount(
      0,
    );
  }
  await expect(
    page.getByRole('heading', { name: 'Installations', exact: true }),
  ).toBeVisible();
  await expect(page.locator('input[type=file]')).toHaveCount(0);
  await expect(
    page.getByText('Replacement requires a host restart', { exact: false }),
  ).toBeVisible();
  const capabilityResponse = await request.get(`${api}/capabilities`);
  expect(capabilityResponse.ok()).toBe(true);
  const capabilities = z
    .object({ externalSources: z.boolean().optional() })
    .parse(await capabilityResponse.json());
  expect(capabilities.externalSources ?? false).toBe(
    fixture.externalSourcesVerified,
  );
  expect(capabilities.externalSources ?? false).toBe(false);
  await mkdir('audits', { recursive: true });
  await refusal.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: 'audits/drasi-real-plugin-refusal.png',
  });
});
