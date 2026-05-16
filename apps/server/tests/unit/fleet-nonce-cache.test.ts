// V-820 — InMemoryFleetNonceCache unit tests.

import { describe, expect, it } from 'vitest';
import { InMemoryFleetNonceCache } from '../../src/services/fleet-nonce-cache.js';

describe('V-820 InMemoryFleetNonceCache.checkAndRecord', () => {
  it('first time a (nodeId, nonce) pair is seen → true (records it)', async () => {
    const c = new InMemoryFleetNonceCache();
    expect(await c.checkAndRecord('node-1', 'abc', 300)).toBe(true);
  });

  it('replay within window → false', async () => {
    const c = new InMemoryFleetNonceCache();
    expect(await c.checkAndRecord('node-1', 'abc', 300)).toBe(true);
    expect(await c.checkAndRecord('node-1', 'abc', 300)).toBe(false);
  });

  it('same nonce across different nodeIds → independent (scope = (nodeId, nonce))', async () => {
    const c = new InMemoryFleetNonceCache();
    expect(await c.checkAndRecord('node-1', 'shared-nonce', 300)).toBe(true);
    expect(await c.checkAndRecord('node-2', 'shared-nonce', 300)).toBe(true);
  });

  it('after the TTL window expires, the pair is accepted again', async () => {
    let now = new Date('2026-05-16T00:00:00Z');
    const c = new InMemoryFleetNonceCache(() => now);
    expect(await c.checkAndRecord('node-1', 'abc', 300)).toBe(true);

    // Advance the clock past the TTL — entry evicts on the next call.
    now = new Date('2026-05-16T00:06:00Z');
    expect(await c.checkAndRecord('node-1', 'abc', 300)).toBe(true);
  });

  it('eviction runs on every checkAndRecord — size bounded after expiry', async () => {
    let now = new Date('2026-05-16T00:00:00Z');
    const c = new InMemoryFleetNonceCache(() => now);
    for (let i = 0; i < 50; i += 1) {
      await c.checkAndRecord('node-1', `nonce-${i.toString()}`, 60);
    }
    expect(c.size()).toBe(50);

    // Advance past TTL; a single call evicts all of them.
    now = new Date('2026-05-16T00:02:00Z');
    await c.checkAndRecord('node-1', 'new-nonce', 60);
    expect(c.size()).toBe(1);
  });

  it('NUL-byte delimiter prevents nodeId-nonce concat ambiguity (e.g. nodeId="a", nonce="bc" vs nodeId="ab", nonce="c" — both should be distinct entries)', async () => {
    const c = new InMemoryFleetNonceCache();
    expect(await c.checkAndRecord('a', 'bc', 300)).toBe(true);
    expect(await c.checkAndRecord('ab', 'c', 300)).toBe(true);
    // If the delimiter weren't NUL, "a" + "bc" === "ab" + "c" === "abc"
    // — both would collide. With NUL the keys are "a\x00bc" + "ab\x00c"
    // — distinct.
    expect(c.size()).toBe(2);
  });
});
