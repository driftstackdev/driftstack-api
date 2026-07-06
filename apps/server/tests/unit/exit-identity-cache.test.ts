// #128 — unit tests for InMemoryExitIdentityCache: the in-memory bridge from the
// create-time proxy probe's observed exit identity to the dispatch-time
// exit_identity emission (box new-tab IP panel). Keyed by (accountId, proxyId),
// bounded + TTL'd + LRU (mirrors InMemoryByokKeyCache), best-effort so a miss
// simply omits the optional block. Observable via size() for cache-pressure.

import { describe, expect, it } from 'vitest';
import { InMemoryExitIdentityCache } from '../../src/services/exit-identity-cache.js';
import type { ProbeExitIdentity } from '../../src/services/proxy-connectivity-probe.js';

const IDENTITY: ProbeExitIdentity = {
  ip: '203.0.113.7',
  country: 'US',
  region: 'California',
  city: 'San Jose',
  timezone: 'America/Los_Angeles',
};

describe('#128 InMemoryExitIdentityCache', () => {
  it('set + get round-trip preserves the exit identity verbatim and stamps probedAt', () => {
    const clock = 1_700_000_000_000;
    const cache = new InMemoryExitIdentityCache({ now: () => clock });
    cache.set('acc_1', 'prx_1', IDENTITY);
    const hit = cache.get('acc_1', 'prx_1');
    expect(hit).toBeDefined();
    expect(hit?.identity).toEqual(IDENTITY);
    // probedAt is the ISO of the set-time clock, not the get-time clock.
    expect(hit?.probedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('get on an unknown (accountId, proxyId) returns undefined (miss = optional block omitted)', () => {
    const cache = new InMemoryExitIdentityCache();
    expect(cache.get('acc_none', 'prx_none')).toBeUndefined();
  });

  it('keys by BOTH accountId and proxyId — same proxyId under a different account is a miss (tenant isolation)', () => {
    const cache = new InMemoryExitIdentityCache();
    cache.set('acc_A', 'prx_shared', IDENTITY);
    expect(cache.get('acc_A', 'prx_shared')?.identity).toEqual(IDENTITY);
    // A DIFFERENT account that happens to reference the same proxy id string
    // must not read account A's observed exit identity.
    expect(cache.get('acc_B', 'prx_shared')).toBeUndefined();
  });

  it('a space in an id cannot forge a collision across the two-part key', () => {
    const cache = new InMemoryExitIdentityCache();
    cache.set('acc', 'prx', IDENTITY);
    // 'acc prx' as accountId with '' proxyId must NOT collide with ('acc','prx').
    expect(cache.get('acc prx', '')).toBeUndefined();
    expect(cache.get('acc', 'prx')?.identity).toEqual(IDENTITY);
  });

  it('set on an existing key overwrites (a fresh launch re-probes the same proxy → newest exit wins)', () => {
    let clock = 1000;
    const cache = new InMemoryExitIdentityCache({ now: () => clock });
    cache.set('acc', 'prx', { ...IDENTITY, ip: '198.51.100.1' });
    clock += 5000;
    cache.set('acc', 'prx', { ...IDENTITY, ip: '203.0.113.9' });
    const hit = cache.get('acc', 'prx');
    expect(hit?.identity.ip).toBe('203.0.113.9');
    expect(hit?.probedAt).toBe(new Date(6000).toISOString());
  });

  it('preserves nullable geo fields (region/city/timezone) as null without coercion', () => {
    const cache = new InMemoryExitIdentityCache();
    const sparse: ProbeExitIdentity = {
      ip: '203.0.113.7',
      country: 'XX',
      region: null,
      city: null,
      timezone: null,
    };
    cache.set('acc', 'prx', sparse);
    expect(cache.get('acc', 'prx')?.identity).toEqual(sparse);
  });

  it('get returns undefined once an entry is past its TTL (a stale exit is never served) + lazily evicts it', () => {
    let clock = 1_000_000;
    const cache = new InMemoryExitIdentityCache({ ttlMs: 1000, now: () => clock });
    cache.set('acc', 'prx', IDENTITY);
    clock += 999;
    expect(cache.get('acc', 'prx')?.identity).toEqual(IDENTITY); // within TTL
    clock += 2; // 1001ms since set → expired
    expect(cache.get('acc', 'prx')).toBeUndefined();
    expect(cache.size()).toBe(0); // lazily evicted on the expired get
  });

  it('set() opportunistically sweeps expired entries so a never-read exit is FREED, not just hidden', () => {
    let clock = 0;
    const cache = new InMemoryExitIdentityCache({ ttlMs: 1000, now: () => clock });
    cache.set('acc', 'prx_stale', IDENTITY); // dispatch never fired for this create
    expect(cache.size()).toBe(1);
    clock += 2000; // past TTL
    cache.set('acc', 'prx_fresh', IDENTITY); // ANY later create sweeps the stale one
    expect(cache.get('acc', 'prx_stale')).toBeUndefined();
    expect(cache.size()).toBe(1); // only the fresh entry remains
  });

  it('LRU cap hard-bounds concurrent entries (oldest-inserted evicted on overflow)', () => {
    const cache = new InMemoryExitIdentityCache({ maxEntries: 2 });
    cache.set('acc', 'a', IDENTITY);
    cache.set('acc', 'b', IDENTITY);
    cache.set('acc', 'c', IDENTITY); // overflow → evict oldest ('acc a')
    expect(cache.size()).toBe(2);
    expect(cache.get('acc', 'a')).toBeUndefined();
    expect(cache.get('acc', 'b')?.identity).toEqual(IDENTITY);
    expect(cache.get('acc', 'c')?.identity).toEqual(IDENTITY);
  });

  it('re-setting a key refreshes its LRU recency so it is not the next eviction victim', () => {
    let clock = 0;
    const cache = new InMemoryExitIdentityCache({ maxEntries: 2, now: () => clock });
    cache.set('acc', 'a', IDENTITY);
    clock += 1;
    cache.set('acc', 'b', IDENTITY);
    clock += 1;
    cache.set('acc', 'a', IDENTITY); // touch 'a' → now most-recent
    clock += 1;
    cache.set('acc', 'c', IDENTITY); // overflow → evict oldest, which is now 'b'
    expect(cache.get('acc', 'b')).toBeUndefined();
    expect(cache.get('acc', 'a')?.identity).toEqual(IDENTITY);
    expect(cache.get('acc', 'c')?.identity).toEqual(IDENTITY);
  });

  it('size reflects current entries (test seam for cache-pressure observation)', () => {
    const cache = new InMemoryExitIdentityCache();
    expect(cache.size()).toBe(0);
    cache.set('acc', 'a', IDENTITY);
    cache.set('acc', 'b', IDENTITY);
    expect(cache.size()).toBe(2);
  });
});
