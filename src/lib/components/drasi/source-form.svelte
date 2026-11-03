<script lang="ts">
  import {
    ComponentConfiguration,
    PluginCategory,
    PluginHostState,
    type PluginInstallation,
    type SourceSpec,
  } from '@drasi-project/temporal-watch-contracts/v1';
  import { untrack } from 'svelte';

  import ConfigurationEditor from '$lib/components/drasi/configuration-editor.svelte';
  import {
    jsonSchemaSchema,
    parseConfiguration,
    secretReferencesSchema,
    validateConfiguration,
  } from '$lib/drasi/configuration';
  import Alert from '$lib/holocene/alert.svelte';
  import Input from '$lib/holocene/input/input.svelte';
  import Textarea from '$lib/holocene/textarea.svelte';
  import { translate as t } from '$lib/i18n/translate';
  import { Button } from '$lib/io/button';
  import { errorMessage } from '$lib/services/drasi-service';

  let {
    initial,
    installations,
    temporalEnabled,
    externalEnabled,
    disabled,
    onsubmit,
  }: {
    initial?: SourceSpec;
    installations: PluginInstallation[];
    temporalEnabled: boolean;
    externalEnabled: boolean;
    disabled: boolean;
    onsubmit: (id: string, spec: SourceSpec) => Promise<void>;
  } = $props();
  const initialSpec = untrack(() => initial);
  let id = $state('');
  let kind = $state<'temporal' | 'external'>(
    initialSpec?.kind?.$case ?? 'temporal',
  );
  const components = $derived(
    installations.flatMap((installation) => {
      const plugin = installation.plugin;
      if (
        !plugin?.compatible ||
        !installation.hosts?.length ||
        !installation.hosts.every(
          (host) => host.state === PluginHostState.PLUGIN_HOST_STATE_LOADED,
        )
      )
        return [];
      return (plugin.descriptors ?? [])
        .filter((descriptor) => descriptor.supported)
        .map((descriptor) => ({
          plugin,
          descriptor,
          key: `${plugin.digest}/${descriptor.component}`,
        }));
    }),
  );
  let sourceKey = $state(
    initialSpec?.kind?.$case === 'external'
      ? `${initialSpec.kind.value.plugin?.digest}/${initialSpec.kind.value.plugin?.component}`
      : '',
  );
  let bootstrapKey = $state(
    initialSpec?.bootstrap
      ? `${initialSpec.bootstrap.plugin?.digest}/${initialSpec.bootstrap.plugin?.component}`
      : '',
  );
  let configuration = $state(
    JSON.stringify(
      initialSpec?.kind?.$case === 'external'
        ? (initialSpec.kind.value.configuration ?? {})
        : {},
      null,
      2,
    ),
  );
  let secrets = $state(
    JSON.stringify(
      initialSpec?.kind?.$case === 'external'
        ? (initialSpec.kind.value.secrets ?? {})
        : {},
      null,
      2,
    ),
  );
  let bootstrapConfiguration = $state(
    JSON.stringify(initialSpec?.bootstrap?.configuration ?? {}, null, 2),
  );
  let bootstrapSecrets = $state(
    JSON.stringify(initialSpec?.bootstrap?.secrets ?? {}, null, 2),
  );
  let failure = $state('');
  let submitting = $state(false);
  const selectedSource = $derived(
    components.find(
      (item) =>
        item.key === sourceKey &&
        item.descriptor.category === PluginCategory.PLUGIN_CATEGORY_SOURCE,
    ),
  );
  const selectedBootstrap = $derived(
    components.find(
      (item) =>
        item.key === bootstrapKey &&
        item.descriptor.category === PluginCategory.PLUGIN_CATEGORY_BOOTSTRAP,
    ),
  );
  const sourceSchema = $derived(
    selectedSource
      ? jsonSchemaSchema.parse(
          selectedSource.descriptor.configurationSchema ?? {},
        )
      : undefined,
  );
  const bootstrapSchema = $derived(
    selectedBootstrap
      ? jsonSchemaSchema.parse(
          selectedBootstrap.descriptor.configurationSchema ?? {},
        )
      : undefined,
  );

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (disabled || submitting) return;
    submitting = true;
    failure = '';
    try {
      if (disabled) throw new Error(t('drasi.not-allowed'));
      if (kind === 'temporal') {
        if (!temporalEnabled) throw new Error(t('drasi.not-allowed'));
        await onsubmit(id, { kind: { $case: 'temporal', value: {} } });
        return;
      }
      if (!externalEnabled || !selectedSource || !sourceSchema)
        throw new Error(t('drasi.no-loaded-plugins'));
      const sourceResult = await validateConfiguration(
        sourceSchema,
        configuration,
        secrets,
      );
      if (!sourceResult.valid) throw new Error(t('drasi.invalid-config'));
      const external: ComponentConfiguration = {
        plugin: {
          digest: selectedSource.plugin.digest,
          component: selectedSource.descriptor.component,
        },
        configuration: parseConfiguration(configuration),
        secrets: secretReferencesSchema.parse(JSON.parse(secrets)),
      };
      let bootstrap: ComponentConfiguration | undefined;
      if (bootstrapKey) {
        if (!selectedBootstrap || !bootstrapSchema)
          throw new Error(t('drasi.no-loaded-plugins'));
        const result = await validateConfiguration(
          bootstrapSchema,
          bootstrapConfiguration,
          bootstrapSecrets,
        );
        if (!result.valid) throw new Error(t('drasi.invalid-config'));
        bootstrap = {
          plugin: {
            digest: selectedBootstrap.plugin.digest,
            component: selectedBootstrap.descriptor.component,
          },
          configuration: parseConfiguration(bootstrapConfiguration),
          secrets: secretReferencesSchema.parse(JSON.parse(bootstrapSecrets)),
        };
      }
      await onsubmit(id, {
        kind: { $case: 'external', value: external },
        bootstrap,
      });
    } catch (error) {
      failure = errorMessage(error);
    } finally {
      submitting = false;
    }
  };
