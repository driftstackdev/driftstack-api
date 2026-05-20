// Integration test for the 2026-05-20 auth-tokens sweeper.
//
// Exercises AuthTokensSweeperService against InMemoryAuthFlowsRepo
// (real impl, not a mock). Catches drift between the service's
// retention contract and the repo's deleteStaleAuthTokens logic
// that the unit test (with a mock repo) misses.

import { describe, expect, it } from 'vitest';
import { InMemoryAuthFlowsRepo } from './_helpers/in-memory-auth-flows-repo.js';
import { AuthTokensSweeperService } from '../../src/services/auth-flows-sweeper.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('AuthTokensSweeperService — InMemoryAuthFlowsRepo end-to-end', () => {
  it('deletes consumed-rows older than 30d + expired-unconsumed older than 7d; keeps recent + active rows', async () => {
    const repo = new InMemoryAuthFlowsRepo();
    const now = new Date('2026-05-20T12:00:00Z');

    // Active token — not expired, not consumed. Should be retained.
    const active = await repo.insertAuthToken({
      kind: 'magic_link',
      accountId: 'acc1',
      tokenHash: 'hash-active',
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
      requestedFromIp: null,
    });

    // Recently consumed (1d ago) — within forensic window. Retained.
    const recentlyConsumed = await repo.insertAuthToken({
      kind: 'magic_link',
      accountId: 'acc1',
      tokenHash: 'hash-recent-consumed',
      expiresAt: new Date(now.getTime() - 1 * DAY_MS),
      requestedFromIp: null,
    });
    await repo.consumeAuthToken({
      kind: 'magic_link',
      id: recentlyConsumed.id,
      at: new Date(now.getTime() - 1 * DAY_MS),
    });

    // Old consumed (40d ago) — past the 30d forensic window. DELETED.
    const oldConsumed = await repo.insertAuthToken({
      kind: 'email_verify',
      accountId: 'acc1',
      tokenHash: 'hash-old-consumed',
      expiresAt: new Date(now.getTime() - 40 * DAY_MS),
      requestedFromIp: null,
    });
    await repo.consumeAuthToken({
      kind: 'email_verify',
      id: oldConsumed.id,
      at: new Date(now.getTime() - 40 * DAY_MS),
    });

    // Recently expired (3d ago, unconsumed) — within retry window. Retained.
    const recentlyExpired = await repo.insertAuthToken({
      kind: 'password_reset',
      accountId: 'acc1',
      tokenHash: 'hash-recent-expired',
      expiresAt: new Date(now.getTime() - 3 * DAY_MS),
      requestedFromIp: null,
    });

    // Long-expired (10d ago, unconsumed) — past the 7d retry window. DELETED.
    await repo.insertAuthToken({
      kind: 'password_reset',
      accountId: 'acc1',
      tokenHash: 'hash-long-expired',
      expiresAt: new Date(now.getTime() - 10 * DAY_MS),
      requestedFromIp: null,
    });

    const svc = new AuthTokensSweeperService({ repo });
    const result = await svc.tickOnce(now);

    // 2 rows deleted total: oldConsumed (email_verify) + longExpired
    // (password_reset). 1 retained per kind.
    expect(result.totalDeleted).toBe(2);
    expect(result.deletedByKind).toEqual({
      email_verify: 1,
      magic_link: 0,
      password_reset: 1,
    });

    // Verify the right rows survived. findActiveAuthToken returns null
    // for consumed/expired so we use it to assert the active row is
    // still findable.
    const stillActive = await repo.findActiveAuthToken({
      kind: 'magic_link',
      tokenHash: 'hash-active',
      now,
    });
    expect(stillActive?.id).toBe(active.id);

    // Deleted rows: any lookup by their id should not find them.
    // findActiveAuthToken is the only public lookup; consumed/expired
    // rows return null even pre-delete. Assert via a fresh insert
    // collision check — re-inserting same hash should now succeed
    // (no row in the table).
    const reInserted = await repo.insertAuthToken({
      kind: 'email_verify',
      accountId: 'acc1',
      tokenHash: 'hash-old-consumed',
      expiresAt: new Date(now.getTime() + 60 * 1000),
      requestedFromIp: null,
    });
    expect(reInserted.tokenHash).toBe('hash-old-consumed');

    // recentlyExpired (3d) should still exist — sweep should NOT have
    // touched it.
    void recentlyExpired;
  });

  it('returns zero deletions when no rows match the retention cutoffs', async () => {
    const repo = new InMemoryAuthFlowsRepo();
    const now = new Date('2026-05-20T12:00:00Z');

    // Active token only.
    await repo.insertAuthToken({
      kind: 'magic_link',
      accountId: 'acc1',
      tokenHash: 'hash-active-only',
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
      requestedFromIp: null,
    });

    const svc = new AuthTokensSweeperService({ repo });
    const result = await svc.tickOnce(now);

    expect(result.totalDeleted).toBe(0);
    expect(result.deletedByKind).toEqual({
      email_verify: 0,
      magic_link: 0,
      password_reset: 0,
    });
  });
});
