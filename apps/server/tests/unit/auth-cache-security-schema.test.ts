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

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  set(key: string, value: string): Promise<'OK'> {
    this.values.set(key, value);
    return Promise.resolve('OK');
  }

  mget(...keys: string[]): Promise<Array<string | null>> {
    this.mgetCalls += 1;
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
});
