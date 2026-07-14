import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = resolve(HERE, '..', '..', 'src', 'pages');

const tokenPages = [
  'verify-email.astro',
  'reset-password.astro',
  'auth/magic-link.astro',
  'auth/oauth-client/confirm-merge.astro',
];

function readPage(relativePath: string): string {
  return readFileSync(resolve(PAGES, relativePath), 'utf8');
}

function hasSameEntryTokenScrub(source: string): boolean {
  const capture = source.search(/const (?:linkToken|token) = params\.get\('token'\);/);
  const remove = source.indexOf("params.delete('token');", capture);
  const retain = source.indexOf('const retainedQuery = params.toString();', remove);
  const replace = source.indexOf('window.history.replaceState(', retain);
  const path = source.indexOf('window.location.pathname', replace);
  const query = source.indexOf("retainedQuery ? '?' + retainedQuery : ''", path);
  const hash = source.indexOf('window.location.hash', query);
  return (
    capture >= 0 &&
    capture < remove &&
    remove < retain &&
    retain < replace &&
    replace < path &&
    path < query &&
    query < hash
  );
}

describe('authentication query credential history scrubbing', () => {
  it.each(tokenPages)(
    '%s captures its token, removes only it, and replaces the same URL entry',
    (page) => {
      const source = readPage(page);
      expect(hasSameEntryTokenScrub(source)).toBe(true);
      expect(source).not.toContain('window.history.pushState(');
      expect(source).not.toContain('window.location.reload(');
    },
  );

  it('the OAuth callback captures the provider query before removing it from the visible URL', () => {
    const source = readPage('auth/oauth-client/callback.astro');
    const capture = source.indexOf('const qs = window.location.search;');
    const missingGuard = source.indexOf('if (!qs || qs.length === 0)', capture);
    const replace = source.indexOf('window.history.replaceState(', missingGuard);
    const storageGuard = source.indexOf('if (!canPersistWebSession())', replace);
    const request = source.indexOf("'/v1/auth/oauth-client/callback' + qs", storageGuard);

    expect(capture).toBeGreaterThanOrEqual(0);
    expect(capture).toBeLessThan(missingGuard);
    expect(missingGuard).toBeLessThan(replace);
    expect(replace).toBeLessThan(storageGuard);
    expect(storageGuard).toBeLessThan(request);
    expect(source).not.toContain('window.history.pushState(');
    expect(source).not.toContain('window.location.reload(');
  });

  it('fails its structural contract if token deletion is removed', () => {
    const source = readPage('verify-email.astro');
    expect(hasSameEntryTokenScrub(source.replace("params.delete('token');", ''))).toBe(false);
  });
});
