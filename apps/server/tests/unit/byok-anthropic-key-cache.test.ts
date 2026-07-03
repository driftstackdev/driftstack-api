// Q.1.c — unit tests for InMemoryByokKeyCache (per-session plaintext
// stash). The cache is process-local, idempotent on delete, observable
// via size() for cache-pressure assertions.

import { describe, expect, it } from 'vitest';
import { InMemoryByokKeyCache } from '../../src/services/byok-anthropic-key-cache.js';

describe('Q.1.c InMemoryByokKeyCache', () => {
  it('set + get round-trip preserves the plaintext verbatim', () => {
    const cache = new InMemoryByokKeyCache();
    const SECRET = 'sk-ant-plaintext-NEVER-LEAK';
    cache.set('agt_inmem_xxx', SECRET);
    expect(cache.get('agt_inmem_xxx')).toBe(SECRET);
  });

  it('get on unknown session id returns undefined (miss = falsy, route falls through to fallback)', () => {
    const cache = new InMemoryByokKeyCache();
    expect(cache.get('agt_unknown')).toBeUndefined();
  });

  it('set on existing id overwrites (rare key-rotation-during-active-session edge case)', () => {
    const cache = new InMemoryByokKeyCache();
    cache.set('agt_x', 'first');
    cache.set('agt_x', 'second');
    expect(cache.get('agt_x')).toBe('second');
  });

  it('delete removes the entry (idempotent — safe to call twice)', () => {
    const cache = new InMemoryByokKeyCache();
    cache.set('agt_x', 'plaintext');
    cache.delete('agt_x');
    expect(cache.get('agt_x')).toBeUndefined();
    // Idempotent: second delete doesn't throw
    cache.delete('agt_x');
    expect(cache.get('agt_x')).toBeUndefined();
  });

  it('delete on unknown id is a no-op (safe for concurrent close paths — DELETE handler + runtime budget-exhausted close racing)', () => {
    const cache = new InMemoryByokKeyCache();
    cache.delete('agt_never_existed');
    expect(cache.size()).toBe(0);
  });

  it('size reflects current entries (test seam for cache-pressure observation)', () => {
    const cache = new InMemoryByokKeyCache();
    expect(cache.size()).toBe(0);
    cache.set('a', 'x');
    cache.set('b', 'y');
    expect(cache.size()).toBe(2);
    cache.delete('a');
    expect(cache.size()).toBe(1);
  });

  it('multiple sessions keep independent plaintexts (no cross-contamination)', () => {
    const cache = new InMemoryByokKeyCache();
    cache.set('agt_a', 'key-A');
    cache.set('agt_b', 'key-B');
    expect(cache.get('agt_a')).toBe('key-A');
    expect(cache.get('agt_b')).toBe('key-B');
    cache.delete('agt_a');
    expect(cache.get('agt_a')).toBeUndefined();
    expect(cache.get('agt_b')).toBe('key-B');
  });

  // audit wsihqzj39 — the cache must self-bound so a close path that misses
  // delete() (worker-initiated / reaper / sweeper terminal close) cannot retain
  // a decrypted plaintext key unbounded.
  it('get returns undefined once an entry is past its TTL (an aged plaintext key is never served) + lazily evicts it', () => {
    let clock = 1_000_000;
    const cache = new InMemoryByokKeyCache({ ttlMs: 1000, now: () => clock });
    cache.set('agt_ttl', 'plaintext');
    clock += 999;
    expect(cache.get('agt_ttl')).toBe('plaintext'); // still within TTL
    clock += 2; // 1001ms since set → expired
    expect(cache.get('agt_ttl')).toBeUndefined();
    expect(cache.size()).toBe(0); // lazily evicted on the expired get
  });

  it('set() opportunistically sweeps expired entries so a never-deleted (leaked) key is FREED, not just hidden', () => {
    let clock = 0;
    const cache = new InMemoryByokKeyCache({ ttlMs: 1000, now: () => clock });
    cache.set('agt_leaked', 'plaintext-never-deleted'); // close path forgot delete()
    expect(cache.size()).toBe(1);
    clock += 2000; // past TTL; the ended session never calls get/delete again
    cache.set('agt_fresh', 'new-session-key'); // ANY later session-create sweeps it
    expect(cache.get('agt_leaked')).toBeUndefined();
    expect(cache.size()).toBe(1); // only the fresh entry remains
  });

  it('LRU cap hard-bounds concurrent entries (oldest-inserted evicted on overflow)', () => {
    const cache = new InMemoryByokKeyCache({ maxEntries: 2 });
    cache.set('a', 'ka');
    cache.set('b', 'kb');
    cache.set('c', 'kc'); // overflow → evict oldest ('a')
    expect(cache.size()).toBe(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('kb');
    expect(cache.get('c')).toBe('kc');
  });
});
