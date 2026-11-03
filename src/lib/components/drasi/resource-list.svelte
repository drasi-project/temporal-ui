<script lang="ts">
  import { translate as t } from '$lib/i18n/translate';
  import { Button } from '$lib/io/button';

  let {
    items,
    selected,
    onselect,
    onnew,
    canCreate,
    nextPage,
    onmore,
    busy,
  }: {
    items: { id?: string; revision?: string }[];
    selected?: string;
    onselect: (id: string) => void;
    onnew: () => void;
    canCreate: boolean;
    nextPage?: string;
    onmore: () => void;
    busy: boolean;
  } = $props();
</script>

<div class="flex flex-col gap-3">
  <Button onclick={onnew} disabled={!canCreate || busy}
    >{t('drasi.create')}</Button
  >
  {#if !items.length}<p>{t('drasi.no-resources')}</p>{/if}
  <ul class="flex flex-col gap-2">
    {#each items as item (item.id)}
      <li>
        <Button
          colorScheme={selected === item.id ? 'secondary' : 'tertiary'}
          class="w-full justify-between"
          disabled={busy}
          onclick={() => item.id && onselect(item.id)}
        >
          {item.id}
          <span class="text-xs">{t('drasi.revision')} {item.revision}</span>
        </Button>
      </li>
    {/each}
  </ul>
  {#if nextPage}<Button colorScheme="tertiary" onclick={onmore} disabled={busy}
      >{t('drasi.load-more')}</Button
    >{/if}
</div>
