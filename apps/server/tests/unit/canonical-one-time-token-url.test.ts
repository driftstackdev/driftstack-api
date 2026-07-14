import { describe, expect, it } from 'vitest';
import { canonicalOneTimeTokenUrl } from '../../src/lib/canonical-one-time-token-url.js';

describe('canonicalOneTimeTokenUrl', () => {
  it.each([
    'https://app.driftstack.dev/verify-email',
    'https://app.driftstack.dev/verify-email/',
    'https://app.driftstack.dev/verify-email///',
  ])('emits one canonical path slash for %s', (baseUrl) => {
    expect(canonicalOneTimeTokenUrl(baseUrl, 'tok_abc')).toBe(
      'https://app.driftstack.dev/verify-email/?token=tok_abc',
    );
  });

  it('URL-encodes the token without corrupting existing query or fragment state', () => {
    expect(
      canonicalOneTimeTokenUrl(
        'https://app.driftstack.dev/auth/magic-link?campaign=launch#continue',
        'token with + / & ?',
      ),
    ).toBe(
      'https://app.driftstack.dev/auth/magic-link/?campaign=launch&token=token+with+%2B+%2F+%26+%3F#continue',
    );
  });

  it('replaces an operator-supplied token parameter instead of duplicating it', () => {
    const result = canonicalOneTimeTokenUrl(
      'https://app.driftstack.dev/reset-password?token=stale&campaign=launch',
      'fresh',
    );
    expect(result).toBe('https://app.driftstack.dev/reset-password/?token=fresh&campaign=launch');
    expect(new URL(result).searchParams.getAll('token')).toEqual(['fresh']);
  });
});
