// Coalescer flow test — drives `authenticate()` with the real coalescer
// against a counting auth-repo + a real scrypt verify. Asserts that 16
// concurrent calls with the same plaintext run scrypt ONCE (the path
// V-012 identified as the cold-start fan-out source).

import { describe, expect, it, vi } from 'vitest';
import { authenticate } from '../../src/services/auth.js';
import type { AccountAuthRepo, AccountRow, ApiKeyRow } from '../../src/services/auth.js';
import { AuthCoalescer } from '../../src/services/auth-coalescer.js';
import { InMemoryAuthCache } from '../../src/services/auth-cache.js';
import { createTestLogger } from '../../src/lib/logger.js';
import { generateApiKey, hashApiKey, keyPrefixFromPlaintext } from '../../src/lib/api-keys.js';

class CountingAuthRepo implements AccountAuthRepo {
  private accounts = new Map<string, AccountRow>();
  private keysByPrefix = new Map<string, ApiKeyRow>();
  prefixLookups = 0;
  accountLookups = 0;
  touches = 0;

  upsertAccount(row: AccountRow): void {
    this.accounts.set(row.id, row);
  }
  upsertApiKey(row: ApiKeyRow): void {
    this.keysByPrefix.set(row.keyPrefix, row);
  }
  findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null> {
    this.prefixLookups += 1;
    return Promise.resolve(this.keysByPrefix.get(prefix) ?? null);
  }
  getAccount(id: string): Promise<AccountRow | null> {
    this.accountLookups += 1;
    return Promise.resolve(this.accounts.get(id) ?? null);
  }
  touchApiKeyLastUsed(_id: string, _at: Date): Promise<void> {
    this.touches += 1;
    return Promise.resolve();
  }
  findActiveRateLimitOverrides(): Promise<never[]> {
    return Promise.resolve([]);
  }
  // V-168 — web session methods stubbed; coalescer tests don't exercise
  // the web-session auth path.
  findActiveWebSession(): Promise<null> {
    return Promise.resolve(null);
  }
  touchWebSessionLastUsed(): Promise<void> {
    return Promise.resolve();
  }
  // V-326 — team memberships stubbed; not exercised by coalescer tests.
  findTeamMemberships(): Promise<never[]> {
    return Promise.resolve([]);
  }
  // V-352 — account basics stubbed; not exercised by coalescer tests.
  updateAccountBasics(): Promise<null> {
    return Promise.resolve(null);
  }
  // Per-account org-sync — stubbed; not exercised by coalescer tests.
  getOrganization(): Promise<{ folders: never[]; tags: never[] }> {
    return Promise.resolve({ folders: [], tags: [] });
  }
  setOrganization(): Promise<void> {
    return Promise.resolve();
  }
}

