// A cache hit is re-validated against Postgres, and the refusals prove it.
//
// `authenticate`'s fast path says exactly what it is for:
//
//   "Redis generation bumps are cache accelerators, not authority. Every
//    positive hit re-reads the live account, exact credential, team grants, and
//    active rate-limit overrides in parallel, so a process crash or Redis
//    failure after a PostgreSQL revoke/rotate/reset/MFA/status/membership/
//    override mutation cannot extend stale authority to the cache TTL."
//
// That is the whole safety argument for having an auth cache at all. Its
// refusals had never executed:
//
//   services/auth.ts:318  throw new ExpiredKeyError()   — cached key past expiry
//   services/auth.ts:341  throw new InvalidKeyError()   — live session gone or mismatched
//   services/auth.ts:348  throw new ExpiredKeyError()   — live session past expiry
//   services/auth.ts:350  throw new InvalidKeyError()   — live account missing
//
// Found in the 31-of-108 deny-path sweep (item 5f). If any of these were wrong,
// a credential revoked or expired in Postgres would keep working until the cache
// entry aged out — which is precisely the failure the comment promises cannot
// happen, asserted by nothing.
//
// The positive arm is not decoration. Every refusal here is satisfied by an
// implementation that rejects all cache hits, and that implementation would be
// invisible in production: it would merely make the cache useless while
// authentication still worked through the slow path.

import { describe, expect, it } from 'vitest';
import { authenticate } from '../../src/services/auth.js';
import {
  ExpiredKeyError,
  ForbiddenError,
  InvalidKeyError,
  RevokedKeyError,
} from '../../src/lib/errors.js';

const NOW = new Date('2026-08-16T12:00:00.000Z');
const PAST = new Date('2026-08-16T11:00:00.000Z');
const FUTURE = new Date('2026-08-16T13:00:00.000Z');
const TOKEN = 'ds_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const ACCOUNT_ID = 'acc_1';
const SESSION_ID = 'sess_1';

interface Overrides {
  cachedKeyExpiresAt?: Date | null;
  liveSession?: unknown;
  liveAccountStatus?: 'active' | 'suspended' | 'deleted';
  liveAccountMissing?: boolean;
}

/** A cached context for a web-session credential, valid unless overridden. */
function cachedContext(o: Overrides): unknown {
  return {
    account: { id: ACCOUNT_ID, email: 'a@example.test', status: 'active', tier: 'free' },
    apiKey: {
      id: `wsk_${SESSION_ID}`,
      accountId: ACCOUNT_ID,
      scopes: [],
      revokedAt: null,
      expiresAt: o.cachedKeyExpiresAt === undefined ? FUTURE : o.cachedKeyExpiresAt,
    },
    rateLimitOverrides: {},
    webSession: { id: SESSION_ID, mfaSatisfiedAt: null },
    teams: [],
  };
}

function repoWith(o: Overrides): unknown {
  const liveSession =
    'liveSession' in o
      ? o.liveSession
      : {
          id: SESSION_ID,
          accountId: ACCOUNT_ID,
          revokedAt: null,
          expiresAt: FUTURE,
        };
  return {
    findActiveWebSession: () => Promise.resolve(liveSession),
    getAccount: () =>
      Promise.resolve(
        o.liveAccountMissing === true
          ? null
          : {
              id: ACCOUNT_ID,
              email: 'a@example.test',
              status: o.liveAccountStatus ?? 'active',
              tier: 'free',
            },
      ),
    findTeamMemberships: () => Promise.resolve([]),
    findActiveRateLimitOverrides: () => Promise.resolve([]),
    touchWebSessionLastUsed: () => Promise.resolve(),
    touchApiKeyLastUsed: () => Promise.resolve(),
    findApiKeyByPrefix: () => Promise.resolve(null),
  };
}

function cacheReturning(ctx: unknown): unknown {
  return { get: () => Promise.resolve(ctx), set: () => Promise.resolve() };
}

async function authWith(o: Overrides): Promise<unknown> {
  return authenticate(repoWith(o) as never, TOKEN, cacheReturning(cachedContext(o)) as never, NOW);
}

describe('an auth cache hit is re-validated against Postgres', () => {
  it('CRITICAL a fully valid cache hit AUTHENTICATES. Every refusal below is satisfied by an implementation that rejects all cache hits — and that implementation would be invisible in production, merely making the cache useless while auth still worked through the slow path.', async () => {
    const ctx = (await authWith({})) as { account: { id: string } };
    expect(ctx.account.id, 'the cached identity is returned').toBe(ACCOUNT_ID);
  });

  it('CRITICAL a cached credential past its expiry is refused, on the cache read itself. Expiry is clock-bound rather than mutation-bound, so no generation bump would ever invalidate this entry — only re-checking the timestamp on every hit does.', async () => {
    await expect(authWith({ cachedKeyExpiresAt: PAST })).rejects.toBeInstanceOf(ExpiredKeyError);
  });

  it('CRITICAL a hit whose live web session has VANISHED is refused. This is the revoke-then-crash case: the session is deleted in Postgres, the invalidation never lands, and the cache entry survives. Accepting it would extend authority the database has already withdrawn.', async () => {
    await expect(authWith({ liveSession: null })).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('CRITICAL a hit whose live session belongs to a DIFFERENT account is refused. The cached key id and the live session id are cross-checked; without that, a collision or a mis-keyed entry authenticates one customer as another.', async () => {
    await expect(
      authWith({
        liveSession: {
          id: 'sess_other',
          accountId: 'acc_other',
          revokedAt: null,
          expiresAt: FUTURE,
        },
      }),
    ).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('CRITICAL a hit whose live session is REVOKED is refused. Revocation is the operation a customer performs when they believe a session is compromised; honouring it only after the cache TTL is the difference between logout and a delay.', async () => {
    await expect(
      authWith({
        liveSession: { id: SESSION_ID, accountId: ACCOUNT_ID, revokedAt: PAST, expiresAt: FUTURE },
      }),
    ).rejects.toBeInstanceOf(RevokedKeyError);
  });

  it('CRITICAL a hit whose live session has EXPIRED is refused even when the cached copy looks fresh. The cached entry carries its own expiry; this arm covers the case where the authoritative row expired independently.', async () => {
    await expect(
      authWith({
        liveSession: { id: SESSION_ID, accountId: ACCOUNT_ID, revokedAt: null, expiresAt: PAST },
      }),
    ).rejects.toBeInstanceOf(ExpiredKeyError);
  });

  it('CRITICAL a hit whose live account has vanished is refused. A deleted account whose sessions were not swept must not keep authenticating from cache.', async () => {
    await expect(authWith({ liveAccountMissing: true })).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('CRITICAL a hit for a SUSPENDED account is refused with Forbidden, not Invalid. Suspension is a reversible state and the distinct error is what tells the customer to contact support rather than re-authenticate — asserted separately so a broad catch-all cannot flatten it.', async () => {
    await expect(authWith({ liveAccountStatus: 'suspended' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('CRITICAL a hit for a DELETED account is refused as Invalid. The deleted state is terminal, so unlike suspension it must not hint that the credential could work again.', async () => {
    await expect(authWith({ liveAccountStatus: 'deleted' })).rejects.toBeInstanceOf(
      InvalidKeyError,
    );
  });
});
