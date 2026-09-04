// Open-redirect guard for the dashboard `?next=` deep-link param. These are
// behavioural (not source-pin) tests: they exercise the actual bypass vectors
// so a future "simplification" to a regex can't silently reintroduce the
// open-redirect (login.astro / signup.astro navigate the result).

import { describe, expect, it } from 'vitest';
import { safeNextPath } from '../../src/lib/safe-next.js';

const ORIGIN = 'https://app.driftstack.io';

describe('safeNextPath — same-origin redirect guard', () => {
  it('keeps a legit same-origin relative path (with query + hash)', () => {
    expect(safeNextPath('/sessions', ORIGIN)).toBe('/sessions');
    expect(safeNextPath('/cli/authorize?code=abc&state=xyz#top', ORIGIN)).toBe(
      '/cli/authorize?code=abc&state=xyz#top',
    );
  });

  it('keeps a same-origin ABSOLUTE url, reduced to its relative path', () => {
    expect(safeNextPath(`${ORIGIN}/sessions?x=1`, ORIGIN)).toBe('/sessions?x=1');
  });

  it('refuses off-origin absolute urls → "/"', () => {
    expect(safeNextPath('https://evil.com', ORIGIN)).toBe('/');
    expect(safeNextPath('https://evil.com/phish', ORIGIN)).toBe('/');
    expect(safeNextPath('http://app.driftstack.io.evil.com', ORIGIN)).toBe('/');
  });

  it('refuses the classic string-sanitizer bypasses → "/"', () => {
    expect(safeNextPath('//evil.com', ORIGIN)).toBe('/'); // protocol-relative
    expect(safeNextPath('/\\evil.com', ORIGIN)).toBe('/'); // backslash → authority
    expect(safeNextPath('\\/\\/evil.com', ORIGIN)).toBe('/');
    expect(safeNextPath('javascript:alert(1)', ORIGIN)).toBe('/'); // non-http scheme
    // Same-origin URL whose PATHNAME is `//evil.com` / `/\evil.com` — would be
    // protocol-relative if returned verbatim; the //, /\ path-prefix guard
    // rejects it (this is the case the behavioural test caught vs a naive
    // startsWith('/') check).
    expect(safeNextPath(`${ORIGIN}//evil.com`, ORIGIN)).toBe('/');
    expect(safeNextPath(`${ORIGIN}/\\evil.com`, ORIGIN)).toBe('/');
  });

  it('a same-origin scheme-relative ref resolves to a same-origin path (safe)', () => {
    // `https:evil.com` shares the base scheme → resolved relative to the base
    // origin as /evil.com (navigates to app.driftstack.io/evil.com, NOT
    // evil.com); safe, so returned as the same-origin path rather than dropped.
    expect(safeNextPath('https:evil.com', ORIGIN)).toBe('/evil.com');
  });

  it('falls back to "/" for absent / empty / non-string', () => {
    expect(safeNextPath(null, ORIGIN)).toBe('/');
    expect(safeNextPath(undefined, ORIGIN)).toBe('/');
    expect(safeNextPath('', ORIGIN)).toBe('/');
  });

  it('a bare relative token resolves to a same-origin path (not off-site)', () => {
    // 'evil.com' (no scheme, no leading slash) → same-origin /evil.com, safe.
    expect(safeNextPath('evil.com', ORIGIN)).toBe('/evil.com');
  });
});
