<script lang="ts">
  import type {
    Query,
    QuerySpec,
    Source,
  } from '@drasi-project/temporal-watch-contracts/v1';

  import { page } from '$app/state';

  import QueryForm from '$lib/components/drasi/query-form.svelte';
  import ResourceList from '$lib/components/drasi/resource-list.svelte';
  import ResourceStatus from '$lib/components/drasi/resource-status.svelte';
  import PageTitle from '$lib/components/page-title.svelte';
  import { resourceIdSchema } from '$lib/drasi/forms';
  import Alert from '$lib/holocene/alert.svelte';
  import { translate as t } from '$lib/i18n/translate';
  import { Button } from '$lib/io/button';
  import {
    createDrasiClient,
    errorMessage,
    methodAllowed,
  } from '$lib/services/drasi-service';
  import { coreUserStore } from '$lib/stores/core-user';

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
  let items = $state<Query[]>([]);
  let sources = $state<Source[]>([]);
  let selected = $state<Query>();
  let editing = $state(false);
  let busy = $state(false);
  let failure = $state('');
  let notice = $state('');
  let nextPage = $state('');
  let confirmDelete = $state(false);
  $effect(() => {
    const api = client;
    let active = true;
    busy = true;
    items = [];
    selected = undefined;
    editing = false;
    api
      .listQueries()
      .then((result) => {
        if (active) {
          items = result.queries ?? [];
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
  const refresh = () =>
    run(async () => {
      const result = await client.listQueries();
      items = result.queries ?? [];
      nextPage = result.nextPageToken ?? '';
      if (selected?.id) selected = await client.queries.get(selected.id);
    });
  const edit = () =>
    run(async () => {
      sources = [];
      let token = '';
      if (allowed('ListSources')) {
        do {
          const result = await client.listSources(token);
          sources = [...sources, ...(result.sources ?? [])];
          token = result.nextPageToken ?? '';
        } while (token);
      }
      editing = true;
    });
  const save = async (id: string, spec: QuerySpec) => {
    if (writeDisabled || !allowed(selected ? 'UpdateQuery' : 'CreateQuery'))
      throw new Error(t('drasi.not-allowed'));
    selected = await client.queries.save(
      resourceIdSchema.parse(selected?.id ?? id),
      spec,
      selected?.revision,
    );
    editing = false;
    notice = t('drasi.accepted');
    try {
      const result = await client.listQueries();
      items = result.queries ?? [];
      nextPage = result.nextPageToken ?? '';
    } catch (error) {
      failure = errorMessage(error);
    }
  };
  const operation = (action: 'start' | 'stop' | 'delete') =>
    run(async () => {
      if (
        !selected?.id ||
        !selected.revision ||
        writeDisabled ||
        !allowed(`${action[0].toUpperCase()}${action.slice(1)}Query`)
      )
        throw new Error(t('drasi.not-allowed'));
      const value = await client.queries.operation(
        selected.id,
        selected.revision,
        action,
      );
      selected = action === 'delete' ? undefined : value;
      confirmDelete = false;
      notice = t('drasi.accepted');
      const result = await client.listQueries();
      items = result.queries ?? [];
      nextPage = result.nextPageToken ?? '';
    });
</script>

<PageTitle title={t('drasi.queries')} />
<header class="mb-5 flex items-center justify-between">
  <h1>{t('drasi.queries')}</h1>
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
    onselect={(id) =>
      run(async () => {
        selected = await client.queries.get(id);
        confirmDelete = false;
      })}
    onnew={() => {
      selected = undefined;
      void edit();
    }}
    canCreate={!writeDisabled && allowed('CreateQuery')}
    {nextPage}
    onmore={() =>
      run(async () => {
        const result = await client.listQueries(nextPage);
        items = [...items, ...(result.queries ?? [])];
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
      {#key selected?.id}<QueryForm
          initial={selected?.spec}
          {sources}
          {capabilities}
          disabled={busy ||
            writeDisabled ||
            !allowed(selected ? 'UpdateQuery' : 'CreateQuery')}
          canValidate={allowed('ValidateQuery')}
          canPreview={allowed('PreviewQuery')}
          onsubmit={save}
          onvalidate={(spec) => client.validateQuery(spec)}
          onpreview={(spec, limit) => client.previewQuery(spec, limit)}
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
          disabled={busy ||
            (!allowed('UpdateQuery') &&
              !allowed('ValidateQuery') &&
              !allowed('PreviewQuery'))}>{t('drasi.edit')}</Button
        >
        <Button
          onclick={() => operation('start')}
          disabled={busy || writeDisabled || !allowed('StartQuery')}
          >{t('drasi.start-resource')}</Button
        >
        <Button
          onclick={() => operation('stop')}
          disabled={busy || writeDisabled || !allowed('StopQuery')}
          >{t('drasi.stop')}</Button
        >
        <Button
          colorScheme="danger"
          onclick={() => {
            confirmDelete = true;
          }}
          disabled={busy || writeDisabled || !allowed('DeleteQuery')}
          >{t('drasi.delete')}</Button
        >
        {#if confirmDelete}<Button
            colorScheme="danger"
            onclick={() => operation('delete')}
            disabled={busy}>{t('drasi.confirm-delete')}</Button
          >{/if}
      </div>
      <pre
        class="overflow-auto rounded bg-surface-primary p-4 text-xs">{selected
          .spec?.text}</pre>
      <details>
        <summary>{t('drasi.retained-spec')}</summary>
        <pre class="overflow-auto text-xs">{JSON.stringify(
            selected.spec,
            null,
            2,
          )}</pre>
      </details>
    {/if}
  </section>
</div>
