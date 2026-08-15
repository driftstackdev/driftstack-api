// Every refusal on the two authentication slow paths, executed.
//
// Item 5f. `services/auth.ts` carries 32 `InvalidKey`/`Revoked`/`ExpiredKeyError`
// throws across four functions — `authenticate` 14, `slowPathApiKey` 9,
// `slowPathWebSession` 6, `slowPathOAuthToken` 3. The cache-revalidation
// branches inside `authenticate` are already driven by
// `auth-cache-hit-revalidates-against-postgres` and
// `api-key-rotation-race-revalidation`. The SLOW paths are the remainder, and
// they are what runs on every cache miss — every cold start, every Redis
// outage, and every first request from any caller.
//
// `authenticate` is the only exported entry, and its third parameter is
// `cache = null`, so passing no cache reaches both slow paths directly. No
// database is needed: the repo is a double, which is the point — these arms are
// about which ERROR the caller gets, not about SQL.
//
// ─── what makes these worth executing rather than pinning ─────────────────────
//
// 1. THE THREE REFUSALS ARE NOT INTERCHANGEABLE. Invalid / Revoked / Expired
//    are separate classes reaching the caller as different problem types, and a
//    client switches on them: rotate a key, stop using a revoked one, or fix a
//    typo. Collapse them and every one of those becomes "your credential is
//    wrong", which is actionable for exactly one of the three.
//
// 2. SUSPENDED AND DELETED DELIBERATELY DIFFER. A suspended account gets 403
//    Forbidden with the reason; a DELETED one gets a plain InvalidKeyError,
//    indistinguishable from a bad credential. That asymmetry is anti-enumeration
//    — a deleted account must not be confirmable by anyone holding an old key —
//    and it is one `if` away from leaking. Both are asserted, and against each
//    other.
//
// 3. THE PREFIX-MISS FALL-THROUGH IS SUBTLE AND SECURITY-RELEVANT. A web-session
//    token is random base64, so ~1 in 262k begins with `ds_` and routes to the
//    API-key path. When no key carries that prefix the code returns null and the
//    dispatcher retries as a web session, so that unlucky session still works.
//    But a scrypt MISMATCH must NOT fall through: a real key with that prefix
//    exists and its secret is wrong, which is a bad API key and never a session
//    token. Falling through there would hand someone holding a valid prefix with
//    the wrong secret a second lookup instead of a hard reject. The two cases end
//    in the same error, so neither arm can prove the branch alone — they are
//    written as a PAIR against a repo that has BOTH a session and a key.
//
// 4. TWO OF THESE ARE DEFENCE-IN-DEPTH AND THEREFORE THE EASIEST TO LOSE.
//    `findActiveWebSession` already filters revoked and expired rows in SQL, so
//    the re-checks after it can only fire if a repo implementation stops doing
//    that. Nothing on the request path would notice them going — the same shape
//    as the admin-accounts page-size cap, which had no arm at all until a
//    mutation went looking.
//
// MUTATION-PROVED against services/auth.ts, running this file and BOTH existing
// pins over it. Controls: 18/18 here, 19/19 and 19/19 on the pins.
//
//                                                    here  parity  v168-pin
//   the <24-char guard removed                      1 red   1 red   green
//   a missing OAuth store answers Revoked           1 red   green   green
//   a REVOKED key is reported as invalid            1 red   1 red   green
//   an EXPIRED key is reported as invalid           1 red   1 red   green
//   a scrypt MISMATCH falls through                 1 red   1 red   green
//   the prefix-miss fall-through removed            1 red   1 red   green
//   api-key path: DELETED answers Forbidden         2 red   green   green
//   api-key path: SUSPENDED answers Invalid         2 red   green   green
//   session path: revoked recheck removed           1 red   green   green
//   session path: expiry recheck removed            1 red   green   green
//   session path: DELETED answers Forbidden         1 red   green   green
//   session path: synthetic key regains admin       1 red   green   green
//
// ⛔ THE PINS MISS 7 OF 12, AND THEY ARE THE SECURITY ONES. Both anti-enumeration
// leaks, the V-174 privilege regression, both defence-in-depth rechecks and the
// OAuth fail-closed class are invisible to both. `services-auth-content-parity`
// catches 5; `auth-service-v168-v326-cross-source-invariant` catches ZERO.
//
// The reason is structural rather than an oversight, and worth stating because
// it will recur. The parity pin DOES assert the asymmetry:
//
//     /if \(account\.status === 'deleted'\) \{\s*\n?\s*throw new InvalidKeyError\(\);/
//
// but that regex matches ANYWHERE in the file, and the block it describes exists
// TWICE — once in `slowPathApiKey`, once in `slowPathWebSession`. Mutating either
// alone leaves the other satisfying the pattern. Verified rather than inferred:
// mutating BOTH occurrences at once DOES red the pin (1 failed), while each on
// its own leaves it green.
//
// So the pin claims a security property that exists in two places and can detect
// its loss in NEITHER — only in both at once, which is not how a leak gets
// introduced. Same class as the `/nextRunAt,/` anchor in
// db-validation-schedules-repo, one level up: a text pin over a REPEATED block
// asserts the block exists somewhere, not that it still guards the path it was
// written for. That is invisible until something executes both paths separately,
// which is what the arms below do.