async function seed(repo: CountingAuthRepo): Promise<{ plaintext: string; accountId: string }> {
  const accountId = '00000000-0000-4000-8000-000000000c01';
  const apiKeyId = '00000000-0000-4000-8000-000000000c02';
  repo.upsertAccount({
    id: accountId,
    email: 'co@x.test',
    name: null,
    tier: 'api_builder',
    status: 'active',
    timezone: null,
    avatarR2Key: null,
    slug: null,
    region: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });
  const plaintext = generateApiKey('test');
  const keyHash = await hashApiKey(plaintext);
  repo.upsertApiKey({
    id: apiKeyId,
    accountId,
    name: 'co-key',
    keyPrefix: keyPrefixFromPlaintext(plaintext),
    keyHash,
    scopes: ['read', 'write', 'admin'],
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  return { plaintext, accountId };
}

describe('coalescer integrated with authenticate()', () => {
  it('16 concurrent calls with the same plaintext run scrypt ONCE', async () => {
    const repo = new CountingAuthRepo();
    const { plaintext } = await seed(repo);
    const cache = new InMemoryAuthCache();
    const coalescer = new AuthCoalescer();

    const calls = Array.from({ length: 16 }, () =>
      authenticate(repo, plaintext, cache, new Date(), coalescer),
    );
    const results = await Promise.all(calls);

    expect(results).toHaveLength(16);
    // All 16 results are the same context object — coalescing returned the
    // same Promise, which resolves with one shared value.
    for (const r of results) expect(r.account.id).toBe(results[0]?.account.id);

    // The slow path ran exactly once: one initial key read, one V-591
    // post-generation authority recheck, one scrypt verify, and one account
    // fetch/touch. Without coalescing each of the 16 callers does that pair of
    // cheap reads independently.
    expect(repo.prefixLookups).toBe(2);
    expect(repo.accountLookups).toBe(1);
    expect(repo.touches).toBe(1);

    // Coalescer recorded 1 start, 15 hits.
    const stats = coalescer.stats();
    expect(stats.starts).toBe(1);
    expect(stats.hits).toBe(15);
    expect(stats.inFlight).toBe(0);

    // Cache populated for next request.
    expect(cache.size()).toBe(1);
  });

  it('without a coalescer the slow path runs N times (control)', async () => {
    const repo = new CountingAuthRepo();
    const { plaintext } = await seed(repo);
    const cache = new InMemoryAuthCache();

    const calls = Array.from({ length: 16 }, () =>
      authenticate(repo, plaintext, cache, new Date(), null),
    );
    await Promise.all(calls);

    // No coalescer — every concurrent call takes the slow path and performs
    // both the initial key read and the V-591 authority recheck. This is the
    // V-012 cold-start fan-out shape.
    expect(repo.prefixLookups).toBe(32);
  });

  it('coalescing across different plaintexts is independent', async () => {
    const repo = new CountingAuthRepo();
    // Seed 4 accounts.
    const accountIds = [
      '00000000-0000-4000-8000-000000000d01',
      '00000000-0000-4000-8000-000000000d02',
      '00000000-0000-4000-8000-000000000d03',
      '00000000-0000-4000-8000-000000000d04',
    ];
    const plaintexts: string[] = [];
    for (const id of accountIds) {
      repo.upsertAccount({
        id,
        email: `${id}@x.test`,
        name: null,
        tier: 'api_builder',
        status: 'active',
        timezone: null,
        avatarR2Key: null,
        slug: null,
        region: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const plaintext = generateApiKey('test');
      const keyHash = await hashApiKey(plaintext);
      repo.upsertApiKey({
        id: `${id}-key`,
        accountId: id,
        name: 'k',
        keyPrefix: keyPrefixFromPlaintext(plaintext),
        keyHash,
        scopes: ['read'],
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      plaintexts.push(plaintext);
    }

    const coalescer = new AuthCoalescer();
    const cache = new InMemoryAuthCache();

    // 4 concurrent calls per plaintext = 16 total but split across 4 shas.
    const calls: Array<Promise<unknown>> = [];
    for (const p of plaintexts) {
      for (let i = 0; i < 4; i++) {
        calls.push(authenticate(repo, p, cache, new Date(), coalescer));
      }
    }
    await Promise.all(calls);

    // 4 distinct slow paths (one per plaintext); 12 coalesce hits (3 per
    // plaintext), with two key reads per winning slow path.
    const stats = coalescer.stats();
    expect(stats.starts).toBe(4);
    expect(stats.hits).toBe(12);
    expect(repo.prefixLookups).toBe(8);
  });

  it('rejected slow path (invalid plaintext) clears the slot for retry', async () => {
    const repo = new CountingAuthRepo();
    const coalescer = new AuthCoalescer();
    const cache = new InMemoryAuthCache();

    // Garbage plaintext → InvalidKeyError. Two concurrent attempts.
    const garbage = 'ds_test_completely_invalid_garbage_payload';
    const failures = await Promise.allSettled([
      authenticate(repo, garbage, cache, new Date(), coalescer),
      authenticate(repo, garbage, cache, new Date(), coalescer),
    ]);
    for (const f of failures) expect(f.status).toBe('rejected');

    // Slot cleared after rejection — a retry runs a fresh slow path.
    expect(coalescer.stats().inFlight).toBe(0);

    // A new attempt for the same garbage tries again (would hit prefix
    // lookup — which finds nothing — and reject).
    const beforeLookups = repo.prefixLookups;
    const retry = await authenticate(repo, garbage, cache, new Date(), coalescer).catch(
      (e: unknown) => e,
    );
    expect(retry).toBeInstanceOf(Error);
    expect(repo.prefixLookups).toBe(beforeLookups + 1); // not piggybacked on a rejected promise
  });

  it('cache hit short-circuits before the coalescer is consulted', async () => {
    const repo = new CountingAuthRepo();
    const { plaintext } = await seed(repo);
    const cache = new InMemoryAuthCache();
    const coalescer = new AuthCoalescer();

    // Warm the cache.
    await authenticate(repo, plaintext, cache, new Date(), coalescer);
    expect(coalescer.stats().starts).toBe(1);

    const before = coalescer.stats();
    // Subsequent concurrent calls hit the cache directly — coalescer never
    // sees them.
    await Promise.all(
      Array.from({ length: 16 }, () => authenticate(repo, plaintext, cache, new Date(), coalescer)),
    );
    const after = coalescer.stats();
    expect(after.starts).toBe(before.starts);
    expect(after.hits).toBe(before.hits);
  });

  it('telemetry: stats counters are observable for logging', async () => {
    const repo = new CountingAuthRepo();
    const { plaintext } = await seed(repo);
    const cache = new InMemoryAuthCache();
    const logger = createTestLogger();
    const debugSpy = vi.spyOn(logger, 'debug');
    const coalescer = new AuthCoalescer(logger);

    await Promise.all(
      Array.from({ length: 8 }, () => authenticate(repo, plaintext, cache, new Date(), coalescer)),
    );

    expect(coalescer.stats().starts).toBe(1);
    expect(coalescer.stats().hits).toBe(7);
    // Each coalesce hit emits a debug log line.
    expect(debugSpy).toHaveBeenCalledTimes(7);
  });
});
