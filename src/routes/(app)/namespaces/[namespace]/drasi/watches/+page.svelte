<script lang="ts">
  import {
    type Delivery,
    DeliveryState,
    InitialResults,
    type Query,
    Watch,
    type WatchSpec,
  } from '@drasi-project/temporal-watch-contracts/v1';

  import { page } from '$app/state';

  import ResourceList from '$lib/components/drasi/resource-list.svelte';
  import ResourceStatus from '$lib/components/drasi/resource-status.svelte';
  import WatchForm from '$lib/components/drasi/watch-form.svelte';
  import PageTitle from '$lib/components/page-title.svelte';
  import { resourceIdSchema } from '$lib/drasi/forms';
  import Alert from '$lib/holocene/alert.svelte';
  import Checkbox from '$lib/holocene/checkbox.svelte';
  import Link from '$lib/holocene/link.svelte';
  import { translate as t } from '$lib/i18n/translate';
  import { Button } from '$lib/io/button';
  import {
    createDrasiClient,
    errorMessage,
    methodAllowed,
  } from '$lib/services/drasi-service';
  import { coreUserStore } from '$lib/stores/core-user';
  import { routeForWorkflow } from '$lib/utilities/route-for';

  const coreUser = coreUserStore();
  const namespace = $derived(page.params.namespace);
  const capabilities = $derived(page.data.drasiCapabilities);
  const client = $derived(
    createDrasiClient(namespace, fetch, capabilities.maxRequestBytes),
  );
  const writeDisabled = $derived(
    page.data.settings.disableWriteActions ||
      $coreUser.namespaceWriteDisabled(namespace),
  );
  const allowed = (method: string) =>
    methodAllowed(capabilities, 'WatchService', method);
  let items = $state<Watch[]>([]);
  let selected = $state<Watch>();
  let queries = $state<Query[]>([]);
  let deliveries = $state<Delivery[]>([]);
  let deliveryPage = $state('');
  let editing = $state(false);
  let busy = $state(false);
  let failure = $state('');
  let notice = $state('');
  let nextPage = $state('');
  let confirmation = $state<'delete' | 'cancel' | 'reset'>();
  let includeExisting = $state(false);
  let acknowledge = $state<Record<string, boolean>>({});

  $effect(() => {
    const api = client;
    let active = true;
    busy = true;
    items = [];
    selected = undefined;
    editing = false;
    deliveries = [];
    api
      .listWatches()
      .then((result) => {
        if (active) {
          items = result.watches ?? [];
          nextPage = result.nextPageToken ?? '';
        }
      })
      .catch((error) => {
        if (active) failure = errorMessage(error);
      })
      .finally(() => {
        if (active) busy = false;
      });
    return () => {
      active = false;
    };
  });
  const run = async (action: () => Promise<void>) => {
    busy = true;
    failure = '';
    notice = '';
    try {
      await action();
    } catch (error) {
      failure = errorMessage(error);
    } finally {
      busy = false;
    }
  };
  const loadDeliveries = async (append = false) => {
    if (!selected?.id || !allowed('ListDeliveries')) {
      deliveries = [];
      deliveryPage = '';
      return;
    }
    const result = await client.deliveries(
      selected.id,
      append ? deliveryPage : '',
    );
    deliveries = append
      ? [...deliveries, ...(result.deliveries ?? [])]
      : (result.deliveries ?? []);
    deliveryPage = result.nextPageToken ?? '';
  };
  const select = (id: string) =>
    run(async () => {
      selected = await client.watches.get(id);
      confirmation = undefined;
      acknowledge = {};
      await loadDeliveries();
    });
  const refresh = () =>
    run(async () => {
      const result = await client.listWatches();
      items = result.watches ?? [];
      nextPage = result.nextPageToken ?? '';
      if (selected?.id) {
        selected = await client.watches.get(selected.id);
        await loadDeliveries();
      }
    });
  const edit = () =>
    run(async () => {
      queries = [];
      let token = '';
      if (allowed('ListQueries'))
        do {
          const result = await client.listQueries(token);
          queries = [...queries, ...(result.queries ?? [])];
          token = result.nextPageToken ?? '';
        } while (token);
      editing = true;
    });
  const save = async (id: string, spec: WatchSpec) => {
    if (writeDisabled || !allowed(selected ? 'UpdateWatch' : 'CreateWatch'))
      throw new Error(t('drasi.not-allowed'));
    selected = await client.watches.save(
      resourceIdSchema.parse(selected?.id ?? id),
      spec,
      selected?.revision,
    );
    editing = false;
    notice = t('drasi.accepted');
    try {
      await loadDeliveries();
      const result = await client.listWatches();
      items = result.watches ?? [];
      nextPage = result.nextPageToken ?? '';
    } catch (error) {
      failure = errorMessage(error);
    }
  };
  const operation = (
    action: 'pause' | 'resume' | 'delete' | 'cancel' | 'reset',
  ) =>
    run(async () => {
      if (
        !selected?.id ||
        !selected.revision ||
        writeDisabled ||
        !allowed(`${action[0].toUpperCase()}${action.slice(1)}Watch`)
      )
        throw new Error(t('drasi.not-allowed'));
      const value = await client.watches.operation(
        selected.id,
        selected.revision,
        action,
        action === 'reset'
          ? {
              initialResults: includeExisting
                ? InitialResults.INITIAL_RESULTS_INCLUDE
                : InitialResults.INITIAL_RESULTS_IGNORE,
            }
          : {},
      );
      selected = action === 'delete' ? undefined : value;
      confirmation = undefined;
      notice = t('drasi.accepted');
      const result = await client.listWatches();
      items = result.watches ?? [];
      nextPage = result.nextPageToken ?? '';
      await loadDeliveries();
    });
  const retry = (delivery: Delivery) =>
    run(async () => {
      if (
        !selected?.id ||
        !selected.revision ||
        !delivery.actionId ||
        writeDisabled ||
        !allowed('RetryDelivery')
      )
        throw new Error(t('drasi.not-allowed'));
      await client.retryDelivery(
        selected.id,
        selected.revision,
        delivery.actionId,
        acknowledge[delivery.actionId] === true,
      );
      await loadDeliveries();
      notice = t('drasi.accepted');
    });
