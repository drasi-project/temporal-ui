import { describe, expect, it } from 'vitest';

import { schemaHints } from './schema-hints';

describe('plugin schema UI hints', () => {
  it('only accepts bounded declarative text hints', () => {
    expect(
      schemaHints({
        'x-ui': {
          label: '<script>untrusted()</script>',
          helpText: 'Configure connection',
          script: 'untrusted()',
          widget: 'javascript',
          src: 'https://untrusted.invalid',
        },
      }),
    ).toEqual({
      label: '<script>untrusted()</script>',
      helpText: 'Configure connection',
    });
    expect(schemaHints({ 'x-ui': { label: 'a'.repeat(201) } })).toEqual({});
    expect(schemaHints(true)).toEqual({});
  });
});
