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
import { generateApiKey, hashApiKey, keyPrefixFromPlaintext } from '../../src/lib/api-keys.js';
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

// ─── the API-KEY branch of the same fast path ─────────────────────────────────
//
// Everything above drives `cached.webSession !== null`. A cached API key takes a
// separate 20-line block with its own re-validation, and two of ITS refusals had
// never run:
//
//   services/auth.ts:398  throw new ExpiredKeyError()  — LIVE key past expiry
//   services/auth.ts:401  throw new InvalidKeyError()  — live account gone or
//                                                        pointing at a different
//                                                        account than the key
//
// Measured from the coverage statementMap rather than guessed: that block
// executes 2,100+ times under the suite, its surrounding conditions run every
// time, and those two throws are count=0. A branch that busy with two refusals
// that never fire is the shape of a control nobody has watched work.
//
// The expiry one matters most and is easy to mis-read. The cached copy is
// checked for expiry FIRST, against the clock (auth.ts:317). These arms set the
// cached copy to a FUTURE expiry so that check passes, and expire only the LIVE
// row — which is the real case: a key that expired in Postgres while a fresh
// cache entry still describes it. Without :398 that key keeps authenticating
// until the entry ages out, which is exactly what this file's opening comment
// promises cannot happen.
//
// MUTATION-PROVED against services/auth.ts — control 13/13 here, 19/19 on the
// parity pin over the same file:
//
//                                                        here    parity pin
//   the LIVE key expiry re-check removed                1 red      GREEN
//   expiry re-checked against the CACHED copy           1 red      GREEN
//   the account/key MISMATCH half dropped               1 red      GREEN
//
// The middle one is the one to remember. It keeps a re-check, keeps the same
// error, keeps the same shape — and compares the CACHED expiry instead of the
// live row, which is the value the code already tested twenty lines earlier. The
// whole re-validation becomes a no-op that reads correctly, and the pin sees a
// file that still says `ExpiredKeyError` in the right place.

const KEY_ID = 'key_1';
const KEY_PREFIX = 'ds_live_aaaa';
const OTHER_ACCOUNT_ID = 'acc_other';

interface KeyOverrides {
  liveKeyExpiresAt?: Date | null;
  liveAccountId?: string;
  liveAccountMissing?: boolean;
  /** Mirrors the web-session overrides above; the key path re-reads status too. */
  liveAccountStatus?: 'active' | 'suspended' | 'deleted';
}

/** A cached context for an API-KEY credential — note `webSession: null`. */
function cachedApiKeyContext(): unknown {
  return {
    account: { id: ACCOUNT_ID, email: 'a@example.test', status: 'active', tier: 'free' },
    apiKey: {
      id: KEY_ID,
      accountId: ACCOUNT_ID,
      keyPrefix: KEY_PREFIX,
      keyHash: 'hash_1',
      scopes: [],
      revokedAt: null,
      // FUTURE on purpose: the cached-copy clock check at auth.ts:317 must pass
      // so the LIVE re-read is what decides.
      expiresAt: FUTURE,
    },
    rateLimitOverrides: {},
    webSession: null,
    teams: [],
  };
}

function repoWithKey(o: KeyOverrides): unknown {
  return {
    findApiKeyByPrefix: () =>
      Promise.resolve({
        id: KEY_ID,
        accountId: ACCOUNT_ID,
        keyPrefix: KEY_PREFIX,
        keyHash: 'hash_1',
        scopes: [],
        revokedAt: null,
        expiresAt: o.liveKeyExpiresAt === undefined ? FUTURE : o.liveKeyExpiresAt,
      }),
    getAccount: () =>
      Promise.resolve(
        o.liveAccountMissing === true
          ? null
          : {
              id: o.liveAccountId ?? ACCOUNT_ID,
              email: 'a@example.test',
              status: o.liveAccountStatus ?? 'active',
              tier: 'free',
            },
      ),
    findTeamMemberships: () => Promise.resolve([]),
    findActiveRateLimitOverrides: () => Promise.resolve([]),
    findActiveWebSession: () => Promise.resolve(null),
    touchApiKeyLastUsed: () => Promise.resolve(),
    touchWebSessionLastUsed: () => Promise.resolve(),
  };
}

async function authWithKey(o: KeyOverrides): Promise<unknown> {
  return authenticate(
    repoWithKey(o) as never,
    TOKEN,
    cacheReturning(cachedApiKeyContext()) as never,
    NOW,
  );
}

