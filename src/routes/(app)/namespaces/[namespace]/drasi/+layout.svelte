<script lang="ts">
  import type { Snippet } from 'svelte';

  import { page } from '$app/state';

  import Alert from '$lib/holocene/alert.svelte';
  import Link from '$lib/holocene/link.svelte';
  import { translate as t } from '$lib/i18n/translate';
  import {
    routeForDrasiQueries,
    routeForDrasiSources,
    routeForDrasiWatches,
  } from '$lib/utilities/route-for';

  let { children }: { children: Snippet } = $props();
</script>

<nav aria-label={t('drasi.title')} class="mb-5 flex gap-5">
  <Link href={routeForDrasiSources({ namespace: page.params.namespace })}
    >{t('drasi.sources')}</Link
  >
  <Link href={routeForDrasiQueries({ namespace: page.params.namespace })}
    >{t('drasi.queries')}</Link
  >
  <Link href={routeForDrasiWatches({ namespace: page.params.namespace })}
    >{t('drasi.watches')}</Link
  >
</nav>
{#if page.data.drasiCapabilities.message}<Alert intent="info" class="mb-4"
    >{page.data.drasiCapabilities.message}</Alert
  >{/if}
{@render children()}