import { describe, expect, it } from 'vitest';
import { authenticate } from '../../src/services/auth.js';
import { generateApiKey, hashApiKey } from '../../src/lib/api-keys.js';
import {
  ExpiredKeyError,
  ForbiddenError,
  InvalidKeyError,
  RevokedKeyError,
} from '../../src/lib/errors.js';

const NOW = new Date('2026-08-15T12:00:00.000Z');
const PAST = new Date('2026-08-15T11:00:00.000Z');
const FUTURE = new Date('2026-08-15T13:00:00.000Z');
const ACCOUNT_ID = 'acc_1';

type Status = 'active' | 'suspended' | 'deleted';

const account = (status: Status = 'active'): unknown => ({
  id: ACCOUNT_ID,
  email: 'someone@example.test',
  name: null,
  tier: 'free',
  status,
  timezone: null,
  avatarR2Key: null,
  slug: null,
  region: null,
  createdAt: PAST,
  updatedAt: PAST,
});

async function apiKeyRow(
  plaintext: string,
  over: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return {
    id: 'key_1',
    accountId: ACCOUNT_ID,
    name: 'k',
    keyPrefix: plaintext.slice(0, 12),
    keyHash: await hashApiKey(plaintext),
    scopes: ['read'],
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: FUTURE,
    createdAt: PAST,
    ...over,
  };
}

const webSession = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'ws_1',
  accountId: ACCOUNT_ID,
  expiresAt: FUTURE,
  revokedAt: null,
  lastUsedAt: null,
  mfaSatisfiedAt: null,
  createdAt: PAST,
  ...over,
});

interface RepoOpts {
  apiKey?: unknown;
  session?: unknown;
  acct?: unknown;
}

/** Counts the reads, so an arm can prove a refusal happened BEFORE any lookup. */
function repo(opts: RepoOpts = {}): { r: unknown; reads: () => number } {
  let reads = 0;
  return {
    reads: () => reads,
    r: {
      findApiKeyByPrefix: () => {
        reads += 1;
        return Promise.resolve(opts.apiKey ?? null);
      },
      findActiveWebSession: () => {
        reads += 1;
        return Promise.resolve(opts.session ?? null);
      },
      getAccount: () => Promise.resolve(opts.acct === undefined ? account() : opts.acct),
      findTeamMemberships: () => Promise.resolve([]),
      findActiveRateLimitOverrides: () => Promise.resolve([]),
      touchApiKeyLastUsed: () => Promise.resolve(),
      touchWebSessionLastUsed: () => Promise.resolve(),
    },
  };
}

/** No cache and no negative cache — every call goes down a slow path. */
const auth = (r: unknown, plaintext: string): Promise<unknown> =>
  authenticate(r as never, plaintext, null, NOW);

/** A non-`ds_` token of legal length, so it routes straight to the session path. */
const SESSION_TOKEN = 'sess_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

