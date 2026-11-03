<script lang="ts">
  import type {
    Capabilities,
    PreviewQueryResponse,
    QuerySpec,
    ResourceRef,
    Source,
    ValidateQueryResponse,
  } from '@drasi-project/temporal-watch-contracts/v1';
  import { untrack } from 'svelte';
  import { z } from 'zod';

  import { resourceIdSchema, revisionSchema } from '$lib/drasi/forms';
  import Alert from '$lib/holocene/alert.svelte';
  import Checkbox from '$lib/holocene/checkbox.svelte';
  import Input from '$lib/holocene/input/input.svelte';
  import Textarea from '$lib/holocene/textarea.svelte';
  import { translate as t } from '$lib/i18n/translate';
  import { Button } from '$lib/io/button';
  import { errorMessage } from '$lib/services/drasi-service';

  let {
    initial,
    sources,
    capabilities,
    disabled,
    canValidate,
    canPreview,
    onsubmit,
    onvalidate,
    onpreview,
  }: {
    initial?: QuerySpec;
    sources: Source[];
    capabilities: Capabilities;
    disabled: boolean;
    canValidate: boolean;
    canPreview: boolean;
    onsubmit: (id: string, spec: QuerySpec) => Promise<void>;
    onvalidate: (spec: QuerySpec) => Promise<ValidateQueryResponse>;
    onpreview: (
      spec: QuerySpec,
      limit: number,
    ) => Promise<PreviewQueryResponse>;
  } = $props();
  let id = $state('');
  let language = $state(
    untrack(() => initial?.language ?? capabilities.queryLanguages?.[0] ?? ''),
  );
  let text = $state(untrack(() => initial?.text ?? ''));
  let stateStore = $state(
    untrack(() => initial?.stateStore ?? capabilities.stateStores?.[0] ?? ''),
  );
  let refs = $state<ResourceRef[]>(
    untrack(() => initial?.sources?.map((ref) => ({ ...ref })) ?? []),
  );
  let limit = $state(
    untrack(() => String(Math.min(20, capabilities.maxPreviewRows ?? 0))),
  );
  let busy = $state(false);
  let failure = $state('');
  let validation = $state<ValidateQueryResponse>();
  let preview = $state<PreviewQueryResponse>();
  const spec = (): QuerySpec => ({
    language: z.enum(capabilities.queryLanguages ?? []).parse(language),
    text: z.string().min(1).parse(text),
    stateStore: z.enum(capabilities.stateStores ?? []).parse(stateStore),
    sources: z
      .array(z.object({ id: resourceIdSchema, revision: revisionSchema }))
      .min(1)
      .parse(refs),
  });
  const run = async (action: () => Promise<void>) => {
    busy = true;
    failure = '';
    try {
      await action();
    } catch (error) {
      failure = errorMessage(error);
    } finally {
      busy = false;
    }
  };
</script>

<form
  class="flex flex-col gap-5"
  onsubmit={(event) => {
    event.preventDefault();
    if (!disabled && !busy) void run(() => onsubmit(id, spec()));
  }}
>
  {#if !initial}<Input
      id="query-id"
      label={t('drasi.name')}
      bind:value={id}
      disabled={disabled || busy}
      required
    />{/if}
  <label class="flex flex-col gap-2" for="query-language"
    >{t('drasi.language')}
    <select
      id="query-language"
      class="rounded border border-primary bg-background-primary p-2"
      bind:value={language}
      disabled={busy || disabled}
    >
      {#each capabilities.queryLanguages ?? [] as item (item)}<option
          value={item}>{item}</option
        >{/each}
    </select>
  </label>
  <Textarea
    id="query-text"
    label={t('drasi.expression')}
    bind:value={text}
    disabled={busy || disabled}
    rows={8}
    required
    spellcheck={false}
    oninput={() => {
      validation = undefined;
      preview = undefined;
    }}
  />
  <fieldset
    class="flex flex-col gap-3 rounded border border-primary p-4"
    disabled={busy || disabled}
  >
    <legend>{t('drasi.source-revisions')}</legend>
    {#each sources as source (source.id)}
      <Checkbox
        id={`query-source-${source.id}`}
        label={`${source.id} (${t('drasi.revision')} ${source.revision})`}
        checked={refs.some((ref) => ref.id === source.id)}
        onChange={({ checked }) => {
          refs = checked
            ? [...refs, { id: source.id, revision: source.revision }]
            : refs.filter((ref) => ref.id !== source.id);
        }}
      />
    {/each}
    {#each refs as ref, index (ref.id)}
      <Input
        id={`query-source-revision-${index}`}
        label={`${ref.id}: ${t('drasi.pinned-revision')}`}
        value={ref.revision ?? ''}
        oninput={(event) => {
          refs = refs.map((item, i) =>
            i === index
              ? { ...item, revision: event.currentTarget.value }
              : item,
          );
        }}
        required
      />
    {/each}
  </fieldset>
  <label class="flex flex-col gap-2" for="query-state-store"
    >{t('drasi.state-store')}
    <select
      id="query-state-store"
      class="rounded border border-primary bg-background-primary p-2"
      bind:value={stateStore}
      disabled={busy || disabled}
    >
      {#each capabilities.stateStores ?? [] as item (item)}<option value={item}
          >{item}</option
        >{/each}
    </select>
  </label>
  <Input
    id="query-preview-limit"
    label={t('drasi.preview-limit')}
    type="number"
    min="1"
    max={Math.min(200, capabilities.maxPreviewRows ?? 0)}
    bind:value={limit}
    disabled={busy || !canPreview}
  />
  <div class="flex flex-wrap gap-3">
    <Button type="submit" disabled={busy || disabled}>{t('drasi.save')}</Button>
    <Button
      colorScheme="secondary"
      disabled={busy || !canValidate}
      onclick={() =>
        run(async () => {
          validation = await onvalidate(spec());
        })}>{t('drasi.validate')}</Button
    >
    <Button
      colorScheme="secondary"
      disabled={busy || !canPreview || !capabilities.maxPreviewRows}
      onclick={() =>
        run(async () => {
          const rows = z.coerce
            .number()
            .int()
            .min(1)
            .max(Math.min(200, capabilities.maxPreviewRows ?? 0))
            .parse(limit);
          preview = await onpreview(spec(), rows);
        })}>{t('drasi.preview')}</Button
    >
  </div>
  {#if failure}<Alert intent="error">{failure}</Alert>{/if}
  {#if validation}
    <Alert intent={validation.valid ? 'success' : 'error'}
      >{validation.valid ? t('drasi.query-valid') : t('drasi.query-invalid')}
      {#each validation.diagnostics ?? [] as diagnostic, i (i)}<p>
          {diagnostic.field}: {diagnostic.message}
        </p>{/each}
    </Alert>
  {/if}
  {#if preview}
    <section aria-label={t('drasi.results')} class="flex flex-col gap-3">
      <p class="text-sm">{t('drasi.preview-description')}</p>
      <p>{t('drasi.updated-at')}: {preview.observedAt ?? t('drasi.unknown')}</p>
      <pre
        class="overflow-auto rounded bg-surface-primary p-4 text-xs">{JSON.stringify(
          preview.rows,
          null,
          2,
        )}</pre>
      {#if preview.truncated}<p>{t('drasi.truncated')}</p>{/if}
    </section>
  {/if}
</form>
