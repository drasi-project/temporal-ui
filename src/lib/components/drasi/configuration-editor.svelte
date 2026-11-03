<script lang="ts">
  import type { JsonSchema } from '$lib/catalog/browser/types';
  import { validateConfiguration } from '$lib/drasi/configuration';
  import { schemaHints } from '$lib/drasi/schema-hints';
  import Alert from '$lib/holocene/alert.svelte';
  import Textarea from '$lib/holocene/textarea.svelte';
  import { translate as t } from '$lib/i18n/translate';
  import { Button } from '$lib/io/button';
  import { errorMessage } from '$lib/services/drasi-service';

  let {
    id,
    schema,
    value = $bindable(),
    secretReferences = '{}',
    disabled = false,
  }: {
    id: string;
    schema: JsonSchema;
    value: string;
    secretReferences?: string;
    disabled?: boolean;
  } = $props();
  let message = $state('');
  let valid = $state(false);
  let validating = $state(false);
  let checked = $state.raw<{
    schema: JsonSchema;
    text: string;
    references: string;
  }>();
  const description = $derived(
    typeof schema === 'object' && typeof schema.description === 'string'
      ? schema.description
      : '',
  );
  const hints = $derived(schemaHints(schema));
  const validate = async () => {
    validating = true;
    message = '';
    const text = value;
    const references = secretReferences;
    const specification = schema;
    try {
      const result = await validateConfiguration(
        specification,
        text,
        references,
      );
      if (
        text !== value ||
        references !== secretReferences ||
        specification !== schema
      )
        return;
      checked = { schema: specification, text, references };
      valid = result.valid;
      message = result.valid
        ? t('drasi.config-valid')
        : t('drasi.invalid-config');
    } catch (error) {
      checked = { schema: specification, text, references };
      valid = false;
      message = errorMessage(error);
    } finally {
      validating = false;
    }
  };
</script>

<div class="flex flex-col gap-3">
  {#if description}<p class="text-sm text-secondary">{description}</p>{/if}
  <Textarea
    {id}
    bind:value
    label={hints.label ?? t('drasi.configuration')}
    description={hints.helpText ?? t('drasi.configuration-description')}
    {disabled}
    rows={7}
    spellcheck={false}
    oninput={() => {
      message = '';
    }}
  />
  <Button
    colorScheme="secondary"
    onclick={validate}
    disabled={disabled || validating}
    isLoading={validating}>{t('drasi.validate-config')}</Button
  >
  {#if message && checked?.schema === schema && checked.text === value && checked.references === secretReferences}<Alert
      intent={valid ? 'success' : 'error'}>{message}</Alert
    >{/if}
  <details>
    <summary class="cursor-pointer">{t('drasi.configuration-schema')}</summary>
    <pre
      class="mt-2 overflow-auto rounded bg-surface-primary p-3 text-xs">{JSON.stringify(
        schema,
        null,
        2,
      )}</pre>
  </details>
</div>
