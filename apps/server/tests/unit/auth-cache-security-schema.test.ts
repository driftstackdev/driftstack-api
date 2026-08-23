import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import type { AccountContext } from '../../src/services/auth.js';
import { RedisAuthCache, sha256Hex } from '../../src/services/auth-cache.js';

const TOKEN_SHA = sha256Hex('ds_live_auth_cache_security_schema_test');

function context(
  args: {
    provenance?: string | null;
    webSession?: AccountContext['webSession'];
  } = {},
): AccountContext {
  return {
    account: {
      id: 'acc-security',
      email: 'security@example.test',
      name: null,
      tier: 'api_builder',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    },
    apiKey: {
      id: 'key-security',
      accountId: 'acc-security',
      name: 'security-test',
      keyPrefix: 'ds_live_security',
      keyHash: 'scrypt-hash',
      scopes: ['read', 'write', 'account_owner'],
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: null,
      provenance: args.provenance,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    rateLimitOverrides: {},
    teams: [],
    webSession: args.webSession ?? null,
  };
}

class FakeRedis {
  readonly values = new Map<string, string>();
  mgetCalls = 0;
  /** Methods that should reject, standing in for a Redis that is reachable for
   *  some commands and failing for others — which is what a partial outage
   *  actually looks like. */
  readonly fail = new Set<'get' | 'mget' | 'incr' | 'del'>();
  readonly deleted: string[] = [];

  get(key: string): Promise<string | null> {
    if (this.fail.has('get')) return Promise.reject(new Error('redis down'));
    return Promise.resolve(this.values.get(key) ?? null);
  }

  incr(key: string): Promise<number> {
    if (this.fail.has('incr')) return Promise.reject(new Error('redis down'));
    const next = Number(this.values.get(key) ?? '0') + 1;
    this.values.set(key, String(next));
    return Promise.resolve(next);
  }

  set(key: string, value: string): Promise<'OK'> {
    this.values.set(key, value);
    return Promise.resolve('OK');
  }

  del(...keys: string[]): Promise<number> {
    if (this.fail.has('del')) return Promise.reject(new Error('redis down'));
    let removed = 0;
    for (const key of keys) {
      this.deleted.push(key);
      if (this.values.delete(key)) removed += 1;
    }
    return Promise.resolve(removed);
  }

  mget(...keys: string[]): Promise<Array<string | null>> {
    this.mgetCalls += 1;
    if (this.fail.has('mget')) return Promise.reject(new Error('redis down'));
    return Promise.resolve(keys.map((key) => this.values.get(key) ?? null));
  }
}

function makeCache(redis: FakeRedis): {
  cache: RedisAuthCache;
  warn: ReturnType<typeof vi.fn>;
} {
  const warn = vi.fn();
  const logger = { warn } as unknown as Logger;
  return {
    cache: new RedisAuthCache(redis as unknown as Redis, logger),
    warn,
  };
}

function entryKey(): string {
  return `auth:apikey:${TOKEN_SHA}`;
}

describe('RedisAuthCache security-sensitive schema compatibility', () => {
  it('writes a versioned envelope with explicit null provenance and auth kind', async () => {
    const redis = new FakeRedis();
    const { cache } = makeCache(redis);

    await cache.set(TOKEN_SHA, 'key-security', 'acc-security', context(), 30);

    const raw = redis.values.get(entryKey());
    expect(raw).toBeDefined();
    const stored = JSON.parse(raw ?? '{}') as {
      schemaVersion?: unknown;
      context?: { apiKey?: { provenance?: unknown }; webSession?: unknown };
    };
    expect(stored.schemaVersion).toBe(1);
    expect(stored.context?.apiKey).toHaveProperty('provenance', null);
    expect(stored.context).toHaveProperty('webSession', null);
    await expect(cache.get(TOKEN_SHA)).resolves.toMatchObject({
      apiKey: { provenance: null },
      webSession: null,
    });
  });

  it('preserves restricted device provenance and web-session MFA identity', async () => {
    const redis = new FakeRedis();
    const { cache } = makeCache(redis);
    const mfaSatisfiedAt = new Date('2026-07-13T12:00:00.000Z');

    await cache.set(
      TOKEN_SHA,
      'key-security',
      'acc-security',
      context({
        provenance: 'cli_device',
        webSession: { id: 'ws-security', mfaSatisfiedAt },
      }),
      30,
    );

    await expect(cache.get(TOKEN_SHA)).resolves.toMatchObject({
      apiKey: { provenance: 'cli_device' },
      webSession: { id: 'ws-security', mfaSatisfiedAt },
    });
  });

  it('tags a late write with its captured account and key generations', async () => {
    const redis = new FakeRedis();
    const { cache } = makeCache(redis);
    const captured = await cache.captureVersions('acc-security', 'key-security');
    expect(captured).toEqual({ accountVersion: 0, keyVersion: 0 });
    redis.values.set('auth:account:acc-security:v', '1');
    redis.values.set('auth:keyid:key-security:v', '1');

    await cache.set(
      TOKEN_SHA,
      'key-security',
      'acc-security',
      context(),
      30,
      captured ?? undefined,
    );

    const stored = JSON.parse(redis.values.get(entryKey()) ?? '{}') as {
      accountVersion?: unknown;
      keyVersion?: unknown;
    };
    expect(stored.accountVersion).toBe(0);
    expect(stored.keyVersion).toBe(0);
    await expect(cache.get(TOKEN_SHA)).resolves.toBeNull();
  });

  // V-247's key-generation gate, which is the REVOCATION backstop.
  //
  // `invalidateKey` normally deletes the entry outright via the reverse index, and
  // that path is covered. This gate is what still catches a revoked key when the
  // delete did NOT happen — and the cache's own contract makes that reachable:
  // "any Redis error during get/set/invalidate is logged and treated as a no-op".
  // A failed delete with a successful INCR leaves exactly this state.
  //
  // Coverage showed it had never fired: the account gate above it is checked first,
  // and the one existing arm that reaches this area bumps BOTH generations, so the
  // account gate returns null and execution never reaches the key gate. Evaluated
  // 7 times, taken 0.
  //
  // So this arm moves ONLY the key generation and asserts the account generation is
  // still absent — making the account gate incapable of producing the null, so the
  // refusal can only be the key gate. Without it a revoked key keeps authenticating
  // from cache until the 30s TTL expires.
  it('CRITICAL a cached entry whose KEY generation has moved is a miss even though the account generation still matches, because that is the backstop when invalidateKey deleted nothing', async () => {
    const redis = new FakeRedis();
    const { cache } = makeCache(redis);
    await cache.set(TOKEN_SHA, 'key-security', 'acc-security', context(), 30);
    await expect(
      cache.get(TOKEN_SHA),
      'precondition: a hit before the revocation, or the miss below proves nothing',
    ).resolves.not.toBeNull();

    // A revocation INCRs the key generation. The entry itself is left in place,
    // standing in for a delete that failed or never ran.
    redis.values.set('auth:keyid:key-security:v', '1');
    expect(
      redis.values.get('auth:account:acc-security:v'),
      'the account generation must stay absent, or the account gate could be the one refusing',
    ).toBeUndefined();
    expect(redis.values.get(entryKey()), 'the entry is still cached').toBeDefined();

    await expect(cache.get(TOKEN_SHA)).resolves.toBeNull();
  });

  it('CRITICAL a cached entry whose ACCOUNT generation has moved is a miss even though the key generation still matches — the mirror of the arm above', async () => {
    // The arm above isolates the KEY gate and is careful to keep the account
    // generation absent so the account gate cannot be the one refusing. Nobody
    // wrote the other direction, and it showed: neutering the ACCOUNT gate
    // (type-valid, so the compile guards could not answer) redded exactly ONE
    // test — the module's content-parity pin — while the same treatment of the
    // key gate redded the behavioural arm above.
    //
    // What the account gate carries is every account-level invalidation:
    // suspension, deletion, a tier change, a password-epoch bump. Without it a
    // suspended account keeps authenticating from cache until the TTL expires,
    // and the only thing that would have objected is a regex over this file's
    // source text.
    const redis = new FakeRedis();
    const { cache } = makeCache(redis);
    await cache.set(TOKEN_SHA, 'key-security', 'acc-security', context(), 30);
    await expect(
      cache.get(TOKEN_SHA),
      'precondition: a hit before the invalidation, or the miss below proves nothing',
    ).resolves.not.toBeNull();

    // An account-level invalidation INCRs the account generation, leaving the
    // entry in place — the same "the delete failed or never ran" shape.
    redis.values.set('auth:account:acc-security:v', '1');
    expect(
      redis.values.get('auth:keyid:key-security:v'),
      'the key generation must stay absent, or the KEY gate could be the one refusing',
    ).toBeUndefined();
    expect(redis.values.get(entryKey()), 'the entry is still cached').toBeDefined();

    await expect(cache.get(TOKEN_SHA)).resolves.toBeNull();
  });

  // The STRUCTURAL half of the same schema gate. `isCurrentCachedEntry` has eight
  // rungs; coverage showed only three had ever refused — schemaVersion, provenance
  // and the webSession own-property check. Those three are exactly the "legacy
  // ambiguity" cases the file reasons about in prose, so the author tested what they
  // were thinking about and the structural checks went untested.
  //
  // What they reject is a well-versioned envelope whose CONTEXT is malformed, which
  // is reachable from a `set()` bug or a tampered cache rather than from an old
  // deploy. Their fall-through is the dangerous kind: not a crash but an
  // `AccountContext` assembled from whatever was in Redis, handed to auth with
  // possibly-absent ids.
  //
  // Every case carries a CURRENT schemaVersion and valid generations, so the rungs
  // above cannot be what refuses; and each asserts `mgetCalls === 0`, which proves
  // the refusal happened in the schema gate BEFORE the account/key version reads —
  // otherwise a version gate could be doing the work and these rungs would stay as
  // unexercised as they were.
  const MALFORMED: Array<{ name: string; context: unknown; versions?: unknown }> = [
    {
      name: 'a non-integer generation',
      context: {
        account: { id: 'acc-security' },
        apiKey: { id: 'key-security', provenance: null },
        webSession: null,
      },
      versions: { accountVersion: 'not-a-number', keyVersion: 0 },
    },
    {
      name: 'an account that is not a record',
      context: {
        account: 'acc-security',
        apiKey: { id: 'key-security', provenance: null },
        webSession: null,
      },
    },
    {
      name: 'an account id that is not a string',
      context: {
        account: { id: 42 },
        apiKey: { id: 'key-security', provenance: null },
        webSession: null,
      },
    },
    {
      // `mfaSatisfiedAt: null` deliberately: with it absent, the NEXT rung
      // (mfaSatisfiedAt must be null or a number) rejects `undefined` and this arm
      // would pass with the id check disabled — proving nothing about the id check.
      name: 'a webSession whose id is not a string',
      context: {
        account: { id: 'acc-security' },
        apiKey: { id: 'key-security', provenance: null },
        webSession: { id: 42, mfaSatisfiedAt: null },
      },
    },
    {
      name: 'a webSession whose mfaSatisfiedAt is the wrong type',
      context: {
        account: { id: 'acc-security' },
        apiKey: { id: 'key-security', provenance: null },
        webSession: { id: 'sess-1', mfaSatisfiedAt: 1234 },
      },
    },
  ];

  for (const { name, context: ctx, versions } of MALFORMED) {
    it(`CRITICAL rejects a current-schema envelope carrying ${name}, before any version read`, async () => {
      const redis = new FakeRedis();
      const { cache } = makeCache(redis);
      redis.values.set(
        entryKey(),
        JSON.stringify({
          schemaVersion: 1,
          ...(versions ?? { accountVersion: 0, keyVersion: 0 }),
          context: ctx,
        }),
      );

      await expect(cache.get(TOKEN_SHA)).resolves.toBeNull();
      expect(
        redis.mgetCalls,
        'the schema gate must refuse before the version reads, or a version gate could be what refused',
      ).toBe(0);
    });
  }

  it('treats an unversioned legacy envelope as a miss before Redis version reads', async () => {
    const redis = new FakeRedis();
    const { cache, warn } = makeCache(redis);
    redis.values.set(
      entryKey(),
      JSON.stringify({
        context: {
          account: { id: 'acc-security' },
          apiKey: { id: 'key-security' },
          // Pre-C1 omitted provenance; pre-V353e omitted webSession.
        },
        accountVersion: 0,
        keyVersion: 0,
      }),
    );

    await expect(cache.get(TOKEN_SHA)).resolves.toBeNull();
    expect(redis.mgetCalls).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  type MutableEntry = {
    schemaVersion?: unknown;
    context: { apiKey: { provenance?: unknown }; webSession?: unknown };
  };

  it.each([
    ['missing provenance', (entry: MutableEntry) => delete entry.context.apiKey.provenance],
    ['missing webSession', (entry: MutableEntry) => delete entry.context.webSession],
    ['wrong schema version', (entry: MutableEntry) => (entry.schemaVersion = 2)],
  ])('rejects a current-looking envelope with %s', async (_label, mutate) => {
    const redis = new FakeRedis();
    const { cache } = makeCache(redis);
    await cache.set(TOKEN_SHA, 'key-security', 'acc-security', context(), 30);
    const entry = JSON.parse(redis.values.get(entryKey()) ?? '{}') as MutableEntry;
    mutate(entry);
    redis.values.set(entryKey(), JSON.stringify(entry));
    redis.mgetCalls = 0;

    await expect(cache.get(TOKEN_SHA)).resolves.toBeNull();
    expect(redis.mgetCalls).toBe(0);
  });
  // Redis is an ACCELERATOR for authentication, never its authority: every
  // command this cache issues is wrapped so a Redis outage degrades to the
  // scrypt path instead of failing the request. Making any of the three
  // catches rethrow reds nothing across the 9 auth-cache files and 117 tests,
  // because no fixture anywhere makes a Redis command fail.
  it('CRITICAL a failing Redis READ degrades to a miss rather than throwing', async () => {
    const redis = new FakeRedis();
    const { cache, warn } = makeCache(redis);
    redis.fail.add('get');

    await expect(cache.get(TOKEN_SHA)).resolves.toBeNull();
    expect(warn, 'the degrade is logged — it is the only signal Redis is down').toHaveBeenCalled();
  });

  it('CRITICAL a failing version READ skips the cache write instead of throwing', async () => {
    // captureVersions returning null is load-bearing beyond not throwing: the
    // slow path only writes when it captured both generations, so a null here
    // silently disables positive caching for that request. That is the correct
    // fail-safe — a write with unknown generations could outlive a revocation
    // — and it is also the exact mechanism that made a "broken cache" fixture
    // elsewhere in this suite never reach its own write.
    const redis = new FakeRedis();
    const { cache, warn } = makeCache(redis);
    redis.fail.add('mget');

    await expect(cache.captureVersions('acc-security', 'key-security')).resolves.toBeNull();
    expect(redis.mgetCalls, 'the read must be attempted').toBe(1);
    expect(warn).toHaveBeenCalled();
  });

  it('CRITICAL a failing INVALIDATION does not throw at the caller', async () => {
    // Revocation is authoritative in the database; this bump is what stops the
    // fast path serving a stale context before the TTL. It must not turn a
    // successful revoke into a failed one.
    const redis = new FakeRedis();
    const { cache, warn } = makeCache(redis);
    redis.fail.add('incr');

    await expect(cache.invalidateAccount('acc-security')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  // V-1386 — `RedisAuthCache.invalidateKey` had never executed. Its account-level sibling
  // is driven by the arm above and the in-memory double's copy is driven elsewhere, so the
  // file reads as though invalidation were covered — but the production key path, the one
  // revoke and rotate call, was dark.
  //
  // It is what makes a revoked key stop authenticating NOW instead of at TTL expiry. The
  // source names the ordering as load-bearing: bump the key generation FIRST so any
  // in-flight `set()` that captured the old value lands an entry the next `get()` reads as
  // stale, and only then drop the entry.
  it('CRITICAL invalidateKey bumps the key generation AND drops both cache rows. This is the path revoke and rotate take; without it a revoked key keeps authenticating from cache until its TTL runs out.', async () => {
    const redis = new FakeRedis();
    const { cache } = makeCache(redis);
    await cache.set(TOKEN_SHA, 'key-security', 'acc-security', context(), 30);
    expect(redis.values.get(entryKey()), 'the entry is cached before invalidation').toBeDefined();
    expect(redis.values.get('auth:keyid:key-security')).toBe(TOKEN_SHA);

    await cache.invalidateKey('key-security');

    expect(redis.values.get('auth:keyid:key-security:v'), 'the key generation moved').toBe('1');
    expect(redis.values.get(entryKey()), 'the cached context is gone').toBeUndefined();
    expect(
      redis.values.get('auth:keyid:key-security'),
      'and so is the reverse index',
    ).toBeUndefined();
  });

  it('CRITICAL the generation bump happens even when the reverse index has already expired. That lookup is how the entry is found, so skipping the bump when it misses would leave a live cached context authenticating a revoked key until TTL — the exact case the entry deletion cannot cover.', async () => {
    const redis = new FakeRedis();
    const { cache } = makeCache(redis);
    // Entry present, reverse index gone — what a partially-expired cache looks like.
    await cache.set(TOKEN_SHA, 'key-security', 'acc-security', context(), 30);
    redis.values.delete('auth:keyid:key-security');

    await cache.invalidateKey('key-security');

    expect(redis.values.get('auth:keyid:key-security:v'), 'the generation still moved').toBe('1');
  });

  it('CRITICAL a failing key INVALIDATION does not throw at the caller, matching its account-level sibling. Revocation is authoritative in the database; a Redis outage must not turn a successful revoke into a failed one.', async () => {
    const redis = new FakeRedis();
    const { cache, warn } = makeCache(redis);
    redis.fail.add('incr');

    await expect(cache.invalidateKey('key-security')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
