// Auth cache — amortises scrypt verification cost across the 30-second
// TTL window. Without this, every authenticated request re-runs scrypt
// (logN=15, ~50–100 ms on dev hardware), which dominated the API's p50/p99
// latency under load (V-010 finding 2).
//
// Security model (D-020):
//   - At-rest hash strength is preserved: scrypt logN=15 stays in
//     `lib/api-keys.ts`. The cache is a performance optimisation only.
//   - The cache key is `sha256(plaintext)` — a deterministic but
//     non-reversible mapping. Storing raw plaintext in cache would weaken
//     the security posture if Redis were compromised; storing only the
//     hash means a Redis dump alone doesn't yield usable plaintext keys.
//   - TTL is 30s. Customers are documented that key revocation takes effect
//     within 30s in the worst case. Most invalidations propagate
//     immediately via the explicit invalidate paths.
//   - Revocation triggers `invalidateKey(keyId)` immediately; the cached
//     entry is deleted via reverse-index lookup.
//   - Account tier / status changes trigger `invalidateAccount(accountId)`
//     which atomically increments an account-version counter; subsequent
//     `get()` reads detect the version mismatch and treat the cache as
//     missed (the stale entry then TTLs out cheaply).
//   - `expiresAt` is re-checked on every cache read (not just on cache
//     write) so a key cached just before its expiry doesn't leak past the
//     clock-bound deadline.
//   - Graceful degradation: any Redis error during get/set/invalidate is
//     logged and treated as a no-op. Auth still works (slower), service
//     stays up.

import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import type { Logger } from '../lib/logger.js';
import type { AccountContext } from './auth.js';

export interface AuthCache {
  /** Returns a cached context for this plaintext sha if one is fresh, else null. */
  get(plaintextSha256: string): Promise<AccountContext | null>;
  /** Cache the context; reverse-indexes by keyId for invalidation. */
  set(
    plaintextSha256: string,
    keyId: string,
    accountId: string,
    context: AccountContext,
    ttlSec: number,
  ): Promise<void>;
  /** Invalidate the cached entry for one specific API key (used by revocation). */
  invalidateKey(keyId: string): Promise<void>;
  /** Bump the account-version counter so all cached entries for the account miss on next read. */
  invalidateAccount(accountId: string): Promise<void>;
}

