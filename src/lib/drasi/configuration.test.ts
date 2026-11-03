import { describe, expect, it } from 'vitest';

import { validateConfiguration } from './configuration';

describe('plugin configuration boundary', () => {
  it('resolves local refs and rejects mismatched data', async () => {
    const schema = {
      type: 'object',
      required: ['host'],
      properties: { host: { $ref: '#/$defs/host' } },
      $defs: { host: { type: 'string', minLength: 1 } },
    };
    expect(await validateConfiguration(schema, '{"host":"database"}')).toEqual({
      valid: true,
      value: { host: 'database' },
    });
    expect(await validateConfiguration(schema, '{"host":42}')).toEqual({
      valid: false,
      error: 'invalid-config',
    });
  });

  it('never fetches remote schema references', async () => {
    await expect(
      validateConfiguration({ $ref: 'https://untrusted.invalid/schema' }, '{}'),
    ).rejects.toThrow('External JSON Schema references');
  });

  it('rejects malformed or non-object configuration', async () => {
    expect(await validateConfiguration(true, '{')).toEqual({
      valid: false,
      error: 'invalid-json',
    });
    expect(await validateConfiguration(true, '[]')).toEqual({
      valid: false,
      error: 'invalid-object',
    });
    expect(await validateConfiguration(true, 'null')).toEqual({
      valid: false,
      error: 'invalid-object',
    });
  });

  it('treats UI annotations as data, not executable code', async () => {
    expect(
      await validateConfiguration(
        { type: 'object', 'x-ui': { script: 'throw new Error()' } },
        '{}',
      ),
    ).toEqual({ valid: true, value: {} });
  });

  it('validates required secret reference shapes locally without altering transmitted configuration', async () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['host', 'password'],
      properties: {
        host: { type: 'string' },
        password: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'name'],
          properties: { kind: { const: 'Secret' }, name: { type: 'string' } },
        },
      },
    };
    const references = JSON.stringify({
      password: { provider: 'vault', key: 'database/password', version: 'v3' },
    });
    expect(
      await validateConfiguration(schema, '{"host":"database"}', references),
    ).toEqual({ valid: true, value: { host: 'database' } });
    expect(await validateConfiguration(schema, '{"host":"database"}')).toEqual({
      valid: false,
      error: 'invalid-config',
    });
    await expect(
      validateConfiguration(
        schema,
        '{"host":"database","password":"inline"}',
        references,
      ),
    ).rejects.toThrow('overlap');
    expect(
      await validateConfiguration(
        {
          type: 'object',
          properties: { password: { type: 'string' } },
          additionalProperties: false,
        },
        '{}',
        references,
      ),
    ).toEqual({ valid: false, error: 'invalid-config' });
    expect(await validateConfiguration(schema, '{}', references)).toEqual({
      valid: false,
      error: 'invalid-config',
    });
  });
});
