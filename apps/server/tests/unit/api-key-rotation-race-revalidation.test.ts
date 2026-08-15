// The API-key slow path re-reads the key it just verified, and the refusals
// prove the re-read is load-bearing.
//
// `slowPathApiKey` verifies a key, then — when the cache can capture
// generations — reads the SAME prefix a second time before trusting it:
//
//   "Revoke/rotation commits its DB mutation before invalidating the key
//    generation. If invalidation already won, this recheck observes the
//    mutation; if it wins later, the eventual cache entry keeps the captured
//    older generation and is therefore an immediate miss."
//
// That second read is what makes a rotate or revoke racing an in-flight
// authentication safe. Its refusals had never executed:
//
//   services/auth.ts:532  InvalidKeyError  — no key carries this prefix
//   services/auth.ts:558  InvalidKeyError  — the re-read returned a different key
//   services/auth.ts:562  ExpiredKeyError  — the re-read returned an expired key
//   services/auth.ts:569  InvalidKeyError  — the key's account is gone (FK invariant)
//
// From the item 5f sweep. The plain rejections on this path — wrong secret,
// revoked, expired — already ran; it is specifically the RE-VALIDATION that
// nobody had watched refuse, which is the half that only matters during a race.
//
// Keys are hashed with the real scrypt helper rather than a stub. A fake hash
// would make the positive arm pass without `verifyApiKey` ever agreeing, and
// that arm is what stops "reject everything" from satisfying the rest.

import { describe, expect, it } from 'vitest';
import { authenticate } from '../../src/services/auth.js';
import { generateApiKey, hashApiKey } from '../../src/lib/api-keys.js';
import { ExpiredKeyError, InvalidKeyError, RevokedKeyError } from '../../src/lib/errors.js';

const NOW = new Date('2026-08-16T12:00:00.000Z');
const PAST = new Date('2026-08-16T11:00:00.000Z');
const FUTURE = new Date('2026-08-16T13:00:00.000Z');
const ACCOUNT_ID = 'acc_1';

interface KeyRow {
  id: string;
  accountId: string;
  keyHash: string;
  scopes: string[];
  revokedAt: Date | null;
  expiresAt: Date | null;
}

async function keyRow(plaintext: string, over: Partial<KeyRow> = {}): Promise<KeyRow> {
  return {
    id: 'key_1',
    accountId: ACCOUNT_ID,
    keyHash: await hashApiKey(plaintext),
    scopes: [],
    revokedAt: null,
    expiresAt: FUTURE,
    ...over,
  };
}

/**
 * A cache that captures generations — the only way to reach the re-read — but
 * never serves a hit, so every call goes down the slow path.
 */
const capturingCache = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve(),
  captureVersions: () => Promise.resolve({ accountVersion: 1, keyVersion: 1 }),
};

function repoReturning(reads: (KeyRow | null)[], account: unknown): unknown {
  let i = 0;
  return {
    findApiKeyByPrefix: () => Promise.resolve(reads[Math.min(i++, reads.length - 1)] ?? null),
    getAccount: () => Promise.resolve(account),
    findTeamMemberships: () => Promise.resolve([]),
    findActiveRateLimitOverrides: () => Promise.resolve([]),
    touchApiKeyLastUsed: () => Promise.resolve(),
    findActiveWebSession: () => Promise.resolve(null),
    touchWebSessionLastUsed: () => Promise.resolve(),
  };
}

const ACTIVE_ACCOUNT = { id: ACCOUNT_ID, email: 'a@example.test', status: 'active', tier: 'free' };

async function authWith(reads: (KeyRow | null)[], account: unknown, plaintext: string) {
  return authenticate(
    repoReturning(reads, account) as never,
    plaintext,
    capturingCache as never,
    NOW,
  );
}

