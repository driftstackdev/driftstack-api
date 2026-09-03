// #128 — unit tests for InMemoryExitIdentityCache: the in-memory bridge from the
// create-time proxy probe's observed exit identity to the dispatch-time
// exit_identity emission (box new-tab IP panel). Keyed by (accountId, proxyId),
// bounded + TTL'd + LRU (mirrors InMemoryByokKeyCache), best-effort so a miss
// simply omits the optional block. Observable via size() for cache-pressure.

import { describe, expect, it } from 'vitest';
import {
  InMemoryExitIdentityCache,
  RedisExitIdentityStore,
  exitIdentityRedisKey,
} from '../../src/services/exit-identity-cache.js';
import type { ProbeExitIdentity } from '../../src/services/proxy-connectivity-probe.js';

const IDENTITY: ProbeExitIdentity = {
  ip: '203.0.113.7',
  country: 'US',
  region: 'California',
  city: 'San Jose',
  timezone: 'America/Los_Angeles',
};

describe('#128 InMemoryExitIdentityCache', () => {
  it('set + get round-trip preserves the exit identity verbatim and stamps probedAt', async () => {
    const clock = 1_700_000_000_000;
    const cache = new InMemoryExitIdentityCache({ now: () => clock });
    await cache.set('acc_1', 'prx_1', IDENTITY);
    const hit = await cache.get('acc_1', 'prx_1');
    expect(hit).toBeDefined();
    expect(hit?.identity).toEqual(IDENTITY);
    // probedAt is the ISO of the set-time clock, not the get-time clock.
    expect(hit?.probedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('get on an unknown (accountId, proxyId) returns undefined (miss = optional block omitted)', async () => {
    const cache = new InMemoryExitIdentityCache();
    expect(await cache.get('acc_none', 'prx_none')).toBeUndefined();
  });

  it('keys by BOTH accountId and proxyId — same proxyId under a different account is a miss (tenant isolation)', async () => {
    const cache = new InMemoryExitIdentityCache();
    await cache.set('acc_A', 'prx_shared', IDENTITY);
    expect((await cache.get('acc_A', 'prx_shared'))?.identity).toEqual(IDENTITY);
    // A DIFFERENT account that happens to reference the same proxy id string
    // must not read account A's observed exit identity.
    expect(await cache.get('acc_B', 'prx_shared')).toBeUndefined();
  });

  it('a space in an id cannot forge a collision across the two-part key', async () => {
    const cache = new InMemoryExitIdentityCache();
    await cache.set('acc', 'prx', IDENTITY);
    // 'acc prx' as accountId with '' proxyId must NOT collide with ('acc','prx').
    expect(await cache.get('acc prx', '')).toBeUndefined();
    expect((await cache.get('acc', 'prx'))?.identity).toEqual(IDENTITY);
  });

  it('set on an existing key overwrites (a fresh launch re-probes the same proxy → newest exit wins)', async () => {
    let clock = 1000;
    const cache = new InMemoryExitIdentityCache({ now: () => clock });
    await cache.set('acc', 'prx', { ...IDENTITY, ip: '198.51.100.1' });
    clock += 5000;
    await cache.set('acc', 'prx', { ...IDENTITY, ip: '203.0.113.9' });
    const hit = await cache.get('acc', 'prx');
    expect(hit?.identity.ip).toBe('203.0.113.9');
    expect(hit?.probedAt).toBe(new Date(6000).toISOString());
  });

  it('preserves nullable geo fields (region/city/timezone) as null without coercion', async () => {
    const cache = new InMemoryExitIdentityCache();
    const sparse: ProbeExitIdentity = {
      ip: '203.0.113.7',
      country: 'XX',
      region: null,
      city: null,
      timezone: null,
    };
    await cache.set('acc', 'prx', sparse);
    expect((await cache.get('acc', 'prx'))?.identity).toEqual(sparse);
  });

  it('get returns undefined once an entry is past its TTL (a stale exit is never served) + lazily evicts it', async () => {
    let clock = 1_000_000;
    const cache = new InMemoryExitIdentityCache({ ttlMs: 1000, now: () => clock });
    await cache.set('acc', 'prx', IDENTITY);
    clock += 999;
    expect((await cache.get('acc', 'prx'))?.identity).toEqual(IDENTITY); // within TTL
    clock += 2; // 1001ms since set → expired
    expect(await cache.get('acc', 'prx')).toBeUndefined();
    expect(cache.size()).toBe(0); // lazily evicted on the expired get
  });

  it('set() opportunistically sweeps expired entries so a never-read exit is FREED, not just hidden', async () => {
    let clock = 0;
    const cache = new InMemoryExitIdentityCache({ ttlMs: 1000, now: () => clock });
    await cache.set('acc', 'prx_stale', IDENTITY); // dispatch never fired for this create
    expect(cache.size()).toBe(1);
    clock += 2000; // past TTL
    await cache.set('acc', 'prx_fresh', IDENTITY); // ANY later create sweeps the stale one
    expect(await cache.get('acc', 'prx_stale')).toBeUndefined();
    expect(cache.size()).toBe(1); // only the fresh entry remains
  });

  it('LRU cap hard-bounds concurrent entries (oldest-inserted evicted on overflow)', async () => {
    const cache = new InMemoryExitIdentityCache({ maxEntries: 2 });
    await cache.set('acc', 'a', IDENTITY);
    await cache.set('acc', 'b', IDENTITY);
    await cache.set('acc', 'c', IDENTITY); // overflow → evict oldest ('acc a')
    expect(cache.size()).toBe(2);
    expect(await cache.get('acc', 'a')).toBeUndefined();
    expect((await cache.get('acc', 'b'))?.identity).toEqual(IDENTITY);
    expect((await cache.get('acc', 'c'))?.identity).toEqual(IDENTITY);
  });

  it('re-setting a key refreshes its LRU recency so it is not the next eviction victim', async () => {
    let clock = 0;
    const cache = new InMemoryExitIdentityCache({ maxEntries: 2, now: () => clock });
    await cache.set('acc', 'a', IDENTITY);
    clock += 1;
    await cache.set('acc', 'b', IDENTITY);
    clock += 1;
    await cache.set('acc', 'a', IDENTITY); // touch 'a' → now most-recent
    clock += 1;
    await cache.set('acc', 'c', IDENTITY); // overflow → evict oldest, which is now 'b'
    expect(await cache.get('acc', 'b')).toBeUndefined();
    expect((await cache.get('acc', 'a'))?.identity).toEqual(IDENTITY);
    expect((await cache.get('acc', 'c'))?.identity).toEqual(IDENTITY);
  });

  it('size reflects current entries (test seam for cache-pressure observation)', async () => {
    const cache = new InMemoryExitIdentityCache();
    expect(cache.size()).toBe(0);
    await cache.set('acc', 'a', IDENTITY);
    await cache.set('acc', 'b', IDENTITY);
    expect(cache.size()).toBe(2);
  });
});

// #128 follow-up — the Redis-backed store. The in-memory bridge is process-local,
// and a miss is not a degraded panel for one request: the exit identity is baked
// into the box fork's environment ONCE at launch, so a single dispatch-time miss
// leaves every new tab in that session reading "No exit IP" for its whole life.
describe('#128 RedisExitIdentityStore', () => {
  function fakeRedis() {
    const map = new Map<string, string>();
    return {
      map,
      calls: [] as unknown[][],
      // eslint-disable-next-line @typescript-eslint/require-await
      async get(key: string) {
        return map.get(key) ?? null;
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async set(key: string, value: string, ex: string, ttl: number) {
        this.calls.push([key, value, ex, ttl]);
        map.set(key, value);
      },
    };
  }

  it('set + get round-trip preserves the identity verbatim and stamps probedAt', async () => {
    const redis = fakeRedis();
    const store = new RedisExitIdentityStore(redis as never);
    await store.set('acc_1', 'prx_1', IDENTITY);
    const hit = await store.get('acc_1', 'prx_1');
    expect(hit?.identity).toEqual(IDENTITY);
    expect(typeof hit?.probedAt).toBe('string');
  });

  it('writes with an EX expiry so a stale exit cannot outlive its window', async () => {
    const redis = fakeRedis();
    await new RedisExitIdentityStore(redis as never, { ttlMs: 15 * 60 * 1000 }).set(
      'acc',
      'prx',
      IDENTITY,
    );
    const [, , ex, ttl] = redis.calls[0] as [string, string, string, number];
    expect(ex).toBe('EX');
    expect(ttl).toBe(900);
  });

  // Mirrors the in-memory NUL-separator arm: the two-part key must not be forgeable
  // by an id that contains the separator, or one tenant reads another's exit.
  it('a colon in an id cannot forge a collision across the two-part key', async () => {
    const redis = fakeRedis();
    const store = new RedisExitIdentityStore(redis as never);
    // These two pairs concatenate to the SAME string without a length prefix
    // ('a' + ':' + 'b:c'  ==  'a:b' + ':' + 'c'), which is what makes this a real
    // forgery case rather than one that merely differs by a trailing separator.
    expect(exitIdentityRedisKey('a', 'b:c')).not.toBe(exitIdentityRedisKey('a:b', 'c'));
    await store.set('a', 'b:c', IDENTITY);
    // Tenant 'a:b' must NOT read tenant 'a''s observed exit identity.
    expect(await store.get('a:b', 'c')).toBeUndefined();
    expect(await store.get('a', 'b:c')).toBeDefined();
  });

  it('a malformed payload is a MISS, never a throw and never a partial identity', async () => {
    const redis = fakeRedis();
    const store = new RedisExitIdentityStore(redis as never);
    const bads = [
      'not json',
      '{}',
      '{"identity":{},"at":1}',
      '{"identity":{"ip":"1.2.3.4"}}', // no `at`
      // Reaches the country check specifically: ip and at are BOTH valid, so the
      // earlier arms cannot mask it. Without this case the country guard could be
      // deleted and every other case would still pass.
      '{"identity":{"ip":"1.2.3.4","region":null},"at":1700000000000}',
    ];
    for (const bad of bads) {
      redis.map.set(exitIdentityRedisKey('acc', 'prx'), bad);
      // A half-populated block would be rendered by the box as authoritative.
      expect(await store.get('acc', 'prx')).toBeUndefined();
    }
  });

  it('an unreachable Redis is a miss on read and a no-op on write — a launch is never failed by it', async () => {
    const broken = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async get() {
        throw new Error('ECONNREFUSED');
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async set() {
        throw new Error('ECONNREFUSED');
      },
    };
    const store = new RedisExitIdentityStore(broken as never);
    await expect(store.set('acc', 'prx', IDENTITY)).resolves.toBeUndefined();
    await expect(store.get('acc', 'prx')).resolves.toBeUndefined();
  });

  // The wire schema is strict (country exactly 2 chars; region/city/timezone
  // min(1)-or-null) and serializeSessionAssign THROWS on a violation, which would
  // fail the session launch over the new-tab panel. A value read back from Redis
  // must therefore be validated, not merely parsed.
  it('never returns a value the strict wire schema would reject — an empty geo field becomes null', async () => {
    const redis = fakeRedis();
    const store = new RedisExitIdentityStore(redis as never);
    redis.map.set(
      exitIdentityRedisKey('acc', 'prx'),
      JSON.stringify({
        identity: { ip: '203.0.113.7', country: 'US', region: '', city: '', timezone: '' },
        at: 1700000000000,
      }),
    );
    const hit = await store.get('acc', 'prx');
    expect(hit?.identity.region).toBeNull();
    expect(hit?.identity.city).toBeNull();
    expect(hit?.identity.timezone).toBeNull();
  });

  it('a country that is not exactly two letters is a MISS, not a launch-failing block', async () => {
    const redis = fakeRedis();
    const store = new RedisExitIdentityStore(redis as never);
    for (const bad of ['USA', '', 'us', 'U1']) {
      redis.map.set(
        exitIdentityRedisKey('acc', 'prx'),
        JSON.stringify({ identity: { ip: '203.0.113.7', country: bad }, at: 1700000000000 }),
      );
      expect(await store.get('acc', 'prx')).toBeUndefined();
    }
  });

  it('preserves nullable geo fields as null rather than dropping or coercing them', async () => {
    const redis = fakeRedis();
    const store = new RedisExitIdentityStore(redis as never);
    const sparse = { ip: '203.0.113.7', country: 'XX', region: null, city: null, timezone: null };
    await store.set('acc', 'prx', sparse);
    expect((await store.get('acc', 'prx'))?.identity).toEqual(sparse);
  });

  it('T-11: keeps range-valid exit coordinates across the read, and DROPS an out-of-range one (never a bogus 0,0 the box would spoof to)', async () => {
    const redis = fakeRedis();
    const store = new RedisExitIdentityStore(redis as never);
    await store.set('acc', 'prx', {
      ip: '203.0.113.7',
      country: 'NL',
      region: 'Noord-Holland',
      city: 'Amsterdam',
      timezone: 'Europe/Amsterdam',
      lat: 52.37,
      lon: 4.9,
    });
    expect((await store.get('acc', 'prx'))?.identity).toMatchObject({ lat: 52.37, lon: 4.9 });
    // A read-side trust boundary: an out-of-range latitude degrades to ABSENT,
    // not to a stored bogus value the geolocation derivation would then spoof to.
    await store.set('acc', 'prx2', {
      ip: '203.0.113.8',
      country: 'NL',
      region: null,
      city: null,
      timezone: null,
      lat: 999,
      lon: 4.9,
    });
    const got = (await store.get('acc', 'prx2'))?.identity;
    expect(got).not.toHaveProperty('lat');
    expect(got?.lon).toBe(4.9);
  });
});
