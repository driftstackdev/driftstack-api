import { describe, expect, it } from 'vitest';
import { parseUuidCursor } from '../../src/lib/keyset-cursor.js';

describe('parseUuidCursor — guards a raw-UUID keyset cursor before it hits a uuid column', () => {
  it('passes a well-formed UUID through unchanged (the form every next_cursor takes)', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(parseUuidCursor(id)).toBe(id);
  });

  it('accepts upper-case hex (PG uuid input is case-insensitive)', () => {
    const id = '550E8400-E29B-41D4-A716-446655440000';
    expect(parseUuidCursor(id)).toBe(id);
  });

  it('returns undefined for undefined (no cursor → first page)', () => {
    expect(parseUuidCursor(undefined)).toBeUndefined();
  });

  it('returns undefined for a non-UUID string → first page, NOT a uuid-cast 500', () => {
    for (const bad of [
      'garbage',
      '1; DROP TABLE accounts',
      '550e8400-e29b-41d4-a716', // too short
      '550e8400e29b41d4a716446655440000', // missing dashes
      'zzzzzzzz-e29b-41d4-a716-446655440000', // non-hex
      'psnap_550e8400-e29b-41d4-a716-446655440000', // prefixed (public id, not the bare uuid)
      ' 550e8400-e29b-41d4-a716-446655440000', // leading space
    ]) {
      expect(parseUuidCursor(bad), bad).toBeUndefined();
    }
  });
});