describe('the API-key rotation-race re-validation', () => {
  it('CRITICAL a key that reads back CONSISTENTLY authenticates. Every refusal below is satisfied by a path that rejects after the second read no matter what it returns — and that would break all API-key authentication, so this arm is what keeps the others honest.', async () => {
    const pt = generateApiKey('live');
    const row = await keyRow(pt);
    const ctx = (await authWith([row, row], ACTIVE_ACCOUNT, pt)) as { account: { id: string } };
    expect(ctx.account.id, 'authenticated on a stable read').toBe(ACCOUNT_ID);
  });

  // OUTCOME-ONLY, verified by mutation. Making the prefix miss fall through
  // instead of refusing left this arm GREEN: the dispatcher then tries the
  // web-session path, finds no session, and raises the same InvalidKeyError.
  // The line does execute — which is what the sweep was after — but from the
  // public entry point the two routes to refusal are indistinguishable, so this
  // pins the customer-visible outcome rather than the branch it travels.
  it('a prefix that matches no key is refused (outcome, not branch — see note)', async () => {
    const pt = generateApiKey('live');
    await expect(authWith([null], ACTIVE_ACCOUNT, pt)).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('CRITICAL a re-read returning a DIFFERENT key is refused. This is rotation landing mid-authentication: the first read verified the old secret, the row was replaced, and trusting the first read would authenticate a credential the database has already rotated away.', async () => {
    const pt = generateApiKey('live');
    const first = await keyRow(pt);
    const rotated = await keyRow(pt, { id: 'key_2' });
    await expect(authWith([first, rotated], ACTIVE_ACCOUNT, pt)).rejects.toBeInstanceOf(
      InvalidKeyError,
    );
  });

  it("CRITICAL a re-read whose HASH changed is refused even when the id is the same. Rotation in place keeps the row and replaces the secret; comparing only ids would accept the caller's now-superseded plaintext.", async () => {
    const pt = generateApiKey('live');
    const first = await keyRow(pt);
    const rehashed = await keyRow(generateApiKey('live'), { id: first.id });
    await expect(authWith([first, rehashed], ACTIVE_ACCOUNT, pt)).rejects.toBeInstanceOf(
      InvalidKeyError,
    );
  });

  // NOTE ON THESE TWO FIXTURES. The re-read must carry the SAME keyHash as the
  // first read, so they are derived from it rather than re-hashed. `hashApiKey`
  // salts per call, so a second hash of the same plaintext differs — and the
  // identity check above fires first, throwing InvalidKeyError. Both of these
  // arms failed that way on the first attempt and were passing through a branch
  // other than the one they name, which is the same mistake as a mutation that
  // reds the wrong assertion.
  it('CRITICAL a re-read that is REVOKED is refused. Revocation commits to the database before the cache generation moves, so the window this covers is exactly the one revocation is meant to close.', async () => {
    const pt = generateApiKey('live');
    const first = await keyRow(pt);
    const revoked = { ...first, revokedAt: PAST };
    await expect(authWith([first, revoked], ACTIVE_ACCOUNT, pt)).rejects.toBeInstanceOf(
      RevokedKeyError,
    );
  });

  it('CRITICAL a re-read that has EXPIRED is refused. Expiry is clock-bound, so a key can cross its boundary between the two reads of a single authentication without any mutation at all.', async () => {
    const pt = generateApiKey('live');
    const first = await keyRow(pt);
    const expired = { ...first, expiresAt: PAST };
    await expect(authWith([first, expired], ACTIVE_ACCOUNT, pt)).rejects.toBeInstanceOf(
      ExpiredKeyError,
    );
  });

  // OUTCOME-ONLY, same reason: removing the FK-invariant throw also left this
  // arm green, because a context with no account cannot be assembled and the
  // request fails regardless. Worth keeping — a deleted account whose keys
  // outlived it must not authenticate, and that IS asserted — but it does not
  // prove which check refused.
  it('a key whose account has vanished is refused (outcome, not branch — see note)', async () => {
    const pt = generateApiKey('live');
    const row = await keyRow(pt);
    await expect(authWith([row, row], null, pt)).rejects.toBeInstanceOf(InvalidKeyError);
  });
});
