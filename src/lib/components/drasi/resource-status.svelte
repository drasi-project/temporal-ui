<script lang="ts">
  import {
    DesiredState,
    LifecycleState,
    type ResourceStatus,
  } from '@drasi-project/temporal-watch-contracts/v1';

  import { translate as t } from '$lib/i18n/translate';

  let {
    status,
    desired,
    revision,
  }: { status?: ResourceStatus; desired?: DesiredState; revision?: string } =
    $props();
  const label = (value: string | undefined, prefix: string) =>
    value?.replace(prefix, '').replaceAll('_', ' ') ?? t('drasi.unknown');
</script>

<dl class="grid grid-cols-2 gap-3 rounded border border-primary p-4 text-sm">
  <dt>{t('drasi.revision')}</dt>
  <dd>{revision ?? t('drasi.unknown')}</dd>
  <dt>{t('drasi.desired')}</dt>
  <dd>{label(desired, 'DESIRED_STATE_')}</dd>
  <dt>{t('drasi.status')}</dt>
  <dd>
    {status?.state === LifecycleState.LIFECYCLE_STATE_UNSPECIFIED
      ? t('drasi.unknown')
      : label(status?.state, 'LIFECYCLE_STATE_')}
  </dd>
  <dt>{t('drasi.pinned-revision')}</dt>
  <dd>{status?.observedRevision ?? t('drasi.unknown')}</dd>
  <dt>{t('drasi.health')}</dt>
  <dd class="break-words">{status?.message || t('drasi.unknown')}</dd>
  <dt>{t('drasi.updated-at')}</dt>
  <dd>{status?.updatedAt ?? t('drasi.unknown')}</dd>
  {#if status?.pendingDeliveries !== undefined}<dt>
      {t('drasi.pending-deliveries')}
    </dt>
    <dd>{status.pendingDeliveries}</dd>{/if}
  {#if status?.acceptedOutput}<dt>{t('drasi.accepted-output')}</dt>
    <dd>
      <pre class="overflow-auto text-xs">{JSON.stringify(
          status.acceptedOutput,
          null,
          2,
        )}</pre>
    </dd>{/if}
</dl>