describe('an API-key cache hit is re-validated against Postgres too', () => {
  it('CRITICAL a fully valid API-key cache hit AUTHENTICATES. Both refusals below are satisfied by an implementation that rejects every api-key hit, and that implementation would be invisible in production — it would only make the cache useless while authentication still worked through the slow path.', async () => {
    const ctx = (await authWithKey({})) as { account: { id: string }; apiKey: { id: string } };
    expect(ctx.account.id, 'authenticated from the hit').toBe(ACCOUNT_ID);
    expect(ctx.apiKey.id, 'carrying the live key').toBe(KEY_ID);
  });

  it('CRITICAL a hit whose LIVE key has expired is refused, even though the cached copy still looks fresh. Expiry happens in Postgres on a schedule nobody triggers, so the cache is never invalidated for it — the live re-read is the only thing that can notice. Without this the key keeps working for the remainder of the cache TTL, and the customer sees a credential outliving its own expiry date.', async () => {
    await expect(authWithKey({ liveKeyExpiresAt: PAST })).rejects.toBeInstanceOf(ExpiredKeyError);
  });

  it('CRITICAL a hit whose live account has VANISHED is refused. The key row and the account row are deleted by different paths, so a key surviving its account is a real intermediate state; resolving it would hand a request an AccountContext built around an account that no longer exists.', async () => {
    await expect(authWithKey({ liveAccountMissing: true })).rejects.toBeInstanceOf(InvalidKeyError);
  });

  // The two status refusals the API-key block carries and this section did not.
  //
  // ⚠️ Both exist verbatim in the web-session block above and are covered THERE.
  // That is what hid them: "is a deleted account refused on a cache hit?" finds a
  // passing arm and stops. The two blocks re-validate independently — a cached
  // API key and a cached web session take separate 20-line paths — so covering
  // one says nothing about the other. Measured: neutralizing the key path's
  // deleted-account refusal left all 205 tests in the auth-cache set green.
  //
  // The stake is the terminal state. A deleted account whose key is still cached
  // keeps authenticating for the remainder of the TTL, and the live re-read is
  // the only thing that can notice — deletion invalidates on a different path
  // than the one that wrote this entry.
  //
  // LEDGER — control 15/15:
  //
  //   key-path DELETED refusal neutralized      1 red
  //   key-path SUSPENDED refusal neutralized    1 red
  //   SESSION-path deleted refusal neutralized  1 red
  //   key-path deleted mapped to FORBIDDEN      1 red
  //
  // The third row is the independence proof: neutralizing the session path's
  // copy reds an arm up there and none of these, which is what "separate blocks"
  // means in practice. The fourth is the anti-flattening check — the refusal
  // still fires, only with the reversible error instead of the terminal one, so
  // a caller is told to contact support about an account that no longer
  // exists.
  it('CRITICAL a key-path hit for a SUSPENDED account is refused with Forbidden, not Invalid — the same distinction the session path draws, from its own copy of the check.', async () => {
    await expect(authWithKey({ liveAccountStatus: 'suspended' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('CRITICAL a key-path hit for a DELETED account is refused as Invalid. Terminal, so unlike suspension it must not hint the credential could work again — and a customer who deleted their account must not keep authenticating until a cache entry ages out.', async () => {
    await expect(authWithKey({ liveAccountStatus: 'deleted' })).rejects.toBeInstanceOf(
      InvalidKeyError,
    );
  });

  it("CRITICAL a hit whose live account does not match the live KEY is refused. Both are re-read independently, so this is the check that stops a stale cache entry from stitching one account to another account's credential — the worst outcome available on this path, and one no single-row check could catch.", async () => {
    await expect(authWithKey({ liveAccountId: OTHER_ACCOUNT_ID })).rejects.toBeInstanceOf(
      InvalidKeyError,
    );
  });
});

// ─── the WRITE side: re-validated again before anything is cached ───────────
//
// Everything above is the cache HIT path. A slow-path authentication has a
// second, separate re-validation: after scrypt succeeds and before the context
// is written to the cache, the credential is re-read and re-checked. Four of
// those refusals had never executed — measured by neutralizing each against 593
// tests across the auth, team and account-organization sets.
//
// ⚠️ The window this closes is real and is created by the verification itself.
// scrypt is deliberately slow, so there is a ~100ms gap between "the key looked
// valid" and "the context is cached". A revoke committing inside that gap has
// already invalidated a cache generation that did not exist yet, so nothing
// evicts the entry that is about to be written — and the revoked key then
// authenticates from cache for the whole TTL. The re-read is the only thing
// standing in that window, and it is why the source captures the generations
// BEFORE the recheck rather than after.
//
// These are separate lines from the hit-path checks above, in a separate branch,
// on the same rules. Sibling copies again.
//
// LEDGER — control 20/20:
//
//   :558 identity/hash recheck neutralized    2 red
//   :560 revoked recheck neutralized          1 red
//   :562 expiry recheck neutralized           1 red
//   :667 session-branch recheck neutralized   1 red
//   the whole capture block skipped           4 red
//
// The last row is the one that justifies capturing the cache generations BEFORE
// the recheck rather than after: skipping the block entirely reds every key-path
// arm, so the block is load-bearing as a unit and not just line by line.
describe('a credential revoked DURING verification is not written to the cache', () => {
  const ENV = 'test' as const;

  /**
   * A slow-path fixture: the cache MISSES (so verification actually runs), then
   * `findApiKeyByPrefix` answers differently the second time — which is exactly
   * what a revoke landing mid-verify looks like from here.
   */
  async function authWithRevalidation(second: 'missing' | 'rotated' | 'revoked' | 'expired') {
    const plaintext = generateApiKey(ENV);
    const keyHash = await hashApiKey(plaintext);
    const prefix = keyPrefixFromPlaintext(plaintext);
    const live = {
      id: KEY_ID,
      accountId: ACCOUNT_ID,
      keyPrefix: prefix,
      keyHash,
      scopes: [],
      revokedAt: null,
      expiresAt: FUTURE,
    };
    let call = 0;
    const repo = {
      findApiKeyByPrefix: () => {
        call += 1;
        if (call === 1) return Promise.resolve(live);
        if (second === 'missing') return Promise.resolve(null);
        if (second === 'rotated') return Promise.resolve({ ...live, keyHash: 'hash_rotated' });
        if (second === 'revoked') return Promise.resolve({ ...live, revokedAt: NOW });
        return Promise.resolve({ ...live, expiresAt: PAST });
      },
      getAccount: () =>
        Promise.resolve({
          id: ACCOUNT_ID,
          email: 'a@example.test',
          status: 'active',
          tier: 'free',
        }),
      findTeamMemberships: () => Promise.resolve([]),
      findActiveRateLimitOverrides: () => Promise.resolve([]),
      touchApiKeyLastUsed: () => Promise.resolve(),
    };
    const cache = {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      captureVersions: () => Promise.resolve({ accountVersion: 1, keyVersion: 1 }),
    };
    return authenticate(repo as never, plaintext, cache as never, NOW);
  }

  it('CRITICAL the key ROW vanishing between verify and cache-write is refused. Deleting a key and revoking it are different paths, and a row that disappears mid-verify would otherwise be cached as the valid credential it looked like 100ms earlier.', async () => {
    await expect(authWithRevalidation('missing')).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('CRITICAL the key being ROTATED mid-verify is refused, because the hash no longer matches what scrypt just accepted. Without this the SUPERSEDED secret is cached as valid and keeps working for the TTL after its successor was issued.', async () => {
    await expect(authWithRevalidation('rotated')).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('CRITICAL a revoke committing mid-verify is refused as Revoked, not merely invalid — this is the exact race the recheck exists for, and the distinct error is what tells the caller the credential was withdrawn rather than never valid.', async () => {
    await expect(authWithRevalidation('revoked')).rejects.toBeInstanceOf(RevokedKeyError);
  });

  it('CRITICAL an expiry that lapses mid-verify is refused as Expired. Expiry is clock-bound and commits no mutation at all, so no invalidation is ever published for it and this re-read is the only observer.', async () => {
    await expect(authWithRevalidation('expired')).rejects.toBeInstanceOf(ExpiredKeyError);
  });

  // The web-session branch carries the SAME pre-cache-write recheck, and it was
  // uncovered for the same reason all day: its sibling is not the same line.
  // Adding the key-path arms above without this one would repeat exactly the
  // mistake they were written to correct.
  //
  // The window is narrower here — a session lookup is a hash read, not scrypt —
  // but the recheck exists because the session row can still be revoked between
  // the lookup and the cache write, and the entry about to be written would
  // outlive the revocation by a full TTL.
  it('CRITICAL a web session revoked between lookup and cache-write is refused, from the session branch of the same recheck', async () => {
    const plaintext = 'a'.repeat(48); // no `ds_` prefix ⇒ the web-session path
    const live = {
      id: SESSION_ID,
      accountId: ACCOUNT_ID,
      expiresAt: FUTURE,
      revokedAt: null,
      lastUsedAt: null,
      mfaSatisfiedAt: null,
      createdAt: NOW,
    };
    let call = 0;
    const repo = {
      findApiKeyByPrefix: () => Promise.resolve(null),
      findActiveWebSession: () => {
        call += 1;
        // The second read is the one the recheck makes; a revoked session is
        // filtered by the query itself, so it comes back as nothing.
        return Promise.resolve(call === 1 ? live : null);
      },
      touchWebSessionLastUsed: () => Promise.resolve(),
      getAccount: () =>
        Promise.resolve({
          id: ACCOUNT_ID,
          email: 'a@example.test',
          status: 'active',
          tier: 'free',
        }),
      findTeamMemberships: () => Promise.resolve([]),
      findActiveRateLimitOverrides: () => Promise.resolve([]),
    };
    const cache = {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      captureVersions: () => Promise.resolve({ accountVersion: 1, keyVersion: 1 }),
    };
    await expect(
      authenticate(repo as never, plaintext, cache as never, NOW),
    ).rejects.toBeInstanceOf(InvalidKeyError);
  });
});
