import { z } from 'zod';

import validateJsonSchema from '$lib/catalog/browser/schema-validator';
import type {
  JsonObject,
  JsonSchema,
  JsonValue,
} from '$lib/catalog/browser/types';

export const jsonObjectSchema = z.record(z.string(), z.json());
export const jsonSchemaSchema = z.union([z.boolean(), jsonObjectSchema]);
export const secretReferencesSchema = z.record(
  z.string(),
  z
    .object({
      provider: z.string().min(1),
      key: z.string().min(1),
      version: z.string().min(1),
    })
    .strict(),
);

const validateLiteral = (value: JsonValue, depth = 0): void => {
  if (depth > 32)
    throw new Error('Configuration exceeds 32 levels of nesting.');
  if (
    typeof value === 'string' &&
    value.startsWith('${') &&
    value.endsWith('}')
  ) {
    throw new Error(
      'Use an immutable secret reference instead of SDK interpolation.',
    );
  }
  if (Array.isArray(value)) {
    value.forEach((item) => validateLiteral(item, depth + 1));
  } else if (value !== null && typeof value === 'object') {
    if (value.kind === 'Secret' || value.kind === 'EnvironmentVariable') {
      throw new Error(
        'SDK configuration references are not allowed in ordinary configuration.',
      );
    }
    Object.values(value).forEach((item) => validateLiteral(item, depth + 1));
  }
};

export const parseConfiguration = (text: string): JsonObject => {
  const parsed = jsonObjectSchema.parse(JSON.parse(text));
  validateLiteral(parsed);
  return parsed;
};

export type ConfigurationResult =
  | { valid: true; value: JsonObject }
  | {
      valid: false;
      error: 'invalid-json' | 'invalid-object' | 'invalid-config';
    };

export const validateConfiguration = async (
  schema: JsonSchema,
  text: string,
  secretsText = '{}',
): Promise<ConfigurationResult> => {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { valid: false, error: 'invalid-json' };
  }

  const parsed = jsonObjectSchema.safeParse(document);
  if (!parsed.success) return { valid: false, error: 'invalid-object' };
  validateLiteral(parsed.data);
  const references = secretReferencesSchema.parse(JSON.parse(secretsText));
  const validation: JsonObject = { ...parsed.data };
  for (const [field, reference] of Object.entries(references)) {
    if (Object.hasOwn(validation, field)) {
      throw new Error(`Configuration and secret reference overlap: ${field}`);
    }
    Object.defineProperty(validation, field, {
      value: { kind: 'Secret', name: reference.key },
      enumerable: true,
    });
  }

  if (!(await validateJsonSchema(schema, validation))) {
    return { valid: false, error: 'invalid-config' };
  }

  return { valid: true, value: parsed.data };
};
