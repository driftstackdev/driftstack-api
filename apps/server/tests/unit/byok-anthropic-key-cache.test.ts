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
});
