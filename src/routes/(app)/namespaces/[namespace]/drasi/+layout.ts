import { error } from '@sveltejs/kit';

import type { LayoutLoad } from './$types';

import { createDrasiClient } from '$lib/services/drasi-service';

export const load: LayoutLoad = async ({ params, fetch, parent }) => {
  await parent();
  const capabilities = await createDrasiClient(
    params.namespace,
    fetch,
  ).capabilities();
  if (!capabilities.enabled)
    error(404, capabilities.message || 'Drasi is not enabled.');
  if (capabilities.apiVersion !== 'v1')
    error(501, 'Unsupported Drasi API version.');
  return { drasiCapabilities: capabilities };
};
