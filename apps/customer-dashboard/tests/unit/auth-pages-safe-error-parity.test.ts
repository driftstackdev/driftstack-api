import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const AUTH_PAGES = [
  'login.astro',
  'signup.astro',
  'verify-email.astro',
  'reset-password.astro',
  'auth/magic-link.astro',
  'auth/oauth-client/callback.astro',
] as const;

function readPage(relativePath: (typeof AUTH_PAGES)[number]): string {
  return readFileSync(
    resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages', relativePath),
    'utf8',
  );
}

describe('customer auth pages safe error-copy contract', () => {
  it.each(AUTH_PAGES)('%s uses the shared response and request error boundaries', (page) => {
    const source = readPage(page);

    expect(source).toContain('window.driftstackResponseError');
    expect(source).toContain('window.driftstackRequestErrorMessage');
    expect(source).not.toMatch(/err\s*&&\s*err\.message/);
    expect(source).not.toMatch(/new Error\((?:b|body|problem)\.detail/);
  });

  it('preserves login problem metadata without bypassing the response boundary', () => {
    const source = readPage('login.astro');

    expect(source).toContain('const err = window.driftstackResponseError(r, b);');
    expect(source).toContain('err.problemType = b.type;');
    expect(source).toContain('err.status = r.status;');
    expect(source).toContain('err.email = payload.email;');
  });

  it('marks only locally formatted signup validation issues as customer-safe', () => {
    const source = readPage('signup.astro');

    expect(source).toMatch(
      /specific\s*\?\s*Object\.assign\(new Error\(specific\), \{ customerSafe: true \}\)\s*:\s*window\.driftstackResponseError\(r, b\)/,
    );
  });
});