</script>

<form class="flex flex-col gap-5" onsubmit={submit}>
  {#if !initial}<Input
      id="source-id"
      label={t('drasi.name')}
      bind:value={id}
      required
      {disabled}
    />{/if}
  <label class="flex flex-col gap-2" for="source-type"
    >{t('drasi.source-type')}
    <select
      id="source-type"
      class="rounded border border-primary bg-background-primary p-2"
      bind:value={kind}
      {disabled}
    >
      <option value="temporal" disabled={!temporalEnabled}
        >{t('drasi.builtin-temporal')}</option
      >
      <option value="external" disabled={!externalEnabled}
        >{t('drasi.external')}</option
      >
    </select>
  </label>
  {#if kind === 'temporal'}
    <Alert intent="info">{t('drasi.builtin-description')}</Alert>
  {:else}
    {#if !components.length}<Alert intent="warning"
        >{t('drasi.no-loaded-plugins')}</Alert
      >{/if}
    <label class="flex flex-col gap-2" for="source-component"
      >{t('drasi.component')}
      <select
        id="source-component"
        class="rounded border border-primary bg-background-primary p-2"
        bind:value={sourceKey}
        {disabled}
      >
        <option value="">{t('drasi.select')}</option>
        {#each components.filter((item) => item.descriptor.category === PluginCategory.PLUGIN_CATEGORY_SOURCE) as item (item.key)}
          <option value={item.key}
            >{item.plugin.id}
            {item.plugin.version} / {item.descriptor.component}</option
          >
        {/each}
      </select>
    </label>
    {#if sourceSchema !== undefined}<ConfigurationEditor
        id="source-configuration"
        schema={sourceSchema}
        bind:value={configuration}
        secretReferences={secrets}
        {disabled}
      />{/if}
    <Textarea
      id="source-secrets"
      label={t('drasi.secrets')}
      description={t('drasi.secrets-description')}
      bind:value={secrets}
      {disabled}
      spellcheck={false}
    />
    <label class="flex flex-col gap-2" for="bootstrap-component"
      >{t('drasi.bootstrap')}
      <select
        id="bootstrap-component"
        class="rounded border border-primary bg-background-primary p-2"
        bind:value={bootstrapKey}
        {disabled}
      >
        <option value="">{t('drasi.no-bootstrap')}</option>
        {#each components.filter((item) => item.descriptor.category === PluginCategory.PLUGIN_CATEGORY_BOOTSTRAP) as item (item.key)}
          <option value={item.key}
            >{item.plugin.id}
            {item.plugin.version} / {item.descriptor.component}</option
          >
        {/each}
      </select>
    </label>
    {#if bootstrapKey}
      {#if bootstrapSchema !== undefined}<ConfigurationEditor
          id="bootstrap-configuration"
          schema={bootstrapSchema}
          bind:value={bootstrapConfiguration}
          secretReferences={bootstrapSecrets}
          {disabled}
        />{/if}
      <Textarea
        id="bootstrap-secrets"
        label={t('drasi.secrets')}
        description={t('drasi.secrets-description')}
        bind:value={bootstrapSecrets}
        {disabled}
        spellcheck={false}
      />
    {/if}
  {/if}
  {#if failure}<Alert intent="error">{failure}</Alert>{/if}
  <Button
    type="submit"
    isLoading={submitting}
    disabled={disabled ||
      submitting ||
      (kind === 'temporal'
        ? !temporalEnabled
        : !externalEnabled || !selectedSource)}>{t('drasi.save')}</Button
  >
</form>
