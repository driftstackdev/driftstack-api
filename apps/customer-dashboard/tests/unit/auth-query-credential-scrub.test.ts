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

  it('the OAuth callback captures the fragment hand-off, strips it from the visible URL before any await, and only then looks up the flow record and redeems', () => {
    const source = readPage('auth/oauth-client/callback.astro');
    const capture = source.indexOf('const rawHash = window.location.hash;');
    const guard = source.indexOf('if (flowId && handoffCode) {', capture);
    const replace = source.indexOf(
      "window.history.replaceState(window.history.state, '', window.location.pathname);",
      guard,
    );
    const storageGuard = source.indexOf('if (!canPersistWebSession())', replace);
    const record = source.indexOf('takeOauthFlowRecord(flowId)', storageGuard);
    const request = source.indexOf("'/v1/auth/oauth-client/redeem'", record);

    expect(capture).toBeGreaterThanOrEqual(0);
    expect(capture).toBeLessThan(guard);
    expect(guard).toBeLessThan(replace);
    expect(replace).toBeLessThan(storageGuard);
    expect(storageGuard).toBeLessThan(record);
    expect(record).toBeLessThan(request);
    expect(source).not.toContain('window.history.pushState(');
    expect(source).not.toContain('window.location.reload(');
  });

  it('a retired-v1 ?code=&state= query arrival at the OAuth callback is scrubbed from the visible URL and never requested', () => {
    const source = readPage('auth/oauth-client/callback.astro');
    const capture = source.indexOf('const qs = window.location.search;');
    const guard = source.indexOf('if (qs && qs.length > 0) {', capture);
    const replace = source.indexOf(
      "window.history.replaceState(window.history.state, '', window.location.pathname);",
      guard,
    );

    expect(capture).toBeGreaterThanOrEqual(0);
    expect(capture).toBeLessThan(guard);
    expect(guard).toBeLessThan(replace);
    // The v1 exchange (GET /v1/auth/oauth-client/callback + PKCE cookie) was
    // retired 2026-09-14; the query carries the IDP's one-time code and must
    // leave history without ever being sent anywhere.
    expect(source).not.toContain("'/v1/auth/oauth-client/callback'");
    expect(source).not.toContain("credentials: 'include'");
  });

  it('fails its structural contract if token deletion is removed', () => {
    const source = readPage('verify-email.astro');
    expect(hasSameEntryTokenScrub(source.replace("params.delete('token');", ''))).toBe(false);
  });
});