describe('the authentication slow paths refuse for the right reason', () => {
  it('CRITICAL a valid API key still authenticates. Every arm below asserts a rejection, and a slow path that rejected unconditionally would satisfy all of them while breaking every API caller in production — so this is what stops the rest being vacuous.', async () => {
    const pt = generateApiKey('live');
    const { r } = repo({ apiKey: await apiKeyRow(pt) });
    const ctx = (await auth(r, pt)) as { account: { id: string } };
    expect(ctx.account.id, 'authenticated on a healthy key').toBe(ACCOUNT_ID);
  });

  it('CRITICAL a valid web session still authenticates, and its synthetic key carries account_owner rather than admin. V-174 split those: the dashboard user has full control of their OWN account but must not hold driftstack_internal_admin, which is what gates cross-account /v1/admin/*. Pre-V-174 this synthetic key carried a literal admin scope and conflated the two.', async () => {
    const { r } = repo({ session: webSession() });
    const ctx = (await auth(r, SESSION_TOKEN)) as { apiKey: { scopes: string[] } };
    expect(ctx.apiKey.scopes, 'the customer-owner scope set').toEqual([
      'read',
      'write',
      'account_owner',
    ]);
    expect(ctx.apiKey.scopes, 'and NOT staff admin').not.toContain('driftstack_internal_admin');
    expect(ctx.apiKey.scopes, 'nor a bare admin scope').not.toContain('admin');
  });

  it('CRITICAL a token shorter than 24 characters is refused before any lookup happens. It is the cheap guard in front of an unauthenticated endpoint: without it every short bogus token costs a prefix lookup, and under a flood that is the ungated database work an attacker gets to choose.', async () => {
    const { r, reads } = repo({ apiKey: await apiKeyRow(generateApiKey('live')) });
    await expect(auth(r, 'ds_live_short')).rejects.toBeInstanceOf(InvalidKeyError);
    expect(reads(), 'no lookup was performed at all').toBe(0);
  });

  it('CRITICAL an oat_ token with no OAuth store configured fails closed. The store is optional so isolated fixtures stay source-compatible; a deployment that forgot to wire it must reject OAuth bearers rather than fall through to the API-key path and evaluate an OAuth token as a key.', async () => {
    const { r } = repo();
    await expect(auth(r, `oat_${'z'.repeat(40)}`)).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('CRITICAL a REVOKED API key is refused as revoked, not as invalid. The caller switches on this: a revoked key means stop using this credential and mint a new one, while invalid means the value is wrong. Collapsed into one class, a customer whose key was revoked for a security reason is told they have a typo.', async () => {
    const pt = generateApiKey('live');
    const { r } = repo({ apiKey: await apiKeyRow(pt, { revokedAt: PAST }) });
    await expect(auth(r, pt)).rejects.toBeInstanceOf(RevokedKeyError);
  });

  it('CRITICAL an EXPIRED API key is refused as expired, not as invalid or revoked. Expiry is the one of the three the customer can resolve alone by rotating, and it is the one that happens on a schedule to keys that were never compromised.', async () => {
    const pt = generateApiKey('live');
    const { r } = repo({ apiKey: await apiKeyRow(pt, { expiresAt: PAST }) });
    await expect(auth(r, pt)).rejects.toBeInstanceOf(ExpiredKeyError);
  });

  it('CRITICAL a key whose secret does not match is invalid. This is the scrypt verify, the only thing standing between knowing a key PREFIX — which is public, it is stored unhashed and shown in dashboards — and authenticating as its owner.', async () => {
    const real = generateApiKey('live');
    const other = generateApiKey('live');
    // A row whose prefix matches the presented token but whose hash is another key's.
    const { r } = repo({ apiKey: await apiKeyRow(other, { keyPrefix: real.slice(0, 12) }) });
    await expect(auth(r, real)).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('CRITICAL a ds_-shaped token with NO key of that prefix FALLS THROUGH to the web-session path. A session token is random base64, so about 1 in 262k starts with ds_ by chance; without the fall-through that customer could never log in again and nothing would report an error — a silent, permanent session break for a fraction of users.', async () => {
    // A ds_ token that no key claims, but which IS a live session.
    const { r } = repo({ apiKey: null, session: webSession() });
    const ctx = (await auth(r, generateApiKey('live'))) as { account: { id: string } };
    expect(ctx.account.id, 'resolved as a web session despite the ds_ shape').toBe(ACCOUNT_ID);
  });

  it('CRITICAL a ds_ token whose key EXISTS but whose secret is wrong does NOT fall through, even when a session with that value exists. Paired with the arm above, which is the only way to prove the branch: both end in a refusal on their own. A real key carries this prefix and its secret is wrong, so it is a bad API key and never a session token — falling through would hand someone holding a valid prefix with the wrong secret a second lookup instead of a hard reject.', async () => {
    const presented = generateApiKey('live');
    const other = generateApiKey('live');
    const { r } = repo({
      apiKey: await apiKeyRow(other, { keyPrefix: presented.slice(0, 12) }),
      session: webSession(), // would authenticate if the mismatch fell through
    });
    await expect(auth(r, presented)).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('CRITICAL an API key whose account has vanished is invalid rather than a crash. It is an FK invariant, so reaching it means the database disagrees with itself; the branch turns that into a clean 401 instead of a TypeError on a null account and a 500 on the authentication path.', async () => {
    const pt = generateApiKey('live');
    const { r } = repo({ apiKey: await apiKeyRow(pt), acct: null });
    await expect(auth(r, pt)).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('CRITICAL a SUSPENDED account is refused with Forbidden and the reason, on the API-key path. The customer needs to know billing or policy stopped them rather than that their key is broken, because those have completely different next steps.', async () => {
    const pt = generateApiKey('live');
    const { r } = repo({ apiKey: await apiKeyRow(pt), acct: account('suspended') });
    await expect(auth(r, pt)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(auth(r, pt)).rejects.toThrow(/suspended/i);
  });

  it('CRITICAL a DELETED account is refused as INVALID, never as Forbidden — the asymmetry is deliberate. Forbidden confirms the account exists; anyone holding an old key could use it to test whether a given account was deleted. Invalid is indistinguishable from a wrong credential, which is the whole point, and it is one `if` away from leaking.', async () => {
    const pt = generateApiKey('live');
    const { r } = repo({ apiKey: await apiKeyRow(pt), acct: account('deleted') });
    await expect(auth(r, pt)).rejects.toBeInstanceOf(InvalidKeyError);
    await expect(auth(r, pt)).rejects.not.toBeInstanceOf(ForbiddenError);
  });

  it('CRITICAL suspended and deleted stay DISTINGUISHABLE from each other. Asserted as a pair rather than trusting the two arms above, which would both still pass if the code answered one shared error for both — and that collapse is the failure worth guarding, in either direction: leaking deletion, or hiding a suspension the customer must act on.', async () => {
    const pt = generateApiKey('live');
    const row = await apiKeyRow(pt);
    const suspended = repo({ apiKey: row, acct: account('suspended') });
    const deleted = repo({ apiKey: row, acct: account('deleted') });
    await expect(auth(suspended.r, pt)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(auth(deleted.r, pt)).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('CRITICAL an unknown web session is invalid, and says nothing more. findActiveWebSession filters unknown, expired and revoked in one query, so all three arrive here as null — and they must stay indistinguishable, or the response tells a caller holding a stale token whether that session ever existed.', async () => {
    const { r } = repo({ session: null });
    await expect(auth(r, SESSION_TOKEN)).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('CRITICAL a revoked session that the query somehow returned is still refused. Defence in depth: the SQL already excludes revoked rows, so this fires only if a repo implementation stops filtering — and nothing on the request path would notice it going, which is exactly how the admin-accounts page-size cap sat untested until a mutation went looking.', async () => {
    const { r } = repo({ session: webSession({ revokedAt: PAST }) });
    await expect(auth(r, SESSION_TOKEN)).rejects.toBeInstanceOf(RevokedKeyError);
  });

  it('CRITICAL an expired session that the query somehow returned is still refused. Same defence-in-depth recheck as revocation, and the one that matters more: expiry is clock-bound, so a repo filtering on a stale clock would return sessions the caller should no longer hold.', async () => {
    const { r } = repo({ session: webSession({ expiresAt: PAST }) });
    await expect(auth(r, SESSION_TOKEN)).rejects.toBeInstanceOf(ExpiredKeyError);
  });

  it('CRITICAL the suspended and deleted asymmetry holds on the WEB-SESSION path too, not just for API keys. The two paths repeat the check rather than sharing it, so proving it once proves it for one of them — and the dashboard is the surface where a deleted account is most likely to be probed.', async () => {
    const suspended = repo({ session: webSession(), acct: account('suspended') });
    const deleted = repo({ session: webSession(), acct: account('deleted') });
    await expect(auth(suspended.r, SESSION_TOKEN)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(auth(deleted.r, SESSION_TOKEN)).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('CRITICAL a session whose account has vanished is invalid rather than a crash. Same FK invariant as the API-key path, and the same requirement: a database that disagrees with itself must produce a 401, not a 500 on every dashboard request.', async () => {
    const { r } = repo({ session: webSession(), acct: null });
    await expect(auth(r, SESSION_TOKEN)).rejects.toBeInstanceOf(InvalidKeyError);
  });
});
