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
  createdAt: string;
}

interface SerializedContext {
  account: SerializedAccount;
  apiKey: SerializedApiKey;
}

interface CachedEntry {
  context: SerializedContext;
  accountVersion: number;
}

function serialize(ctx: AccountContext): SerializedContext {
  return {
    account: {
      id: ctx.account.id,
      email: ctx.account.email,
      name: ctx.account.name,
      tier: ctx.account.tier,
      status: ctx.account.status,
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
      createdAt: ctx.apiKey.createdAt.toISOString(),
    },
  };
}

function deserialize(s: SerializedContext): AccountContext {
  return {
    account: {
      id: s.account.id,
      email: s.account.email,
      name: s.account.name,
      tier: s.account.tier as AccountContext['account']['tier'],
      status: s.account.status as AccountContext['account']['status'],
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
      createdAt: new Date(s.apiKey.createdAt),
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Redis-backed implementation (production)
// ───────────────────────────────────────────────────────────────────────────

const KEY_ENTRY = (sha: string): string => `auth:apikey:${sha}`;
const KEY_REVERSE = (keyId: string): string => `auth:keyid:${keyId}`;
const KEY_ACCOUNT_VERSION = (accountId: string): string => `auth:account:${accountId}:v`;

export class RedisAuthCache implements AuthCache {
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {}

  async get(plaintextSha256: string): Promise<AccountContext | null> {
    try {
      const raw = await this.redis.get(KEY_ENTRY(plaintextSha256));
      if (!raw) return null;
      const entry = JSON.parse(raw) as CachedEntry;
      const versionRaw = await this.redis.get(KEY_ACCOUNT_VERSION(entry.context.account.id));
      const currentVersion = versionRaw ? Number(versionRaw) : 0;
      if (currentVersion !== entry.accountVersion) return null;
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
      const versionRaw = await this.redis.get(KEY_ACCOUNT_VERSION(accountId));
      const accountVersion = versionRaw ? Number(versionRaw) : 0;
      const entry: CachedEntry = { context: serialize(context), accountVersion };
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
      const sha = await this.redis.get(KEY_REVERSE(keyId));
      const ops: Array<Promise<unknown>> = [this.redis.del(KEY_REVERSE(keyId))];
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
  expiresAtMs: number;
}

export class InMemoryAuthCache implements AuthCache {
  private readonly entries = new Map<string, MemEntry>();
  private readonly reverse = new Map<string, string>();
  private readonly accountVersions = new Map<string, number>();

  get(plaintextSha256: string): Promise<AccountContext | null> {
    const entry = this.entries.get(plaintextSha256);
    if (!entry) return Promise.resolve(null);
    if (entry.expiresAtMs <= Date.now()) {
      this.entries.delete(plaintextSha256);
      return Promise.resolve(null);
    }
    const currentVersion = this.accountVersions.get(entry.context.account.id) ?? 0;
    if (currentVersion !== entry.accountVersion) return Promise.resolve(null);
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
    this.entries.set(plaintextSha256, {
      context,
      accountVersion,
      expiresAtMs: Date.now() + ttlSec * 1000,
    });
    this.reverse.set(keyId, plaintextSha256);
    return Promise.resolve();
  }

  invalidateKey(keyId: string): Promise<void> {
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

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { message: String(err) };
}
