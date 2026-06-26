// validateProfileName — the client-side pre-flight that mirrors the server's
// ProfileNameSchema, so a bad profile name shows a SPECIFIC message instead of
// the opaque "Validation Failed" the server's 422 maps to.

import { describe, expect, it } from 'vitest';
import { PROFILE_NAME_MESSAGE, validateProfileName } from '../../src/lib/profile-name';

describe('validateProfileName', () => {
  it('accepts valid names', () => {
    for (const name of [
      'a',
      'A1',
      'My Profile',
      'shopping_account-2',
      'work.profile',
      'iPhone 17 Pro',
      'x'.repeat(120),
    ]) {
      expect(validateProfileName(name)).toBeNull();
    }
  });

  it('reports empty / whitespace-only as "Name is required."', () => {
    expect(validateProfileName('')).toBe('Name is required.');
    expect(validateProfileName('   ')).toBe('Name is required.');
  });

  it('rejects names that violate the server schema with the specific message', () => {
    for (const name of [
      '-leading-hyphen',
      'trailing-dot.',
      ' .weird',
      'has@symbol',
      'emoji😀name',
      'tab\tname',
      'x'.repeat(121),
    ]) {
      expect(validateProfileName(name)).toBe(PROFILE_NAME_MESSAGE);
    }
  });

  it('validates against the TRIMMED value (matches the server .trim())', () => {
    // Surrounding whitespace is trimmed before the rule, so a valid core passes.
    expect(validateProfileName('  Valid Name  ')).toBeNull();
  });
});
