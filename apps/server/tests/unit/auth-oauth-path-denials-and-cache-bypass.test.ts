// The OAuth bearer path: every refusal, and the cache bypass that makes those
// refusals immediate.
//
// Item 5f, last cluster. `slowPathOAuthToken` carries three `InvalidKeyError`
// throws plus the suspended/deleted split, and none had executed. It is reached
// only by an `oat_`-prefixed credential, which `authenticate` dispatches BEFORE
// touching either cache:
//
//     if (plaintext.length < 24) throw new InvalidKeyError();
//     if (plaintext.startsWith('oat_')) {
//       if (oauthStore === null) throw new InvalidKeyError();
//       return slowPathOAuthToken(repo, oauthStore, plaintext, now);
//     }
//     const sha = sha256Hex(plaintext);
//     if (negativeCache?.has(sha)) throw new InvalidKeyError();
//     if (cache) { … }
//
// ─── why the bypass is the most important thing here ──────────────────────────
//
// The source states the intent: OAuth tokens "deliberately bypass the
// API-key/web-session Redis cache. Their joined store lookup rechecks token
// expiry/revocation, client revocation, and the backing api_keys authority row
// on every request, so a lifecycle mutation is effective immediately without a
// second invalidation protocol."
//
// That is a security guarantee with no invalidation machinery behind it — it
// holds only because the lookup happens every time. Move the `oat_` branch below
// the cache block and revoking an OAuth client, or the token, or the backing API
// key, stops taking effect until the entry expires. Nothing throws, no test of
// the store notices, and the window is exactly the cache TTL. So the bypass is
// asserted from both sides: a positive cache that WOULD serve a hit is never
// consulted, and the store IS consulted on every call rather than once.
//
// The negative cache is the same shape in the other direction. It is never
// populated from this path either, which matters because its entries are keyed
// on sha256(plaintext) and an OAuth token that is momentarily unresolvable —
// mid-rotation, say — must not be pinned as invalid for the negative TTL.
//
// ─── and the third copy of the enumeration asymmetry ──────────────────────────
//
// suspended → Forbidden, deleted → InvalidKeyError appears in THREE functions:
// slowPathApiKey, slowPathWebSession, and here.
//
// The parity pin's anchor for it is braced —
//
//     /if \(account\.status === 'deleted'\) \{\s*throw new InvalidKeyError\(\);/
//
// — and this path writes the check on ONE line without braces, so that anchor
// matches the other two copies and not this one. It is not that the pin sees
// this site weakly; it does not see it.
//
// MUTATION-PROVED against services/auth.ts — control 11/11 here, 19/19 on the
// parity pin. Every mutation applied alone and reverted:
//
//                                                        here   parity pin
//   the positive cache is consulted for an oat_ token    1 red    green
//   the negative cache is consulted for an oat_ token    1 red    green
//   the api_key_id fail-closed guard removed             1 red    green
//   a vanished account answers Forbidden                 1 red    green
//   SUSPENDED answers Invalid                            2 red    green
//   DELETED answers Forbidden                            2 red    green
//   the synthetic key stops naming the authority row     1 red    green
//   consented scopes replaced by a fixed set             1 red    green
//   provenance no longer marks the credential as oauth   1 red    green
//   the synthetic key loses the token's expiry           1 red    green
//   last-used is never recorded                          1 red    green
//
// ⛔ THE PIN IS 0 FOR 11, AND THE REASON IS NOT THE ONE FROM THE SIBLING FILE.
// In auth-slow-path-denials the pins were BLIND — they asserted a property and
// could not detect its loss because the block was repeated. Here they are simply
// ABSENT: neither pin mentions `slowPathOAuthToken`, `oauth_access`, `oat_` or
// `api_key_id` anywhere. Checked rather than inferred from the zero, because a
// blind guard and a missing guard produce the same column of greens and call for
// different fixes.
//
// Before this file and its sibling, `slowPathOAuthToken` was named by NO test in
// the repository. The third-party OAuth bearer path — the one an external
// integration authenticates with — had neither execution coverage nor a text
// pin. Not a weak guard: none.

import { describe, expect, it } from 'vitest';
import { authenticate } from '../../src/services/auth.js';
import { ForbiddenError, InvalidKeyError } from '../../src/lib/errors.js';