</script>

<PageTitle title={t('drasi.watches')} />
<header class="mb-5 flex items-center justify-between">
  <h1>{t('drasi.watches')}</h1>
  <Button colorScheme="secondary" onclick={refresh} disabled={busy || editing}
    >{t('drasi.refresh')}</Button
  >
</header>
{#if writeDisabled}<Alert intent="info" class="mb-4"
    >{t('drasi.read-only')}</Alert
  >{/if}
{#if failure}<Alert intent="error" class="mb-4">{failure}</Alert>{/if}
{#if notice}<Alert intent="info" class="mb-4">{notice}</Alert>{/if}
<div class="grid gap-6 lg:grid-cols-[18rem_1fr]" aria-busy={busy}>
  <ResourceList
    {items}
    selected={selected?.id}
    onselect={select}
    onnew={() => {
      selected = undefined;
      void edit();
    }}
    canCreate={!writeDisabled && allowed('CreateWatch')}
    {nextPage}
    onmore={() =>
      run(async () => {
        const result = await client.listWatches(nextPage);
        items = [...items, ...(result.watches ?? [])];
        nextPage = result.nextPageToken ?? '';
      })}
    busy={busy || editing}
  />
  <section class="flex min-w-0 flex-col gap-4" aria-label={t('drasi.details')}>
    {#if editing}
      <Button
        colorScheme="tertiary"
        onclick={() => {
          editing = false;
        }}>{t('drasi.cancel-edit')}</Button
      >
      {#key selected?.id}<WatchForm
          initial={selected?.spec}
          {queries}
          {capabilities}
          disabled={busy ||
            writeDisabled ||
            !allowed(selected ? 'UpdateWatch' : 'CreateWatch')}
          onsubmit={save}
        />{/key}
    {:else if selected}
      <h2>{selected.id}</h2>
      <ResourceStatus
        status={selected.status}
        desired={selected.desiredState}
        revision={selected.revision}
      />
      <div class="flex flex-wrap gap-3">
        <Button
          onclick={edit}
          disabled={busy || writeDisabled || !allowed('UpdateWatch')}
          >{t('drasi.edit')}</Button
        >
        <Button
          onclick={() => operation('pause')}
          disabled={busy || writeDisabled || !allowed('PauseWatch')}
          >{t('drasi.pause')}</Button
        >
        <Button
          onclick={() => operation('resume')}
          disabled={busy || writeDisabled || !allowed('ResumeWatch')}
          >{t('drasi.resume')}</Button
        >
        <Button
          colorScheme="danger"
          onclick={() => {
            confirmation = 'cancel';
          }}
          disabled={busy || writeDisabled || !allowed('CancelWatch')}
          >{t('drasi.cancel')}</Button
        >
        <Button
          colorScheme="danger"
          onclick={() => {
            confirmation = 'delete';
          }}
          disabled={busy || writeDisabled || !allowed('DeleteWatch')}
          >{t('drasi.delete')}</Button
        >
        <Button
          colorScheme="danger"
          onclick={() => {
            confirmation = 'reset';
            includeExisting = false;
          }}
          disabled={busy || writeDisabled || !allowed('ResetWatch')}
          >{t('drasi.reset')}</Button
        >
      </div>
      {#if confirmation}
        {#if confirmation === 'reset'}<Alert intent="warning"
            >{t('drasi.reset-description')}</Alert
          ><Checkbox
            id="reset-include-existing"
            label={t('drasi.include-existing')}
            bind:checked={includeExisting}
          />{/if}
        <Button
          colorScheme="danger"
          disabled={busy}
          onclick={() => confirmation && operation(confirmation)}
          >{confirmation === 'reset'
            ? t('drasi.confirm-reset')
            : confirmation === 'delete'
              ? t('drasi.confirm-delete')
              : t('drasi.cancel-confirm')}</Button
        >
      {/if}
      <details>
        <summary>{t('drasi.retained-spec')}</summary>
        <pre class="overflow-auto text-xs">{JSON.stringify(
            Watch.toJSON(selected),
            null,
            2,
          )}</pre>
      </details>
      <h2>{t('drasi.deliveries')}</h2>
      <p class="text-sm">{t('drasi.delivery-description')}</p>
      {#if !allowed('ListDeliveries')}<Alert intent="info"
          >{t('drasi.not-allowed')}</Alert
        >{/if}
      {#each deliveries as delivery, index (delivery.actionId)}
        <article class="flex flex-col gap-2 rounded border border-primary p-4">
          <h3 class="break-all">{delivery.actionId}</h3>
          <p>
            {t('drasi.status')}: {delivery.state
              ?.replace('DELIVERY_STATE_', '')
              .replaceAll('_', ' ') ?? t('drasi.unknown')}
          </p>
          <p>
            {t('drasi.attempts')}: {delivery.attempts ?? t('drasi.unknown')}
          </p>
          <p>{delivery.message}</p>
          <p>
            {t('drasi.updated-at')}: {delivery.updatedAt ?? t('drasi.unknown')}
          </p>
          {#if delivery.nextAttemptAt}<p>
              {t('drasi.next-attempt')}: {delivery.nextAttemptAt}
            </p>{/if}
          {#if delivery.execution?.workflowId && delivery.execution.runId}
            <Link
              href={routeForWorkflow({
                namespace,
                workflow: delivery.execution.workflowId,
                run: delivery.execution.runId,
              })}
              >{t('drasi.execution')}: {delivery.execution.workflowId} / {delivery
                .execution.runId}</Link
            >
          {/if}
          {#if delivery.state === DeliveryState.DELIVERY_STATE_AMBIGUOUS && delivery.actionId}<Checkbox
              id={`acknowledge-${index}`}
              label={t('drasi.acknowledge-ambiguous')}
              checked={acknowledge[delivery.actionId] ?? false}
              onChange={({ checked }) => {
                if (delivery.actionId) acknowledge[delivery.actionId] = checked;
              }}
            />{/if}
          {#if delivery.state === DeliveryState.DELIVERY_STATE_AMBIGUOUS || delivery.state === DeliveryState.DELIVERY_STATE_BLOCKED}
            <Button
              disabled={busy ||
                writeDisabled ||
                !allowed('RetryDelivery') ||
                (delivery.state === DeliveryState.DELIVERY_STATE_AMBIGUOUS &&
                  !acknowledge[delivery.actionId ?? ''])}
              onclick={() => retry(delivery)}>{t('drasi.retry')}</Button
            >
          {/if}
        </article>
      {/each}
      {#if deliveryPage}<Button
          colorScheme="tertiary"
          onclick={() => run(() => loadDeliveries(true))}
          disabled={busy}>{t('drasi.load-more')}</Button
        >{/if}
    {/if}
  </section>
</div>
