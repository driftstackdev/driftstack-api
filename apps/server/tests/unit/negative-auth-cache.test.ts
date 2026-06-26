// DoS hardening — negative auth-result cache. A flood of the SAME bogus
// bearer token must skip the prefix-lookup + scrypt verify after the
// first rejection. The cache remembers "this sha is invalid" for a short
// TTL, bounded in size, with an injectable clock.

import { describe, expect, it } from 'vitest';
import { InProcessNegativeAuthCache } from '../../src/services/negative-auth-cache.js';

describe('InProcessNegativeAuthCache', () => {
  it('returns false for an unknown sha', () => {
    const c = new InProcessNegativeAuthCache();
    expect(c.has('deadbeef')).toBe(false);
  });

  it('remembers a marked sha within the TTL', () => {
    let nowMs = 1_000_000;
    const c = new InProcessNegativeAuthCache({ ttlMs: 2000, now: () => nowMs });
    c.markInvalid('aa');
    expect(c.has('aa')).toBe(true);
    nowMs += 1999;
    expect(c.has('aa')).toBe(true);
  });

  it('expires an entry past its TTL (and evicts it on read)', () => {
    let nowMs = 0;
    const c = new InProcessNegativeAuthCache({ ttlMs: 2000, now: () => nowMs });
    c.markInvalid('bb');
    nowMs = 2001;
    expect(c.has('bb')).toBe(false);
    // The expired entry is evicted, not left to leak.
    expect(c.size()).toBe(0);
  });

  it('bounds the map size by FIFO-evicting the oldest entry on overflow', () => {
    const c = new InProcessNegativeAuthCache({ maxEntries: 3, ttlMs: 60_000 });
    c.markInvalid('a');
    c.markInvalid('b');
    c.markInvalid('c');
    expect(c.size()).toBe(3);
    // 4th insertion evicts the oldest ('a').
    c.markInvalid('d');
    expect(c.size()).toBe(3);
    expect(c.has('a')).toBe(false);
    expect(c.has('b')).toBe(true);
    expect(c.has('c')).toBe(true);
    expect(c.has('d')).toBe(true);
  });

  it('re-marking an existing sha refreshes its TTL + eviction priority', () => {
    let nowMs = 0;
    const c = new InProcessNegativeAuthCache({ maxEntries: 2, ttlMs: 1000, now: () => nowMs });
    c.markInvalid('x');
    c.markInvalid('y');
    nowMs = 500;
    // Re-mark x → it becomes the most-recent slot AND its TTL resets to now+1000.
    c.markInvalid('x');
    // Insert z → oldest (now 'y') is evicted, not the freshly-refreshed 'x'.
    c.markInvalid('z');
    expect(c.has('x')).toBe(true);
    expect(c.has('y')).toBe(false);
    expect(c.has('z')).toBe(true);
    // x's TTL was refreshed at now=500 → still alive at now=1499.
    nowMs = 1499;
    expect(c.has('x')).toBe(true);
  });
});
