<script lang="ts">
  import {
    type Capabilities,
    type Query,
    Trigger,
    WatchSpec,
  } from '@drasi-project/temporal-watch-contracts/v1';
  import { untrack } from 'svelte';

  import { jsonObjectSchema } from '$lib/drasi/configuration';
  import {
    buildWatchSpec,
    emptyWatchDraft,
    type WatchDraft,
  } from '$lib/drasi/forms';
  import Alert from '$lib/holocene/alert.svelte';
  import Checkbox from '$lib/holocene/checkbox.svelte';
  import Input from '$lib/holocene/input/input.svelte';
  import Textarea from '$lib/holocene/textarea.svelte';
  import { translate as t } from '$lib/i18n/translate';
  import { Button } from '$lib/io/button';
  import { errorMessage } from '$lib/services/drasi-service';

  let {
    initial,
    queries,
    capabilities,
    disabled,
    onsubmit,
  }: {
    initial?: WatchSpec;
    queries: Query[];
    capabilities: Capabilities;
    disabled: boolean;
    onsubmit: (id: string, spec: WatchSpec) => Promise<void>;
  } = $props();
  let id = $state('');
  let draft = $state<WatchDraft>(emptyWatchDraft());
  let advanced = $state(
    untrack(() =>
      initial ? JSON.stringify(WatchSpec.toJSON(initial), null, 2) : '',
    ),
  );
  let busy = $state(false);
  let failure = $state('');
  let submitted: { key: string; spec: WatchSpec } | undefined;
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy || disabled) return;
    busy = true;
    failure = '';
    try {
      const key = initial ? advanced : JSON.stringify(draft);
      const spec =
        submitted?.key === key
          ? submitted.spec
          : initial
            ? WatchSpec.fromJSON(jsonObjectSchema.parse(JSON.parse(advanced)))
            : buildWatchSpec(draft);
      submitted = { key, spec };
      if (spec.lifetime?.$case === 'once' && !capabilities.once)
        throw new Error(t('drasi.not-allowed'));
      await onsubmit(id, spec);
    } catch (error) {
      failure = errorMessage(error);
    } finally {
      busy = false;
    }
  };
</script>

<form class="flex flex-col gap-5" onsubmit={submit}>
  {#if initial}
    <Textarea
      id="watch-spec"
      label={t('drasi.retained-spec')}
      value={advanced}
      oninput={(event) => {
        advanced = event.currentTarget.value;
      }}
      rows={20}
      disabled={disabled || busy}
      spellcheck={false}
    />
  {:else}
    <Input
      id="watch-id"
      label={t('drasi.name')}
      bind:value={id}
      disabled={disabled || busy}
      required
    />
    <label class="flex flex-col gap-2" for="watch-query"
      >{t('drasi.query')}
      <select
        id="watch-query"
        class="rounded border border-primary bg-background-primary p-2"
        value={draft.queryId}
        onchange={(event) => {
          const query = queries.find(
            (item) => item.id === event.currentTarget.value,
          );
          draft.queryId = query?.id ?? '';
          draft.queryRevision = query?.revision ?? '';
        }}
        disabled={disabled || busy}
      >
        <option value="">{t('drasi.select')}</option>
        {#each queries as query (query.id)}<option value={query.id}
            >{query.id} ({t('drasi.revision')} {query.revision})</option
          >{/each}
      </select>
    </label>
    <Input
      id="watch-query-revision"
      label={t('drasi.pinned-revision')}
      bind:value={draft.queryRevision}
      disabled={disabled || busy}
      required
    />
    <label class="flex flex-col gap-2" for="watch-lifetime"
      >{t('drasi.mode')}
      <select
        id="watch-lifetime"
        class="rounded border border-primary bg-background-primary p-2"
        value={draft.once ? 'once' : 'persistent'}
        onchange={(event) => {
          draft.once = event.currentTarget.value === 'once';
        }}
        disabled={disabled || busy}
      >
        <option value="persistent">{t('drasi.recurring')}</option><option
          value="once"
          disabled={!capabilities.once}>{t('drasi.once')}</option
        >
      </select>
    </label>
    <Alert intent="info">{t('drasi.initial-description')}</Alert>
    {#if draft.once}
      <Input
        id="watch-owner-workflow"
        label={t('drasi.owner-workflow')}
        bind:value={draft.ownerWorkflowId}
        disabled={disabled || busy}
        required
      />
      <Input
        id="watch-owner-run"
        label={t('drasi.owner-run')}
        bind:value={draft.ownerRunId}
        disabled={disabled || busy}
        required
      />
      <Input
        id="watch-deadline"
        label={t('drasi.deadline')}
        type="datetime-local"
        bind:value={draft.deadline}
        disabled={disabled || busy}
        required
      />
    {:else}
      <label class="flex flex-col gap-2" for="watch-trigger"
        >{t('drasi.trigger')}
        <select
          id="watch-trigger"
          class="rounded border border-primary bg-background-primary p-2"
          bind:value={draft.trigger}
          disabled={disabled || busy}
        >
          <option value={Trigger.TRIGGER_ENTER}>{t('drasi.enter')}</option
          ><option value={Trigger.TRIGGER_UPDATE}>{t('drasi.update')}</option
          ><option value={Trigger.TRIGGER_LEAVE}>{t('drasi.leave')}</option>
        </select>
      </label>
      <Checkbox
        id="watch-include-existing"
        label={t('drasi.include-existing')}
        bind:checked={draft.includeExisting}
        disabled={disabled || busy}
      />
      <label class="flex flex-col gap-2" for="watch-action"
        >{t('drasi.action')}
        <select
          id="watch-action"
          class="rounded border border-primary bg-background-primary p-2"
          bind:value={draft.operation}
          disabled={disabled || busy}
        >
          <option value="start">{t('drasi.start')}</option><option
            value="signal">{t('drasi.signal')}</option
          ><option value="signalWithStart">{t('drasi.signalWithStart')}</option>
        </select>
      </label>
      <Input
        id="watch-workflow-id"
        label={t('drasi.workflow-id')}
        hintText={t('drasi.id-template')}
        bind:value={draft.workflowId}
        disabled={disabled || busy}
        required
      />
      {#if draft.operation !== 'signal'}
        <Input
          id="watch-workflow-type"
          label={t('drasi.workflow-type')}
          bind:value={draft.workflowType}
          disabled={disabled || busy}
          required
        />
        <Input
          id="watch-task-queue"
          label={t('drasi.task-queue')}
          bind:value={draft.taskQueue}
          disabled={disabled || busy}
          required
        />
      {:else}
        <Input
          id="watch-run-id"
          label={t('drasi.run-id')}
          bind:value={draft.runId}
          disabled={disabled || busy}
        />
        <p class="text-sm text-secondary">{t('drasi.signal-description')}</p>
      {/if}
    {/if}
    {#if draft.once || draft.operation !== 'start'}<Input
        id="watch-signal-name"
        label={t('drasi.signal-name')}
        bind:value={draft.signalName}
        disabled={disabled || busy}
        required
      />{/if}
    <Textarea
      id="watch-input"
      label={t('drasi.input')}
      description={t('drasi.input-description')}
      bind:value={draft.input}
      disabled={disabled || busy}
      spellcheck={false}
    />
    <Checkbox
      id="watch-omit-result"
      label={t('drasi.omit-result')}
      bind:checked={draft.omitResult}
      disabled={disabled || busy}
    />
  {/if}
  {#if failure}<Alert intent="error">{failure}</Alert>{/if}
  <Button type="submit" disabled={disabled || busy} isLoading={busy}
    >{t('drasi.save')}</Button
  >
</form>
