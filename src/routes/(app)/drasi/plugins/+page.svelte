<script lang="ts">
  import {
    type Catalog,
    type Plugin,
    PluginHostState,
    type PluginInstallation,
  } from '@drasi-project/temporal-watch-contracts/v1';

  import { page } from '$app/state';

  import PageTitle from '$lib/components/page-title.svelte';
  import Alert from '$lib/holocene/alert.svelte';
  import Input from '$lib/holocene/input/input.svelte';
  import { translate as t } from '$lib/i18n/translate';
  import { Button } from '$lib/io/button';
  import {
    createDrasiClient,
    errorMessage,
    methodAllowed,
  } from '$lib/services/drasi-service';

  const capabilities = $derived(page.data.pluginCapabilities);
  const client = $derived(
    createDrasiClient(undefined, fetch, capabilities.maxRequestBytes),
  );
  const allowed = (method: string) =>
    methodAllowed(capabilities, 'PluginService', method);
  let catalogs = $state<Catalog[]>([]);
  let plugins = $state<Plugin[]>([]);
  let installations = $state<PluginInstallation[]>([]);
  let search = $state('');
  let catalogId = $state('');
  let busy = $state(false);
  let failure = $state('');
  let notice = $state('');
  let pluginPage = $state('');
  let installationPage = $state('');
  let catalogPage = $state('');

  $effect(() => {
    const api = client;
    let active = true;
    busy = true;
    const load = async () => {
      const failures: string[] = [];
      const sections = [
        [
          t('drasi.trusted-catalogs'),
          async () => {
            if (!allowed('ListCatalogs')) return;
            const result = await api.catalogs();
            if (active) {
              catalogs = result.catalogs ?? [];
              catalogPage = result.nextPageToken ?? '';
            }
          },
        ],
        [
          t('drasi.installations'),
          async () => {
            if (!allowed('ListInstallations')) return;
            const result = await api.installations();
            if (active) {
              installations = result.installations ?? [];
              installationPage = result.nextPageToken ?? '';
            }
          },
        ],
        [
          t('drasi.plugins'),
          async () => {
            if (!allowed('ListPlugins')) return;
            const result = await api.plugins();
            if (active) {
              plugins = result.plugins ?? [];
              pluginPage = result.nextPageToken ?? '';
            }
          },
        ],
      ] as const;
      for (const [label, operation] of sections) {
        if (!active) return;
        try {
          await operation();
        } catch (error) {
          if (active) {
            failures.push(`${label}: ${errorMessage(error)}`);
            failure = failures.join('\n');
          }
        }
      }
    };
    void load()
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
  const discover = () =>
    run(async () => {
      if (!allowed('ListPlugins')) throw new Error(t('drasi.not-allowed'));
      const result = await client.plugins(search, catalogId);
      plugins = result.plugins ?? [];
      pluginPage = result.nextPageToken ?? '';
    });
  const refresh = () =>
    run(async () => {
      if (allowed('ListInstallations')) {
        const result = await client.installations();
        installations = result.installations ?? [];
        installationPage = result.nextPageToken ?? '';
      }
    });
  const acceptInstallation = (installation: PluginInstallation) => {
    installations = [
      ...installations.filter(
        (item) => item.plugin?.digest !== installation.plugin?.digest,
      ),
      installation,
    ];
    notice = t('drasi.accepted');
  };
</script>

<PageTitle title={t('drasi.plugins')} />
<header class="mb-5 flex items-center justify-between">
  <h1>{t('drasi.plugins')}</h1>
  <Button colorScheme="secondary" onclick={refresh} disabled={busy}
    >{t('drasi.refresh')}</Button
  >
</header>
<Alert intent="info" class="mb-4">{t('drasi.catalog-description')}</Alert>
{#if capabilities.message}<Alert intent="info" class="mb-4"
    >{capabilities.message}</Alert
  >{/if}
{#if page.data.settings.disableWriteActions}<Alert intent="info" class="mb-4"
    >{t('drasi.read-only')}</Alert
  >{/if}
{#if failure}<Alert intent="error" class="mb-4">{failure}</Alert>{/if}
{#if notice}<Alert intent="info" class="mb-4">{notice}</Alert>{/if}
<form
  class="mb-5 flex flex-wrap items-end gap-4"
  onsubmit={(event) => {
    event.preventDefault();
    void discover();
  }}
>
  <Input
    id="plugin-search"
    label={t('drasi.search')}
    bind:value={search}
    disabled={busy}
    maxLength={256}
  />
  <label class="flex flex-col gap-2" for="plugin-catalog"
    >{t('drasi.trusted-catalogs')}
    <select
      id="plugin-catalog"
      class="rounded border border-primary bg-background-primary p-2"
      bind:value={catalogId}
      disabled={busy}
    >
      <option value="">{t('drasi.all-catalogs')}</option>
      {#each catalogs as catalog (catalog.id)}<option value={catalog.id}
          >{catalog.displayName || catalog.id}</option
        >{/each}
    </select>
  </label>
  <Button type="submit" disabled={busy || !allowed('ListPlugins')}
    >{t('drasi.search')}</Button
  >
  {#if catalogPage}<Button
      colorScheme="tertiary"
      disabled={busy}
      onclick={() =>
        run(async () => {
          const result = await client.catalogs(catalogPage);
          catalogs = [...catalogs, ...(result.catalogs ?? [])];
          catalogPage = result.nextPageToken ?? '';
        })}>{t('drasi.load-more')} {t('drasi.trusted-catalogs')}</Button
    >{/if}
</form>
<section
  class="grid gap-4 lg:grid-cols-2"
  aria-label={t('drasi.plugins')}
  aria-busy={busy}
>
  {#if !plugins.length}<p>{t('drasi.no-resources')}</p>{/if}
  {#each plugins as plugin (`${plugin.catalogId}/${plugin.id}/${plugin.version}/${plugin.platform}`)}
    <article
      class="flex min-w-0 flex-col gap-3 rounded border border-primary p-4"
    >
      <h2>{plugin.id} {plugin.version}</h2>
      <dl class="grid grid-cols-[auto_1fr] gap-2 text-sm">
        <dt>{t('drasi.trusted-catalogs')}</dt>
        <dd>{plugin.catalogId}</dd>
        <dt>{t('drasi.signer')}</dt>
        <dd class="break-all">{plugin.signerIdentity || t('drasi.unknown')}</dd>
        <dt>{t('drasi.digest')}</dt>
        <dd class="break-all">{plugin.digest}</dd>
        <dt>{t('drasi.platform')}</dt>
        <dd>{plugin.platform}</dd>
        <dt>{t('drasi.abi')}</dt>
        <dd>{plugin.abiVersion}</dd>
        <dt>{t('drasi.sdk')}</dt>
        <dd>{plugin.sdkVersion}</dd>
        <dt>{t('drasi.core')}</dt>
        <dd>{plugin.coreVersion}</dd>
      </dl>
      <p>
        {plugin.compatible === true
          ? t('drasi.compatible')
          : t('drasi.incompatible')}
      </p>
      {#if plugin.message}<Alert intent="warning">{plugin.message}</Alert>{/if}
      {#if plugin.provenance}<p class="break-words text-sm">
          {plugin.provenance}
        </p>{/if}
      {#if !plugin.descriptors?.length}<p class="text-sm">
          {t('drasi.schemas-unavailable')}
        </p>{/if}
      {#each plugin.descriptors ?? [] as descriptor (descriptor.component)}
        <details>
          <summary>{descriptor.component} / {descriptor.category}</summary>
          <pre class="overflow-auto text-xs">{JSON.stringify(
              descriptor.configurationSchema,
              null,
              2,
            )}</pre>
        </details>
      {/each}
      <Button
        colorScheme="secondary"
        disabled={busy || !allowed('GetPlugin')}
        onclick={() =>
          run(async () => {
            const details = await client.plugin(plugin);
            plugins = plugins.map((item) =>
              item.catalogId === plugin.catalogId &&
              item.id === plugin.id &&
              item.version === plugin.version &&
              item.digest === plugin.digest
                ? details
                : item,
            );
          })}>{t('drasi.details')}</Button
      >
      <Button
        disabled={busy ||
          page.data.settings.disableWriteActions ||
          !allowed('InstallPlugin') ||
          plugin.compatible !== true}
        onclick={() =>
          run(async () => {
            acceptInstallation(await client.install(plugin));
          })}>{t('drasi.install')}</Button
      >
    </article>
  {/each}
</section>
{#if pluginPage}<Button
    class="mt-4"
    colorScheme="tertiary"
    disabled={busy}
    onclick={() =>
      run(async () => {
        const result = await client.plugins(search, catalogId, pluginPage);
        plugins = [...plugins, ...(result.plugins ?? [])];
        pluginPage = result.nextPageToken ?? '';
      })}>{t('drasi.load-more')}</Button
  >{/if}
<section class="mt-7 flex flex-col gap-4" aria-label={t('drasi.installations')}>
  <h2>{t('drasi.installations')}</h2>
  <p>{t('drasi.restart-required')}</p>
  {#each installations as installation (installation.plugin?.digest)}
    <article
      class="flex min-w-0 flex-col gap-3 rounded border border-primary p-4"
    >
      <h3>{installation.plugin?.id} {installation.plugin?.version}</h3>
      <p class="break-all text-sm">{installation.plugin?.digest}</p>
      <p>
        {t('drasi.load-requested')}: {String(
          installation.loadRequested === true,
        )}
      </p>
      <h4>{t('drasi.hosts')}</h4>
      {#if !installation.hosts?.length}<Alert intent="warning"
          >{t('drasi.no-hosts')}</Alert
        >{/if}
      {#each installation.hosts ?? [] as host (host.hostId)}
        <dl
          class="grid grid-cols-[auto_1fr] gap-2 rounded bg-surface-primary p-3 text-sm"
        >
          <dt>{host.hostId}</dt>
          <dd>
            {!host.state ||
            host.state === PluginHostState.PLUGIN_HOST_STATE_UNSPECIFIED
              ? t('drasi.unknown')
              : host.state
                  .replace('PLUGIN_HOST_STATE_', '')
                  .replaceAll('_', ' ')}
          </dd>
          <dt>{t('drasi.verified-signer')}</dt>
          <dd class="break-all">
            {host.verifiedSignerIdentity || t('drasi.unknown')}
          </dd>
          <dt>{t('drasi.health')}</dt>
          <dd>{host.message || t('drasi.unknown')}</dd>
          <dt>{t('drasi.updated-at')}</dt>
          <dd>{host.updatedAt ?? t('drasi.unknown')}</dd>
        </dl>
      {/each}
      <Button
        disabled={busy ||
          page.data.settings.disableWriteActions ||
          !allowed('LoadPlugin') ||
          !installation.plugin?.digest}
        onclick={() =>
          run(async () => {
            if (installation.plugin?.digest)
              acceptInstallation(await client.load(installation.plugin.digest));
          })}>{t('drasi.load')}</Button
      >
    </article>
  {/each}
  {#if installationPage}<Button
      colorScheme="tertiary"
      disabled={busy}
      onclick={() =>
        run(async () => {
          const result = await client.installations(installationPage);
          installations = [...installations, ...(result.installations ?? [])];
          installationPage = result.nextPageToken ?? '';
        })}>{t('drasi.load-more')}</Button
    >{/if}
</section>
