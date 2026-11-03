import { error } from '@sveltejs/kit';

import type { PageLoad } from './$types';

import { createDrasiClient } from '$lib/services/drasi-service';

export const load: PageLoad = async ({ fetch, parent }) => {
  await parent();
  const pluginCapabilities = await createDrasiClient(
    undefined,
    fetch,
  ).pluginCapabilities();
  if (!pluginCapabilities.enabled)
    error(
      404,
      pluginCapabilities.message || 'Plugin management is not enabled.',
    );
  return { pluginCapabilities };
};
