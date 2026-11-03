import { z } from 'zod';

import type { JsonSchema } from '$lib/catalog/browser/types';

const hintsSchema = z.object({
  label: z.string().max(200).optional(),
  helpText: z.string().max(2000).optional(),
});

export const schemaHints = (
  schema: JsonSchema,
): {
  label?: string;
  helpText?: string;
} => {
  if (typeof schema === 'boolean') return {};
  const parsed = hintsSchema.safeParse(schema['x-ui']);
  return parsed.success ? parsed.data : {};
};