const NOW = new Date('2026-08-15T12:00:00.000Z');
const PAST = new Date('2026-08-15T11:00:00.000Z');
const EXPIRES = new Date('2026-08-15T13:00:00.000Z');
const ACCOUNT_ID = 'acc_1';
const TOKEN = `oat_${'A'.repeat(40)}`;

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

/** What a persistent store returns: note `api_key_id`, the authority row. */
const liveToken = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  api_key_id: 'key_authority_1',
  token: TOKEN,
  client_id: 'client_abc',
  account_id: ACCOUNT_ID,
  scope: ['read'],
  created_at: PAST.getTime(),
  expires_at: EXPIRES.getTime(),
  ...over,
});

interface Harness {
  repo: unknown;
  store: unknown;
  storeCalls: () => number;
  touched: () => Array<[string, Date]>;
}

function harness(opts: { token?: unknown; acct?: unknown } = {}): Harness {
  let storeCalls = 0;
  const touched: Array<[string, Date]> = [];
  return {
    storeCalls: () => storeCalls,
    touched: () => touched,
    store: {
      findTokenForAuthentication: () => {
        storeCalls += 1;
        return Promise.resolve(opts.token === undefined ? liveToken() : opts.token);
      },
    },
    repo: {
      getAccount: () => Promise.resolve(opts.acct === undefined ? account() : opts.acct),
      findApiKeyByPrefix: () => Promise.resolve(null),
      findActiveWebSession: () => Promise.resolve(null),
      findTeamMemberships: () => Promise.resolve([]),
      findActiveRateLimitOverrides: () => Promise.resolve([]),
      touchApiKeyLastUsed: (id: string, at: Date) => {
        touched.push([id, at]);
        return Promise.resolve();
      },
      touchWebSessionLastUsed: () => Promise.resolve(),
    },
  };
}

/** authenticate(repo, plaintext, cache, now, coalescer, staffEmails, negCache, store) */
const auth = (
  h: Harness,
  opts: { cache?: unknown; negativeCache?: unknown } = {},
): Promise<unknown> =>
  authenticate(
    h.repo as never,
    TOKEN,
    (opts.cache ?? null) as never,
    NOW,
    null,
    new Set<string>(),
    (opts.negativeCache ?? null) as never,
    h.store as never,
  );

