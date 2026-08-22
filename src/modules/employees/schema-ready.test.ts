import { describe, expect, it } from 'vitest';
import { schemaMissingError } from '../organization/schema-ready';

describe('schemaMissingError', () => {
  it('detects PostgREST PGRST205 messages', () => {
    expect(
      schemaMissingError("Could not find the table 'public.employees' in the schema cache"),
    ).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(schemaMissingError('Invalid login credentials')).toBe(false);
  });
});