export function sha256Hex(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

// ───────────────────────────────────────────────────────────────────────────
// Serialisation — Date fields become ISO strings in transit.
// ───────────────────────────────────────────────────────────────────────────

interface SerializedAccount {
  id: string;
  email: string;
  name: string | null;
  tier: string;
  status: string;
  /** V-352 — optional. Pre-V-352 cache entries lack this; deserialize defaults to null. */
  timezone?: string | null;
  /** V-352b — optional. Pre-V-352b cache entries lack this; deserialize defaults to null. */
  avatarR2Key?: string | null;
  /** V-298a — optional. Pre-V-298a cache entries lack this; deserialize defaults to null. */
  slug?: string | null;
  /** V-298b — optional. Pre-V-298b cache entries lack this; deserialize defaults to null. */
  region?: 'us' | 'eu' | 'apac' | null;
  createdAt: string;
  updatedAt: string;
}

interface SerializedApiKey {
  id: string;
  accountId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  /** C1 — explicit even for ordinary keys. A missing field is security-
   *  ambiguous (ordinary key vs restricted CLI device key), so the cache
   *  envelope validator rejects legacy entries that omit it. */
  provenance: string | null;
  createdAt: string;
}

interface SerializedRateLimitOverride {
  bucketKey: string;
  capacity: number;
  refillPerSecond: number;
  expiresAt: string;
}

// V-326 — team membership entries serialized as plain JSON. Older
// pre-V-326 cache entries lack this field; deserialize() treats
// absence as an empty array (safe default — no implicit team grants).
// ownerEmail/ownerName are optional in the serialized shape: a pre-fix
// cache entry lacks them, and deserialize defaults email to the bare
// owner-id form + name to null until the 30s TTL refreshes the entry
// with the real values from the joined findTeamMemberships.
interface SerializedTeamMembership {
  membershipId: string;
  ownerAccountId: string;
  ownerEmail?: string;
  ownerName?: string | null;
  role: 'member' | 'admin';
}

interface SerializedContext {
  account: SerializedAccount;
  apiKey: SerializedApiKey;
  rateLimitOverrides: Record<string, SerializedRateLimitOverride>;
  teams?: SerializedTeamMembership[];
  /** V-353e — populated when the request authed via web session. Explicit
   *  null means API-key auth. Missing is ambiguous and makes the versioned
   *  cache envelope invalid rather than silently bypassing MFA step-up. */
  webSession: { id: string; mfaSatisfiedAt: string | null } | null;
}

const AUTH_CACHE_SCHEMA_VERSION = 1;

interface CachedEntry {
  /** Security-sensitive serialized-context contract. Entries from an older
   *  deploy are cache misses so newly added auth fields cannot inherit a
   *  permissive compatibility default. */
  schemaVersion: typeof AUTH_CACHE_SCHEMA_VERSION;
  context: SerializedContext;
  accountVersion: number;
  /**
   * V-247 / V-246-P0-001 — per-key version counter. Bumped on
   * revocation so an in-flight slow-path `set()` that captured the
   * pre-revoke version produces an entry that the next `get()`
   * detects as stale (currentKeyVersion !== entry.keyVersion). Closes
   * the API-key revocation cache window. The envelope schema version makes
   * this required: pre-V-247 entries miss and rebuild from the database.
   */
  keyVersion: number;
}

function serialize(ctx: AccountContext): SerializedContext {
  const overrides: Record<string, SerializedRateLimitOverride> = {};
  for (const [bucket, o] of Object.entries(ctx.rateLimitOverrides)) {
    overrides[bucket] = {
      bucketKey: o.bucketKey,
      capacity: o.capacity,
      refillPerSecond: o.refillPerSecond,
      expiresAt: o.expiresAt.toISOString(),
    };
  }
  return {
    account: {
      id: ctx.account.id,
      email: ctx.account.email,
      name: ctx.account.name,
      tier: ctx.account.tier,
      status: ctx.account.status,
      timezone: ctx.account.timezone,
      avatarR2Key: ctx.account.avatarR2Key,
      slug: ctx.account.slug,
      region: ctx.account.region,
      createdAt: ctx.account.createdAt.toISOString(),
      updatedAt: ctx.account.updatedAt.toISOString(),
    },
    apiKey: {
      id: ctx.apiKey.id,
      accountId: ctx.apiKey.accountId,
      name: ctx.apiKey.name,
      keyPrefix: ctx.apiKey.keyPrefix,
      keyHash: ctx.apiKey.keyHash,
      scopes: ctx.apiKey.scopes,
      lastUsedAt: ctx.apiKey.lastUsedAt ? ctx.apiKey.lastUsedAt.toISOString() : null,
      revokedAt: ctx.apiKey.revokedAt ? ctx.apiKey.revokedAt.toISOString() : null,
      expiresAt: ctx.apiKey.expiresAt ? ctx.apiKey.expiresAt.toISOString() : null,
      // Always write the field, including an explicit null for ordinary keys.
      provenance: ctx.apiKey.provenance ?? null,
      createdAt: ctx.apiKey.createdAt.toISOString(),
    },
    rateLimitOverrides: overrides,
    teams: ctx.teams.map((t) => ({
      membershipId: t.membershipId,
      ownerAccountId: t.ownerAccountId,
      ownerEmail: t.ownerEmail,
      ownerName: t.ownerName,
      role: t.role,
    })),
    webSession: ctx.webSession
      ? {
          id: ctx.webSession.id,
          mfaSatisfiedAt: ctx.webSession.mfaSatisfiedAt
            ? ctx.webSession.mfaSatisfiedAt.toISOString()
            : null,
        }
      : null,
  };
}

function deserialize(s: SerializedContext): AccountContext {
  const overrides: Record<string, AccountContext['rateLimitOverrides'][string]> = {};
  // Older serialised entries (pre-OT7) may not carry the rateLimitOverrides
  // field — treat absence as empty rather than throwing.
  if (s.rateLimitOverrides) {
    for (const [bucket, o] of Object.entries(s.rateLimitOverrides)) {
      overrides[bucket] = {
        bucketKey: o.bucketKey,
        capacity: o.capacity,
        refillPerSecond: o.refillPerSecond,
        expiresAt: new Date(o.expiresAt),
      };
    }
  }
  return {
    account: {
      id: s.account.id,
      email: s.account.email,
      name: s.account.name,
      tier: s.account.tier as AccountContext['account']['tier'],
      status: s.account.status as AccountContext['account']['status'],
      timezone: s.account.timezone ?? null,
      avatarR2Key: s.account.avatarR2Key ?? null,
      slug: s.account.slug ?? null,
      region: s.account.region ?? null,
      createdAt: new Date(s.account.createdAt),
      updatedAt: new Date(s.account.updatedAt),
    },
    apiKey: {
      id: s.apiKey.id,
      accountId: s.apiKey.accountId,
      name: s.apiKey.name,
      keyPrefix: s.apiKey.keyPrefix,
      keyHash: s.apiKey.keyHash,
      scopes: s.apiKey.scopes as AccountContext['apiKey']['scopes'],
      lastUsedAt: s.apiKey.lastUsedAt ? new Date(s.apiKey.lastUsedAt) : null,
      revokedAt: s.apiKey.revokedAt ? new Date(s.apiKey.revokedAt) : null,
      expiresAt: s.apiKey.expiresAt ? new Date(s.apiKey.expiresAt) : null,
      provenance: s.apiKey.provenance,
      createdAt: new Date(s.apiKey.createdAt),
    },
    rateLimitOverrides: overrides,
    teams: (s.teams ?? []).map((t) => ({
      membershipId: t.membershipId,
      ownerAccountId: t.ownerAccountId,
      // Pre-fix cache entries lack owner identity → fall back to the bare
      // owner-id form + null name; the 30s TTL refreshes with real values.
      ownerEmail: t.ownerEmail ?? `acc_${t.ownerAccountId}`,
      ownerName: t.ownerName ?? null,
      role: t.role,
    })),
    webSession: s.webSession
      ? {
          id: s.webSession.id,
          mfaSatisfiedAt: s.webSession.mfaSatisfiedAt
            ? new Date(s.webSession.mfaSatisfiedAt)
            : null,
        }
      : null,
  };
}

// ───────────────────────────────────────────────────────────────────────────
/**
 * Validate only the envelope fields needed before Redis version lookups and
 * deserialization. The cache is an optimization, so any ambiguity is a miss:
 * the ordinary authentication slow path reconstructs a fresh, fully typed
 * context from Postgres and repopulates the cache.
 */
function isCurrentCachedEntry(value: unknown): value is CachedEntry {
  if (!isRecord(value) || value.schemaVersion !== AUTH_CACHE_SCHEMA_VERSION) return false;
  if (!isNonNegativeInteger(value.accountVersion) || !isNonNegativeInteger(value.keyVersion)) {
    return false;
  }

  const context = value.context;
  if (!isRecord(context) || !isRecord(context.account) || !isRecord(context.apiKey)) return false;
  if (typeof context.account.id !== 'string' || typeof context.apiKey.id !== 'string') return false;

  // `undefined` is not equivalent to null for these two fields. Their absence
  // is precisely the legacy ambiguity this schema gate is designed to reject.
  const provenance = context.apiKey.provenance;
  if (provenance !== null && typeof provenance !== 'string') return false;
  if (!Object.hasOwn(context, 'webSession')) return false;
  const webSession = context.webSession;
  if (webSession !== null) {
    if (!isRecord(webSession) || typeof webSession.id !== 'string') return false;
    if (webSession.mfaSatisfiedAt !== null && typeof webSession.mfaSatisfiedAt !== 'string') {
      return false;
    }
  }

  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// Redis-backed implementation (production)
// ───────────────────────────────────────────────────────────────────────────

const KEY_ENTRY = (sha: string): string => `auth:apikey:${sha}`;
const KEY_REVERSE = (keyId: string): string => `auth:keyid:${keyId}`;
const KEY_ACCOUNT_VERSION = (accountId: string): string => `auth:account:${accountId}:v`;
// V-247 / V-246-P0-001 — per-key version counter. Bumped by
// invalidateKey(); checked by get(). Closes the revocation cache
// window where a slow-path set() could land a stale revokedAt=null
// entry after the revocation deleted the previous entry.
const KEY_KEY_VERSION = (keyId: string): string => `auth:keyid:${keyId}:v`;

export class RedisAuthCache implements AuthCache {
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {}

  async get(plaintextSha256: string): Promise<AccountContext | null> {
    try {
      const raw = await this.redis.get(KEY_ENTRY(plaintextSha256));
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      // Cache compatibility must fail closed to the authoritative slow path.
      // In particular, a legacy entry without provenance could otherwise turn
      // a restricted CLI device key into an ordinary key, while one without
      // webSession could turn a dashboard session into an MFA-exempt API key.
      if (!isCurrentCachedEntry(parsed)) return null;
      const entry = parsed;
      // One round-trip for both independent version counters (they depend only on
      // `entry`): collapse the two serial reads into a single MGET — 3 Redis RTTs
      // → 2 on the hottest path (every authed request; prod Redis is Upstash over
      // TLS, so RTT dominates). Trade-off: the key-version read now always executes
      // even when the account-version check below would short-circuit — one
      // redundant read only in the rare invalidation case, saving an RTT on every
      // cache HIT (the common case). [perf audit wb91zynsu]
      const [accountVersionRaw, keyVersionRaw] = await this.redis.mget(
        KEY_ACCOUNT_VERSION(entry.context.account.id),
        KEY_KEY_VERSION(entry.context.apiKey.id),
      );
      const currentAccountVersion = accountVersionRaw ? Number(accountVersionRaw) : 0;
      if (currentAccountVersion !== entry.accountVersion) return null;
      // V-247 — key-version gate. A revocation INCR makes the current value
      // diverge from the cached value → null → authoritative DB check.
      const currentKeyVersion = keyVersionRaw ? Number(keyVersionRaw) : 0;
      if (currentKeyVersion !== entry.keyVersion) return null;
      return deserialize(entry.context);
    } catch (err) {
      this.logger.warn({ err: errSummary(err) }, 'auth cache get failed; degrading to scrypt path');
      return null;
    }
  }

  async set(
    plaintextSha256: string,
    keyId: string,
    accountId: string,
    context: AccountContext,
    ttlSec: number,
  ): Promise<void> {
    try {
      // V-247 — capture both versions (account + key) at write time so
      // a subsequent `invalidateAccount` OR `invalidateKey` increments
      // the counter and the next `get()` detects the stale entry.
      const [accountVersionRaw, keyVersionRaw] = await Promise.all([
        this.redis.get(KEY_ACCOUNT_VERSION(accountId)),
        this.redis.get(KEY_KEY_VERSION(keyId)),
      ]);
      const accountVersion = accountVersionRaw ? Number(accountVersionRaw) : 0;
      const keyVersion = keyVersionRaw ? Number(keyVersionRaw) : 0;
      const entry: CachedEntry = {
        schemaVersion: AUTH_CACHE_SCHEMA_VERSION,
        context: serialize(context),
        accountVersion,
        keyVersion,
      };
      const ttlMs = ttlSec * 1000;
      await Promise.all([
        this.redis.set(KEY_ENTRY(plaintextSha256), JSON.stringify(entry), 'PX', ttlMs),
        // Reverse-index so revocation can find the cache entry by keyId.
        this.redis.set(KEY_REVERSE(keyId), plaintextSha256, 'PX', ttlMs),
      ]);
    } catch (err) {
      this.logger.warn({ err: errSummary(err) }, 'auth cache set failed; continuing');
    }
  }

  async invalidateKey(keyId: string): Promise<void> {
    try {
      // V-247 — INCR the key-version counter FIRST (atomic in Redis); any
      // in-flight `set()` that captured the pre-INCR value will land an
      // entry the next `get()` detects as stale. Then drop the existing
      // entry so the next request takes the slow path immediately rather
      // than waiting for a TTL expiry. Both ops are best-effort; the
      // INCR is the load-bearing one for race resolution.
      const sha = await this.redis.get(KEY_REVERSE(keyId));
      const ops: Array<Promise<unknown>> = [
        this.redis.incr(KEY_KEY_VERSION(keyId)),
        this.redis.del(KEY_REVERSE(keyId)),
      ];
      if (sha) ops.push(this.redis.del(KEY_ENTRY(sha)));
      await Promise.all(ops);
    } catch (err) {
      this.logger.warn({ err: errSummary(err) }, 'auth cache invalidateKey failed');
    }
  }

  async invalidateAccount(accountId: string): Promise<void> {
    try {
      await this.redis.incr(KEY_ACCOUNT_VERSION(accountId));
    } catch (err) {
      this.logger.warn({ err: errSummary(err) }, 'auth cache invalidateAccount failed');
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// In-memory implementation (tests)
// ───────────────────────────────────────────────────────────────────────────

interface MemEntry {
  context: AccountContext;
  accountVersion: number;
  /** V-247 — key-version captured at set time; mirrors Redis impl. */
  keyVersion: number;
  expiresAtMs: number;
}

export class InMemoryAuthCache implements AuthCache {
  private readonly entries = new Map<string, MemEntry>();
  private readonly reverse = new Map<string, string>();
  private readonly accountVersions = new Map<string, number>();
  // V-247 — mirror Redis key-version counter.
  private readonly keyVersions = new Map<string, number>();

  get(plaintextSha256: string): Promise<AccountContext | null> {
    const entry = this.entries.get(plaintextSha256);
    if (!entry) return Promise.resolve(null);
    if (entry.expiresAtMs <= Date.now()) {
      this.entries.delete(plaintextSha256);
      return Promise.resolve(null);
    }
    const currentAccountVersion = this.accountVersions.get(entry.context.account.id) ?? 0;
    if (currentAccountVersion !== entry.accountVersion) return Promise.resolve(null);
    // V-247 — key-version gate.
    const currentKeyVersion = this.keyVersions.get(entry.context.apiKey.id) ?? 0;
    if (currentKeyVersion !== entry.keyVersion) return Promise.resolve(null);
    return Promise.resolve(entry.context);
  }

  set(
    plaintextSha256: string,
    keyId: string,
    accountId: string,
    context: AccountContext,
    ttlSec: number,
  ): Promise<void> {
    const accountVersion = this.accountVersions.get(accountId) ?? 0;
    const keyVersion = this.keyVersions.get(keyId) ?? 0;
    this.entries.set(plaintextSha256, {
      context,
      accountVersion,
      keyVersion,
      expiresAtMs: Date.now() + ttlSec * 1000,
    });
    this.reverse.set(keyId, plaintextSha256);
    return Promise.resolve();
  }

  invalidateKey(keyId: string): Promise<void> {
    // V-247 — INCR key-version FIRST so any in-flight set() that
    // captured the pre-INCR value lands a stale entry. Then drop
    // the existing entry for fast-path eviction.
    const cur = this.keyVersions.get(keyId) ?? 0;
    this.keyVersions.set(keyId, cur + 1);
    const sha = this.reverse.get(keyId);
    if (sha) this.entries.delete(sha);
    this.reverse.delete(keyId);
    return Promise.resolve();
  }

  invalidateAccount(accountId: string): Promise<void> {
    const cur = this.accountVersions.get(accountId) ?? 0;
    this.accountVersions.set(accountId, cur + 1);
    return Promise.resolve();
  }

  /** Test helper: report the entry count. */
  size(): number {
    return this.entries.size;
  }
}

// ───────────────────────────────────────────────────────────────────────────

function errSummary(err: unknown): {
  name?: string;
  message?: string;
  stack?: string;
  cause?: unknown;
} {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack, cause: err.cause };
  }
  return { message: String(err) };
}
