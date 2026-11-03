<script lang="ts">
  import {
    PluginHostState,
    type PluginInstallation,
    type Source,
    SourceSpec,
  } from '@drasi-project/temporal-watch-contracts/v1';

  import { page } from '$app/state';

  import ResourceList from '$lib/components/drasi/resource-list.svelte';
  import ResourceStatus from '$lib/components/drasi/resource-status.svelte';
  import SourceForm from '$lib/components/drasi/source-form.svelte';
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
    !writeDisabled && methodAllowed(capabilities, 'WatchService', method);
  let items = $state<Source[]>([]);
  let selected = $state<Source>();
  let editing = $state(false);
  let busy = $state(false);
  let failure = $state('');
  let notice = $state('');
  let nextPage = $state('');
  let installations = $state<PluginInstallation[]>([]);
  let pluginError = $state('');
  let confirmDelete = $state(false);

  $effect(() => {
    const api = client;
    let active = true;
    busy = true;
    items = [];
    selected = undefined;
    editing = false;
    api
      .listSources()
      .then((result) => {
        if (active) {
          items = result.sources ?? [];
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
      const result = await client.listSources();
      items = result.sources ?? [];
      nextPage = result.nextPageToken ?? '';
      if (selected?.id) selected = await client.sources.get(selected.id);
    });
  const select = (id: string) =>
    run(async () => {
      selected = await client.sources.get(id);
      confirmDelete = false;
    });
  const edit = () =>
    run(async () => {
      pluginError = '';
      installations = [];
      if (capabilities.externalSources) {
        try {
          const api = createDrasiClient();
          const pluginCapabilities = await api.pluginCapabilities();
          if (
            !methodAllowed(
              pluginCapabilities,
              'PluginService',
              'ListInstallations',
            )
          )
            throw new Error(t('drasi.plugin-read-error'));
          let token = '';
          do {
            const result = await api.installations(token);
            for (const installation of result.installations ?? []) {
              if (
                installation.plugin &&
                installation.hosts?.length &&
                installation.hosts.every(
                  (host) =>
                    host.state === PluginHostState.PLUGIN_HOST_STATE_LOADED,
                )
              ) {
                if (
                  !methodAllowed(
                    pluginCapabilities,
                    'PluginService',
                    'GetPlugin',
                  )
                )
                  throw new Error(t('drasi.plugin-read-error'));
                installations = [
                  ...installations,
                  {
                    ...installation,
                    plugin: await api.plugin(installation.plugin),
                  },
                ];
              } else {
                installations = [...installations, installation];
              }
            }
            token = result.nextPageToken ?? '';
          } while (token);
        } catch (error) {
          pluginError = errorMessage(error);
        }
      }
      editing = true;
    });
  const save = async (id: string, spec: SourceSpec) => {
    const method = selected ? 'UpdateSource' : 'CreateSource';
    if (!allowed(method)) throw new Error(t('drasi.not-allowed'));
    const result = await client.sources.save(
      resourceIdSchema.parse(selected?.id ?? id),
      spec,
      selected?.revision,
    );
    selected = result;
    editing = false;
    notice = t('drasi.accepted');
    try {
      const listing = await client.listSources();
      items = listing.sources ?? [];
      nextPage = listing.nextPageToken ?? '';
    } catch (error) {
      failure = errorMessage(error);
    }
  };
  const operation = (action: 'start' | 'stop' | 'delete') =>
    run(async () => {
      if (
        !selected?.id ||
        !selected.revision ||
        !allowed(`${action[0].toUpperCase()}${action.slice(1)}Source`)
      )
        throw new Error(t('drasi.not-allowed'));
      const value = await client.sources.operation(
        selected.id,
        selected.revision,
        action,
      );
      selected = action === 'delete' ? undefined : value;
      confirmDelete = false;
      notice = t('drasi.accepted');
      const result = await client.listSources();
      items = result.sources ?? [];
      nextPage = result.nextPageToken ?? '';
    });
</script>

<PageTitle title={t('drasi.sources')} />
<header class="mb-5 flex items-center justify-between">
  <h1>{t('drasi.sources')}</h1>
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
    canCreate={allowed('CreateSource')}
    {nextPage}
    onmore={() =>
      run(async () => {
        const result = await client.listSources(nextPage);
        items = [...items, ...(result.sources ?? [])];
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
      {#if pluginError}<Alert intent="warning"
          >{t('drasi.plugin-read-error')} {pluginError}</Alert
        >{/if}
      {#key selected?.id}<SourceForm
          initial={selected?.spec}
          {installations}
          temporalEnabled={capabilities.temporalSource === true}
          externalEnabled={capabilities.externalSources === true}
          disabled={busy ||
            !allowed(selected ? 'UpdateSource' : 'CreateSource')}
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
        <Button onclick={edit} disabled={busy || !allowed('UpdateSource')}
          >{t('drasi.edit')}</Button
        >
        <Button
          onclick={() => operation('start')}
          disabled={busy || !allowed('StartSource')}
          >{t('drasi.start-resource')}</Button
        >
        <Button
          onclick={() => operation('stop')}
          disabled={busy || !allowed('StopSource')}>{t('drasi.stop')}</Button
        >
        <Button
          colorScheme="danger"
          onclick={() => {
            confirmDelete = true;
          }}
          disabled={busy || !allowed('DeleteSource')}
          >{t('drasi.delete')}</Button
        >
        {#if confirmDelete}<Button
            colorScheme="danger"
            onclick={() => operation('delete')}
            disabled={busy}>{t('drasi.confirm-delete')}</Button
          >{/if}
      </div>
      <details>
        <summary>{t('drasi.retained-spec')}</summary>
        <pre class="overflow-auto text-xs">{JSON.stringify(
            SourceSpec.toJSON(selected.spec ?? {}),
            null,
            2,
          )}</pre>
      </details>
    {/if}
  </section>
</div>