describe('the OAuth bearer path refuses correctly and never trusts a cache', () => {
  it('CRITICAL a live OAuth token authenticates and carries the token’s own authority. Every refusal below would also be satisfied by a path that rejected everything, and the synthesised key is what downstream authorisation reads — so its id, scopes, expiry and provenance are asserted here rather than assumed.', async () => {
    const h = harness();
    const ctx = (await auth(h)) as {
      account: { id: string };
      apiKey: { id: string; scopes: string[]; expiresAt: Date; provenance?: string | null };
    };
    expect(ctx.account.id, 'resolved the account').toBe(ACCOUNT_ID);
    expect(ctx.apiKey.id, 'the backing api_keys authority row, not the token').toBe(
      'key_authority_1',
    );
    expect(ctx.apiKey.scopes, 'scopes are what the user consented to').toEqual(['read']);
    expect(ctx.apiKey.expiresAt.getTime(), 'expiry comes from the token').toBe(EXPIRES.getTime());
    expect(ctx.apiKey.provenance, 'marked as oauth for downstream policy').toBe('oauth');
  });

  it('CRITICAL the store is consulted on EVERY call, not once. This path has no invalidation protocol — revoking the client, the token, or the backing API key takes effect only because the joined lookup re-runs each request. A result cached anywhere would keep a revoked grant alive for the whole TTL, silently.', async () => {
    const h = harness();
    await auth(h);
    await auth(h);
    await auth(h);
    expect(h.storeCalls(), 'three requests, three authority reads').toBe(3);
  });

  it('CRITICAL a positive cache that WOULD serve a hit is never consulted for an oat_ token. The dispatch returns before the cache block; move it below and a revoked OAuth grant stays usable until the entry expires. The cache here is rigged to answer with a DIFFERENT account, so a consulted cache changes the answer rather than merely being touched.', async () => {
    let cacheReads = 0;
    const poisonedCache = {
      get: () => {
        cacheReads += 1;
        return Promise.resolve({
          account: { ...(account() as object), id: 'acc_from_cache' },
          apiKey: { id: 'key_from_cache', scopes: ['admin'], expiresAt: EXPIRES, revokedAt: null },
          teams: [],
          rateLimitOverrides: {},
          webSession: null,
        });
      },
      set: () => Promise.resolve(),
    };
    const h = harness();
    const ctx = (await auth(h, { cache: poisonedCache })) as { account: { id: string } };
    expect(cacheReads, 'the cache was never read').toBe(0);
    expect(ctx.account.id, 'and the answer came from the store').toBe(ACCOUNT_ID);
    expect(h.storeCalls(), 'which was consulted').toBe(1);
  });

  it('CRITICAL the negative cache is not consulted either. Its entries are keyed on sha256(plaintext) with a short TTL; consulting it here would pin an OAuth token that was momentarily unresolvable — mid-rotation, say — as invalid for that whole window, turning a transient condition into a hard failure the caller cannot retry out of.', async () => {
    let negReads = 0;
    const negativeCache = {
      has: () => {
        negReads += 1;
        return true; // would reject everything if consulted
      },
      add: () => undefined,
    };
    const h = harness();
    const ctx = (await auth(h, { negativeCache })) as { account: { id: string } };
    expect(negReads, 'never asked').toBe(0);
    expect(ctx.account.id, 'and the token still authenticated').toBe(ACCOUNT_ID);
  });

  it('CRITICAL an unresolvable token is invalid, and the store collapses every reason into one. The joined lookup filters unknown token, expired token, revoked token, revoked CLIENT, and a revoked or expired backing api_keys row — all arrive here as null, and they must stay indistinguishable so a caller cannot probe which of those happened.', async () => {
    const h = harness({ token: null });
    await expect(auth(h)).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('CRITICAL a token with NO backing api_key_id fails closed. A store that resolves a token but cannot name the authority row behind it — a non-persistent or partially-migrated implementation — must be refused, because everything downstream attributes rate limits, audit entries and last-used tracking to that id. Accepting it would authenticate a request that cannot be attributed to any credential.', async () => {
    const h = harness({ token: liveToken({ api_key_id: undefined }) });
    await expect(auth(h)).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('CRITICAL a token whose account has vanished is invalid rather than a crash. The store joins against the client and the api_keys row but not the account, so a deleted-account row reaching this point is possible; without the branch it is a TypeError on the authentication path rather than a 401.', async () => {
    const h = harness({ acct: null });
    await expect(auth(h)).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('CRITICAL a SUSPENDED account is refused with Forbidden and the reason, on the OAuth path too. The three authentication paths each repeat this check rather than sharing it, so proving it on two of them proves nothing about the third — and this is the one a third-party integration hits.', async () => {
    const h = harness({ acct: account('suspended') });
    await expect(auth(h)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(auth(h)).rejects.toThrow(/suspended/i);
  });

  it('CRITICAL a DELETED account is refused as INVALID, never Forbidden — the third copy of the anti-enumeration asymmetry. Forbidden confirms the account exists, so a third-party client holding an old grant could use it to test whether a given account was deleted. Invalid is indistinguishable from an unknown token, which is the point.', async () => {
    const h = harness({ acct: account('deleted') });
    await expect(auth(h)).rejects.toBeInstanceOf(InvalidKeyError);
    await expect(auth(h)).rejects.not.toBeInstanceOf(ForbiddenError);
  });

  it('CRITICAL suspended and deleted stay distinguishable from each other here. Asserted as a pair, because two arms that each check one status would both still pass against one shared error for both — the collapse that either leaks a deletion or hides a suspension the customer must act on.', async () => {
    const suspended = harness({ acct: account('suspended') });
    const deleted = harness({ acct: account('deleted') });
    await expect(auth(suspended)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(auth(deleted)).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('CRITICAL last-used is recorded against the AUTHORITY row, not the token. Rotation reminders, the unused-key sweep and the admin key list all read api_keys.last_used_at; attributing the touch to anything else would make an actively-used OAuth grant look dormant and eligible for cleanup.', async () => {
    const h = harness();
    await auth(h);
    expect(h.touched(), 'exactly one touch, on the api_keys row').toEqual([
      ['key_authority_1', NOW],
    ]);
  });
});
