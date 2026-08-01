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

// V-730 — the credential lifecycle has to be able to REACH the plaintext this
// cache hands to open agent sessions.
//
// The cache was keyed only by agent-session id and populated once at
// session-create. `DELETE /v1/account/me/byok-anthropic-key` flipped `has_key`
// to false and every already-open session kept transmitting the CLEARED key to
// Anthropic until the session closed or the 13h TTL lapsed — a clear that did
// not revoke. Rotation had the mirror problem: a `PUT` never reached a session
// that was already open, which kept using the OLD key for the rest of its life.
describe('V-730 InMemoryByokKeyCache.deleteByAccount', () => {
  it('evicts every live entry belonging to the account and leaves other accounts alone', () => {
    const cache = new InMemoryByokKeyCache();
    cache.set('sess_a1', 'sk-ant-A', 'acc_a');
    cache.set('sess_a2', 'sk-ant-A', 'acc_a');
    cache.set('sess_b1', 'sk-ant-B', 'acc_b');

    expect(cache.deleteByAccount('acc_a')).toBe(2);

    expect(cache.get('sess_a1')).toBeUndefined();
    expect(cache.get('sess_a2')).toBeUndefined();
    // A revocation on one tenant must never disturb another's live sessions.
    expect(cache.get('sess_b1')).toBe('sk-ant-B');
  });

  it('is idempotent and reports zero for an account with nothing cached', () => {
    const cache = new InMemoryByokKeyCache();
    cache.set('sess_a1', 'sk-ant-A', 'acc_a');
    expect(cache.deleteByAccount('acc_a')).toBe(1);
    expect(cache.deleteByAccount('acc_a')).toBe(0);
    expect(cache.deleteByAccount('acc_never_seen')).toBe(0);
  });

  it('does not leak the account index when entries leave by other routes', () => {
    // delete(), TTL expiry and LRU eviction all have to keep the index honest,
    // or deleteByAccount would later report evictions it did not perform — and
    // an operator reading that count would believe a revocation reached
    // sessions it never touched.
    let clock = 0;
    const cache = new InMemoryByokKeyCache({ ttlMs: 1_000, now: () => clock });
    cache.set('sess_1', 'sk-ant-A', 'acc_a');
    cache.delete('sess_1');
    expect(cache.deleteByAccount('acc_a')).toBe(0);

    cache.set('sess_2', 'sk-ant-A', 'acc_a');
    clock = 5_000; // past the TTL
    expect(cache.get('sess_2')).toBeUndefined(); // lazily evicted here
    expect(cache.deleteByAccount('acc_a')).toBe(0);
  });

  it('still accepts an untagged set (no accountId) without breaking eviction', () => {
    // The parameter is optional so existing callers compile; an untagged entry
    // simply cannot be reached by account, which is the pre-V-730 behaviour.
    const cache = new InMemoryByokKeyCache();
    cache.set('sess_legacy', 'sk-ant-L');
    expect(cache.deleteByAccount('acc_a')).toBe(0);
    expect(cache.get('sess_legacy')).toBe('sk-ant-L');
  });
});
