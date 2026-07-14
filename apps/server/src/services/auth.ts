// Authenticate a Bearer API key against the account/api_keys store.
//
// The service is decoupled from Drizzle via an `AccountAuthRepo` interface
// so unit tests can use an in-memory fake. The real implementation lives in
// `apps/server/src/db/auth-repo.ts`.

import {
  ExpiredKeyError,
  ForbiddenError,
  InvalidKeyError,
  RevokedKeyError,
  UnauthorizedError,
} from '../lib/errors.js';
import { keyPrefixFromPlaintext, verifyApiKey } from '../lib/api-keys.js';
import type { AuthCache, AuthCacheVersions } from './auth-cache.js';
import { sha256Hex } from './auth-cache.js';
import type { AuthCoalescer } from './auth-coalescer.js';
import type { NegativeAuthCache } from './negative-auth-cache.js';
import type { OAuthStore } from './oauth.js';
import type { ApiKeyScope } from '@driftstack/api-types';
import type { AccountTier } from '@driftstack/api-types';
import type { AccountOrganization } from '@driftstack/api-types';

const CACHE_TTL_SEC = 30;

// ───────────────────────────────────────────────────────────────────────────
// Repository interface (implemented by Drizzle in prod, by a Map in tests)
// ───────────────────────────────────────────────────────────────────────────

export interface AccountRow {
  id: string;
  email: string;
  name: string | null;
  tier: AccountTier;
  status: 'active' | 'suspended' | 'deleted';
  /** V-352 — IANA timezone name (e.g. "Europe/Amsterdam"). null = UTC fallback. */
  timezone: string | null;
  /** V-352b — R2 object key for the customer's uploaded avatar.
   *  null = no avatar uploaded. The route layer turns this into a
   *  presigned GET URL on /v1/account/me reads. */
  avatarR2Key: string | null;
  /** V-298a — readable account handle (lowercase a-z + 0-9 + hyphen,
   *  3-32 chars, unique-when-set across all accounts). null = unset.
   *  Customer can set via PATCH /v1/account/me. URL routing using
   *  the slug is a future slice — for now it's a stable identifier
   *  for support / billing / audit references. */
  slug: string | null;
  /** V-298b — Stripe-style data-residency region preference: 'us',
   *  'eu', or 'apac'. null = unset (default infra routing). Customer
   *  sets via PATCH /v1/account/me. Currently informational. */
  region: 'us' | 'eu' | 'apac' | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiKeyRow {
  id: string;
  accountId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: ApiKeyScope[];
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
  /**
   * C1 — how the key was provisioned. `null`/absent = ordinary key
   * (every pre-existing key + all dashboard/staff web sessions).
   * `'cli_device'` = minted by the CLI/GUI device-code flow; the
   * device-key deny-gate bars these from account-takeover operations.
   * Optional so existing test fixtures that hand-build an ApiKeyRow keep
   * compiling; every production row flows through toApiKeyRow, which
   * always sets it from the DB column. A missing value is read as
   * "ordinary key" everywhere (fail-open — never wrongly restricts).
   */
  provenance?: string | null;
  createdAt: Date;
}

/**
 * V-168 — minimal web-session shape needed by authenticate(). Mirrors
 * the columns the auth path reads from `web_sessions`. The full row
 * (including issuedFromIp, userAgent) lives in the auth-flows repo;
 * this projection is the auth-surface contract.
 */
export interface WebSessionAuthRow {
  id: string;
  accountId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  /** V-353d/e — most recent successful MFA challenge on this session,
   *  or null if never satisfied. Step-up gates check
   *  `now - mfaSatisfiedAt < 15min`. */
  mfaSatisfiedAt: Date | null;
  createdAt: Date;
}

export interface AccountAuthRepo {
  findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null>;
  getAccount(id: string): Promise<AccountRow | null>;
  touchApiKeyLastUsed(id: string, at: Date): Promise<void>;
  /**
   * Load the active (unexpired) rate-limit overrides for an account.
   * Called on auth-cache misses and positive hits so a cleared or
   * tightened override is authoritative even if invalidation is lost.
   */
  findActiveRateLimitOverrides(accountId: string, now: Date): Promise<RateLimitOverride[]>;
  /**
   * V-168 — look up an active web session by sha256(token). Returns
   * null if not found, expired, or revoked. The auth-flows repo
   * (`DrizzleAuthFlowsRepo.findActiveWebSession`) is the upstream
   * implementation; this method on AccountAuthRepo is the auth-surface
   * adapter.
   */
  findActiveWebSession(args: { tokenHash: string; now: Date }): Promise<WebSessionAuthRow | null>;
  /** V-168 — touch the web session's last_used_at on auth success. */
  touchWebSessionLastUsed(id: string, at: Date): Promise<void>;
  /**
   * V-326 — load team memberships where this account is a MEMBER
   * (not the owner). Each row exposes the owner's account id + the
   * member's role. Returns an empty array when the account is on no
   * teams. Positive auth-cache hits refresh this live authority; cache
   * invalidation remains an accelerator, not the security boundary.
   * Memberships whose owner account is no longer active are excluded.
   */
  findTeamMemberships(memberAccountId: string): Promise<TeamMembership[]>;
  /**
   * V-352 — patch self-editable basics on the account (name,
   * timezone). Returns the updated row. Used by PATCH /v1/account/me.
   * Email + tier + status + stripeCustomerId are NOT editable here —
   * those go through dedicated flows (auth-flows for email; Stripe
   * webhooks for tier; admin force-actions for status).
   *
   * V-352b — `avatarR2Key` accepted too; null clears the avatar
   * reference (the actual R2 object cleanup is best-effort handled
   * by the route layer).
   */
  updateAccountBasics(
    id: string,
    patch: {
      name?: string | null;
      timezone?: string | null;
      avatarR2Key?: string | null;
      /** V-298a — slug (lowercase a-z + 0-9 + hyphen, 3-32 chars).
       *  null clears. Caller (route layer) is responsible for
       *  validating shape; the repo layer just persists.  Returns
       *  null if a unique-constraint conflict fires (e.g. another
       *  account already owns the slug). */
      slug?: string | null;
      /** V-298b — region enum 'us'|'eu'|'apac' or null to clear. */
      region?: 'us' | 'eu' | 'apac' | null;
    },
  ): Promise<AccountRow | null>;
  /**
   * Per-account org-sync (2026-06-16) — read/write the account-level
   * organization taxonomy (the empty folders + tags a customer defines in the
   * GUI rail before assigning them). Backed by accounts.organization jsonb
   * (0079). getOrganization returns the stored {folders, tags} (empty arrays
   * when unset); null only when the account no longer exists.
   */
  getOrganization(id: string): Promise<AccountOrganization | null>;
  setOrganization(id: string, org: AccountOrganization): Promise<void>;
}

// ───────────────────────────────────────────────────────────────────────────
// Context attached to authenticated requests
// ───────────────────────────────────────────────────────────────────────────

export interface RateLimitOverride {
  bucketKey: string;
  capacity: number;
  refillPerSecond: number;
  expiresAt: Date;
}

/**
 * V-326 — team membership the authenticated account belongs to as a
 * MEMBER (not as the owner). Loaded on auth-cache misses and refreshed
 * on every positive cache hit, so membership/role/owner-status changes
 * remain authoritative even if distributed invalidation is lost. Used
 * by the effective-account resolver (`resolveEffectiveAccount` below)
 * so a member can act on the owner's resources by passing
 * `X-Driftstack-Account: acc_<owner>`.
 */
export interface TeamMembership {
  membershipId: string;
  ownerAccountId: string;
  /**
   * The owner account's email — loaded via a join (findTeamMemberships) so the
   * dashboard can label a team by who owns it (instead of a bare `acc_<uuid>`).
   * The accounts.email column is NOT NULL, so the repos always populate this;
   * it's optional in the type only so the in-memory test seam can omit it (the
   * repo fills a fallback on read). Route serializers default a missing value.
   */
  ownerEmail?: string;
  /** The owner account's display name; null when the owner never set one.
   *  Optional for the same test-seam reason as `ownerEmail`. */
  ownerName?: string | null;
  role: 'member' | 'admin';
}

export interface AccountContext {
  account: AccountRow;
  apiKey: ApiKeyRow;
  /**
   * Active (unexpired) rate-limit overrides for this account, keyed by
   * bucketKey. Refreshed on every positive cache hit. When an override
   * expires, `rateLimitConsume` also falls through to the tier default
   * lazily, without a background sweep.
   */
  rateLimitOverrides: Record<string, RateLimitOverride>;
  /**
   * V-326 — owner accounts this account is a member of, with role.
   * Empty array for accounts that aren't on any team. Always present
   * (never undefined) so call sites can iterate without a null check.
   */
  teams: TeamMembership[];
  /**
   * V-353e — populated when the request authenticated via a web
   * session (dashboard / GUI bearer); null for API-key callers. The
   * step-up gate (`requireMfaFresh`) reads `mfaSatisfiedAt` against
   * the 15-min freshness window. API-key callers bypass the gate
   * (they're machine-to-machine; MFA is a human-factor concept).
   */
  webSession: { id: string; mfaSatisfiedAt: Date | null } | null;
}

// ───────────────────────────────────────────────────────────────────────────
// Authentication entrypoint
// ───────────────────────────────────────────────────────────────────────────

const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;

export function extractBearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader) {
    throw new UnauthorizedError('Missing Authorization header.');
  }
  const match = BEARER_RE.exec(authorizationHeader);
  if (!match || !match[1]) {
    throw new UnauthorizedError('Malformed Authorization header. Expected "Bearer <key>".');
  }
  return match[1];
}

export async function authenticate(
  repo: AccountAuthRepo,
  plaintext: string,
  cache: AuthCache | null = null,
  now: Date = new Date(),
  coalescer: AuthCoalescer | null = null,
  /**
   * 2026-05-19 — when a web-session resolves to an account whose
   * email is in this set, the synthetic ApiKeyRow's scopes get
   * `driftstack_internal_admin` appended. Lets a small operation
   * keep staff identity coupled to the same dashboard auth flow
   * customers use (no separate staff-only credential to lose track
   * of). Empty set or undefined → no staff bump (default).
   *
   * Lowercase comparison; the bootstrap parser lowercases entries.
   * NEVER reads the plaintext — only the resolved account email.
   */
  staffEmails: ReadonlySet<string> = new Set(),
  /**
   * DoS hardening — short-TTL negative cache keyed by sha256(plaintext).
   * On a hit we know this exact token was JUST rejected as invalid, so we
   * 401 immediately and skip the prefix lookup + scrypt verify (the
   * expensive ungated work an unauthenticated bogus-token flood drives).
   * null/undefined → no negative caching (tests / fixtures without it).
   * Only the unambiguous InvalidKeyError outcome is cached; never
   * revoked/expired/suspended/forbidden (state that can flip back).
   */
  negativeCache: NegativeAuthCache | null = null,
  /**
   * Persistent third-party OAuth bearer authority. Optional keeps isolated
   * service tests and pre-provider app fixtures source-compatible; an `oat_`
   * credential fails closed when the store is absent.
   */
  oauthStore: OAuthStore | null = null,
): Promise<AccountContext> {
  if (plaintext.length < 24) throw new InvalidKeyError();

  // OAuth access tokens deliberately bypass the API-key/web-session Redis
  // cache. Their joined store lookup rechecks token expiry/revocation, client
  // revocation, and the backing api_keys authority row on every request, so a
  // lifecycle mutation is effective immediately without a second invalidation
  // protocol.
  if (plaintext.startsWith('oat_')) {
    if (oauthStore === null) throw new InvalidKeyError();
    return slowPathOAuthToken(repo, oauthStore, plaintext, now);
  }

  // Cache fast path: if Redis has a fresh entry for sha256(plaintext), skip
  // the prefix lookup + scrypt verification entirely. The cache may also
  // throw (broken Redis, network blip, etc.) — graceful degradation is
  // belt-and-suspenders: the cache impl swallows internally AND we wrap
  // here in case a future impl forgets.
  const sha = sha256Hex(plaintext);

  // Negative fast path: a token we just rejected as invalid cannot have
  // become valid (a real new key has a fresh random body → a different
  // sha). Short-circuit before any DB/scrypt work so a bogus-token flood
  // can't keep paying the prefix-lookup + scrypt cost on repeats.
  if (negativeCache?.has(sha)) {
    throw new InvalidKeyError();
  }
  if (cache) {
    let cached: AccountContext | null = null;
    try {
      cached = await cache.get(sha);
    } catch {
      cached = null;
    }
    if (cached) {
      // Expiry is clock-bound, so re-check it on every cache read even when
      // the backing authority has not changed.
      if (cached.apiKey.expiresAt !== null && cached.apiKey.expiresAt.getTime() <= now.getTime()) {
        throw new ExpiredKeyError();
      }

      // Redis generation bumps are cache accelerators, not authority. Every
      // positive hit re-reads the live account, exact credential, team grants,
      // and active rate-limit overrides in parallel, so a process crash or
      // Redis failure after a PostgreSQL revoke/rotate/reset/MFA/status/
      // membership/override mutation cannot extend stale authority to the
      // cache TTL. These are indexed reads; API-key hits still avoid scrypt.
      if (cached.webSession !== null) {
        // findActiveWebSession joins the session to the account's current auth
        // epoch and filters revocation/expiry.
        const [liveSession, liveAccount, liveTeams, liveOverrideRows] = await Promise.all([
          repo.findActiveWebSession({ tokenHash: sha, now }),
          repo.getAccount(cached.account.id),
          repo.findTeamMemberships(cached.account.id),
          repo.findActiveRateLimitOverrides(cached.account.id, now),
        ]);
        if (
          liveSession === null ||
          liveSession.id !== cached.webSession.id ||
          liveSession.accountId !== cached.account.id ||
          liveSession.accountId !== cached.apiKey.accountId ||
          cached.apiKey.id !== `wsk_${liveSession.id}`
        ) {
          throw new InvalidKeyError();
        }
        // Defensive checks keep custom repo implementations honest even though
        // the production query has already applied both predicates.
        if (liveSession.revokedAt !== null) throw new RevokedKeyError();
        if (liveSession.expiresAt.getTime() <= now.getTime()) throw new ExpiredKeyError();
        if (liveAccount === null || liveAccount.id !== liveSession.accountId) {
          throw new InvalidKeyError();
        }
        if (liveAccount.status === 'suspended') {
          throw new ForbiddenError('Account is suspended.');
        }
        if (liveAccount.status === 'deleted') throw new InvalidKeyError();

        const baseScopes: ApiKeyRow['scopes'] = ['read', 'write', 'account_owner'];
        const scopes: ApiKeyRow['scopes'] = staffEmails.has(liveAccount.email.toLowerCase())
          ? [...baseScopes, 'driftstack_internal_admin']
          : baseScopes;

        return {
          ...cached,
          account: liveAccount,
          teams: liveTeams,
          rateLimitOverrides: indexRateLimitOverrides(liveOverrideRows),
          apiKey: {
            ...cached.apiKey,
            scopes,
            lastUsedAt: liveSession.lastUsedAt,
            revokedAt: liveSession.revokedAt,
            expiresAt: liveSession.expiresAt,
          },
          webSession: {
            id: liveSession.id,
            mfaSatisfiedAt: liveSession.mfaSatisfiedAt,
          },
        };
      }

      const [liveApiKey, liveAccount, liveTeams, liveOverrideRows] = await Promise.all([
        repo.findApiKeyByPrefix(cached.apiKey.keyPrefix),
        repo.getAccount(cached.account.id),
        repo.findTeamMemberships(cached.account.id),
        repo.findActiveRateLimitOverrides(cached.account.id, now),
      ]);
      if (
        liveApiKey === null ||
        liveApiKey.id !== cached.apiKey.id ||
        liveApiKey.accountId !== cached.account.id ||
        liveApiKey.accountId !== cached.apiKey.accountId ||
        liveApiKey.keyHash !== cached.apiKey.keyHash
      ) {
        throw new InvalidKeyError();
      }
      if (liveApiKey.revokedAt !== null) throw new RevokedKeyError();
      if (liveApiKey.expiresAt !== null && liveApiKey.expiresAt.getTime() <= now.getTime()) {
        throw new ExpiredKeyError();
      }
      if (liveAccount === null || liveAccount.id !== liveApiKey.accountId) {
        throw new InvalidKeyError();
      }
      if (liveAccount.status === 'suspended') {
        throw new ForbiddenError('Account is suspended.');
      }
      if (liveAccount.status === 'deleted') throw new InvalidKeyError();

      // last_used_at remains sampled at cache TTL granularity. Live key scopes,
      // provenance, expiry, account tier/status/profile authority, team roles,
      // and resource-limit policy are refreshed if invalidation was lost.
      return {
        ...cached,
        account: liveAccount,
        apiKey: liveApiKey,
        teams: liveTeams,
        rateLimitOverrides: indexRateLimitOverrides(liveOverrideRows),
      };
    }
  }

  // Slow path: dispatch by token shape.
  //   - `ds_*` prefix → API key path (prefix lookup + scrypt verify).
  //   - everything else → V-168 web session path (sha256 lookup against
  //     `web_sessions` row).
  // Both paths converge on the same AccountContext + cache write.
  //
  // A web-session token is URL-safe-base64 random bytes, so ~1 in 262k of
  // them begin with `ds_` by chance and route to the API-key path. When no
  // API key carries that prefix we fall through to the web-session path
  // rather than failing — otherwise that unlucky session could never
  // authenticate (a silent, permanent session break).
  const innerSlowPath = async (): Promise<AccountContext> => {
    if (isApiKeyShape(plaintext)) {
      const viaApiKey = await slowPathApiKey(repo, plaintext, sha, cache, now, {
        fallThroughOnPrefixMiss: true,
      });
      if (viaApiKey !== null) return viaApiKey;
      // ds_-shaped but no API key with this prefix — try the web session.
    }
    return slowPathWebSession(repo, plaintext, sha, cache, now, staffEmails);
  };

  // Record the unambiguous "invalid credential" outcome in the negative
  // cache so repeats of the SAME bogus token skip the prefix lookup +
  // scrypt verify. Only InvalidKeyError (unknown prefix / scrypt mismatch
  // / unknown web-session) is cached — never revoked/expired/suspended/
  // forbidden, whose state can flip back and is owned by the positive
  // cache + version counters.
  const slowPath = negativeCache
    ? async (): Promise<AccountContext> => {
        try {
          return await innerSlowPath();
        } catch (err) {
          if (err instanceof InvalidKeyError) negativeCache.markInvalid(sha);
          throw err;
        }
      }
    : innerSlowPath;

  if (coalescer) return coalescer.coalesce(sha, slowPath);
  return slowPath();
}

async function slowPathOAuthToken(
  repo: AccountAuthRepo,
  store: OAuthStore,
  plaintext: string,
  now: Date,
): Promise<AccountContext> {
  const token = await store.findTokenForAuthentication(plaintext, now.getTime());
  if (token === null || token.api_key_id === undefined) throw new InvalidKeyError();

  const account = await repo.getAccount(token.account_id);
  if (account === null) throw new InvalidKeyError();
  if (account.status === 'suspended') throw new ForbiddenError('Account is suspended.');
  if (account.status === 'deleted') throw new InvalidKeyError();

  await repo.touchApiKeyLastUsed(token.api_key_id, now);
  const [overrideRows, teams] = await Promise.all([
    repo.findActiveRateLimitOverrides(account.id, now),
    repo.findTeamMemberships(account.id),
  ]);
  const apiKey: ApiKeyRow = {
    id: token.api_key_id,
    accountId: token.account_id,
    name: `OAuth: ${token.client_id}`,
    keyPrefix: 'oauth_access',
    keyHash: sha256Hex(plaintext),
    scopes: [...token.scope],
    lastUsedAt: now,
    revokedAt: null,
    expiresAt: new Date(token.expires_at),
    provenance: 'oauth',
    createdAt: new Date(token.created_at),
  };
  return {
    account,
    apiKey,
    rateLimitOverrides: indexRateLimitOverrides(overrideRows),
    teams,
    webSession: null,
  };
}

/**
 * V-168 — distinguish API keys from web session tokens by the `ds_`
 * prefix that {@link generateApiKey} stamps on every key. Web session
 * tokens are URL-safe base64 random bytes with no prefix.
 */
function isApiKeyShape(plaintext: string): boolean {
  return plaintext.startsWith('ds_');
}

async function slowPathApiKey(
  repo: AccountAuthRepo,
  plaintext: string,
  sha: string,
  cache: AuthCache | null,
  now: Date,
  opts: { fallThroughOnPrefixMiss?: boolean } = {},
): Promise<AccountContext | null> {
  const prefix = keyPrefixFromPlaintext(plaintext);
  let apiKey = await repo.findApiKeyByPrefix(prefix);
  if (!apiKey) {
    // No API key carries this prefix. Normally an invalid credential, but
    // when the caller allows it we return null so the dispatcher can try
    // the web-session path (covers a session token that begins with `ds_`
    // by chance). A scrypt MISMATCH below still throws — that means a real
    // key with this prefix exists and its secret is wrong, which is a bad
    // API key, never a web-session token.
    if (opts.fallThroughOnPrefixMiss) return null;
    throw new InvalidKeyError();
  }

  const matches = await verifyApiKey(plaintext, apiKey.keyHash);
  if (!matches) throw new InvalidKeyError();

  if (apiKey.revokedAt !== null) throw new RevokedKeyError();
  if (apiKey.expiresAt !== null && apiKey.expiresAt.getTime() <= now.getTime()) {
    throw new ExpiredKeyError();
  }

  // Capture both cache generations, then re-read the exact key authority.
  // Revoke/rotation commits its DB mutation before invalidating the key
  // generation. If invalidation already won, this recheck observes the
  // mutation; if it wins later, the eventual cache entry keeps the captured
  // older generation and is therefore an immediate miss.
  let capturedVersions: AuthCacheVersions | null = null;
  if (cache?.captureVersions) {
    try {
      capturedVersions = await cache.captureVersions(apiKey.accountId, apiKey.id);
    } catch {
      capturedVersions = null;
    }
    if (capturedVersions !== null) {
      const revalidated = await repo.findApiKeyByPrefix(prefix);
      if (!revalidated || revalidated.id !== apiKey.id || revalidated.keyHash !== apiKey.keyHash) {
        throw new InvalidKeyError();
      }
      if (revalidated.revokedAt !== null) throw new RevokedKeyError();
      if (revalidated.expiresAt !== null && revalidated.expiresAt.getTime() <= now.getTime()) {
        throw new ExpiredKeyError();
      }
      apiKey = revalidated;
    }
  }

  const account = await repo.getAccount(apiKey.accountId);
  if (!account) throw new InvalidKeyError(); // FK invariant — treat as invalid
  if (account.status === 'suspended') {
    throw new ForbiddenError('Account is suspended.');
  }
  if (account.status === 'deleted') {
    throw new InvalidKeyError();
  }

  await repo.touchApiKeyLastUsed(apiKey.id, now);

  const [overrideRows, teams] = await Promise.all([
    repo.findActiveRateLimitOverrides(account.id, now),
    repo.findTeamMemberships(account.id),
  ]);
  const rateLimitOverrides = indexRateLimitOverrides(overrideRows);
  const ctx: AccountContext = {
    account,
    apiKey,
    rateLimitOverrides,
    teams,
    webSession: null, // API-key auth path; no web session.
  };

  // Cap TTL at expiresAt so the cache entry can never outlive the key.
  if (cache && capturedVersions !== null) {
    let ttl = CACHE_TTL_SEC;
    if (apiKey.expiresAt !== null) {
      const remaining = Math.floor((apiKey.expiresAt.getTime() - now.getTime()) / 1000);
      if (remaining < ttl) ttl = Math.max(1, remaining);
    }
    try {
      await cache.set(sha, apiKey.id, account.id, ctx, ttl, capturedVersions);
    } catch {
      // Cache write failed — auth still completed via scrypt path. Drop on
      // the floor; next request will retry the cache write.
    }
  }

  return ctx;
}

/**
 * V-168 — web session bearer auth. Token is sha256-hashed for the
 * lookup (web sessions are opaque sha256-stored per D-028). On
 * success, builds an AccountContext with a synthetic ApiKeyRow
 * (`wsk_<webSessionId>`) so downstream code that reads
 * `ctx.apiKey.id` / `.scopes` / `.accountId` continues to work
 * uniformly.
 *
 * SCOPE: web sessions get `['read', 'write', 'account_owner']` — full
 * customer-account control (mint + revoke their own API keys, manage
 * subscription, `/v1/account/*`) without a pre-existing API key.
 * Staff-allowlisted emails additionally get `driftstack_internal_admin`
 * for `/v1/admin/*`. See the scope assignment + staff-bump rationale at
 * the `baseScopes` declaration below.
 *
 * V-174 (shipped) closed the prior cross-account exposure: web sessions
 * no longer carry the legacy `admin` scope, which had conflated
 * customer-account control with Driftstack-staff `/v1/admin/*` access
 * (any 'admin'-scoped dashboard user could otherwise act on OTHER
 * customers' accounts). `/v1/admin/*` now requires
 * `driftstack_internal_admin`, granted only to staff-allowlisted
 * logins; `admin.driftstack.dev` remains a separate Cloudflare-Access-
 * gated origin (V-135) as defense-in-depth.
 */
async function slowPathWebSession(
  repo: AccountAuthRepo,
  _plaintext: string,
  sha: string,
  cache: AuthCache | null,
  now: Date,
  staffEmails: ReadonlySet<string>,
): Promise<AccountContext> {
  let session = await repo.findActiveWebSession({ tokenHash: sha, now });
  // findActiveWebSession already filters expired + revoked rows in the
  // query. A null result here means: token unknown OR expired OR
  // revoked. We can't distinguish the cases (and shouldn't — same
  // 401 InvalidKey response avoids leaking session state).
  if (!session) throw new InvalidKeyError();

  // Defensive: re-check expiry/revocation in case repo impl skips them.
  if (session.revokedAt !== null) throw new RevokedKeyError();
  if (session.expiresAt.getTime() <= now.getTime()) throw new ExpiredKeyError();

  // Capture the cache generations, then re-read the authoritative session.
  // Password reset commits its DB epoch change before invalidating the account
  // generation. The ordering closes both sides of a late-write race:
  // an invalidation already observed here makes the second DB read reject,
  // while an invalidation after it makes the captured generation stale.
  let capturedVersions: AuthCacheVersions | null = null;
  if (cache?.captureVersions) {
    try {
      capturedVersions = await cache.captureVersions(session.accountId, `wsk_${session.id}`);
    } catch {
      capturedVersions = null;
    }
    if (capturedVersions !== null) {
      const revalidated = await repo.findActiveWebSession({ tokenHash: sha, now });
      if (!revalidated || revalidated.id !== session.id) throw new InvalidKeyError();
      session = revalidated;
    }
  }

  const account = await repo.getAccount(session.accountId);
  if (!account) throw new InvalidKeyError();
  if (account.status === 'suspended') {
    throw new ForbiddenError('Account is suspended.');
  }
  if (account.status === 'deleted') {
    throw new InvalidKeyError();
  }

  await repo.touchWebSessionLastUsed(session.id, now);

  const [overrideRows, teams] = await Promise.all([
    repo.findActiveRateLimitOverrides(account.id, now),
    repo.findTeamMemberships(account.id),
  ]);
  const rateLimitOverrides = indexRateLimitOverrides(overrideRows);

  // Synthetic ApiKeyRow shape so downstream consumers don't need to
  // branch on auth mode. `id = wsk_<webSessionId>` makes the auth
  // mode legible in audit logs (admin_audit_log.admin_key_id starts
  // with `wsk_`).
  //
  // V-174 — scope is `['read', 'write', 'account_owner']`. The dashboard
  // user has full customer-account control (mint keys, revoke keys,
  // manage subscription) but does NOT have driftstack_internal_admin
  // — that's gated separately for Driftstack-staff-only operations.
  // Pre-V-174 this synthetic key carried 'admin' scope which conflated
  // both; V-174 closes the cross-account `/v1/admin/*` exposure.
  // 2026-05-19 — staff bump. If the resolved account's email is in
  // the DRIFTSTACK_STAFF_EMAILS allowlist (parsed from env at boot,
  // threaded in via authenticate()'s staffEmails param), the
  // synthetic key gets `driftstack_internal_admin` appended so the
  // dashboard user can hit /v1/admin/* without minting a separate
  // staff-only API key. This is intentionally narrow: it ONLY
  // applies to web-session auth (NOT api-key auth), and the
  // allowlist is set-once at bootstrap so a rotation requires a
  // server restart. Staff identity stays coupled to the same login
  // flow customers use.
  const baseScopes: ApiKeyRow['scopes'] = ['read', 'write', 'account_owner'];
  const accountEmail = account.email.toLowerCase();
  const scopes: ApiKeyRow['scopes'] = staffEmails.has(accountEmail)
    ? [...baseScopes, 'driftstack_internal_admin']
    : baseScopes;
  const syntheticKey: ApiKeyRow = {
    id: `wsk_${session.id}`,
    accountId: session.accountId,
    name: 'web-session',
    keyPrefix: 'web_session',
    keyHash: '', // never read for web sessions; defensive empty string
    scopes,
    lastUsedAt: session.lastUsedAt,
    revokedAt: session.revokedAt,
    expiresAt: session.expiresAt,
    // C1 — web sessions are never device-provisioned, so the deny-gate
    // never treats a dashboard/staff session as a restricted device key.
    provenance: null,
    createdAt: session.createdAt,
  };

  const ctx: AccountContext = {
    account,
    apiKey: syntheticKey,
    rateLimitOverrides,
    teams,
    webSession: { id: session.id, mfaSatisfiedAt: session.mfaSatisfiedAt },
  };

  // Cap TTL at session expiry so the cache entry can never outlive the
  // session token. Same shape as the API key path.
  if (cache && capturedVersions !== null) {
    let ttl = CACHE_TTL_SEC;
    const remaining = Math.floor((session.expiresAt.getTime() - now.getTime()) / 1000);
    if (remaining < ttl) ttl = Math.max(1, remaining);
    try {
      await cache.set(sha, syntheticKey.id, account.id, ctx, ttl, capturedVersions);
    } catch {
      // Same graceful-degradation as the API key path.
    }
  }

  return ctx;
}

function indexRateLimitOverrides(
  rows: readonly RateLimitOverride[],
): Record<string, RateLimitOverride> {
  const indexed: Record<string, RateLimitOverride> = {};
  for (const row of rows) indexed[row.bucketKey] = row;
  return indexed;
}

// ───────────────────────────────────────────────────────────────────────────
// Scope check
// ───────────────────────────────────────────────────────────────────────────

/**
 * V-174 + V-481 — scope check with backwards-compat aliases. See
 * `lib/errors-helpers.ts::requireScope` for the canonical predicate;
 * this clone exists because route-side imports want zero indirection.
 *
 *   1. Exact match.
 *   2. V-174 legacy customer alias — `'admin'` satisfies
 *      `'account_owner'`, but never the staff-only
 *      `'driftstack_internal_admin'` boundary.
 *   3. V-481 broad-satisfies-granular — required `read:X` accepted
 *      from `read` / `account_owner`; `write:X` from `write` /
 *      `account_owner`; `admin:X` from `admin` / `account_owner`.
 *      Granular scopes do NOT satisfy broad checks.
 */
export function requireScope(ctx: AccountContext, required: ApiKeyScope): void {
  const scopes = ctx.apiKey.scopes;
  if (scopes.includes(required)) return;

  // V-174 legacy customer alias. Never satisfies the staff-only scope.
  if (required === 'account_owner' && scopes.includes('admin')) {
    return;
  }

  // account_owner is the customer's full-account-control superscope — it
  // satisfies the BARE `read`/`write` verbs, not just the granular ones below.
  // Without this, an account_owner-ONLY key (what cli-authorize mints for the
  // desktop device-login, scopes:['account_owner']) failed requireScope('write')
  // → every session launch 403'd. account_owner does NOT satisfy the bare
  // `admin`/`driftstack_internal_admin` STAFF gates (handled above / below).
  if ((required === 'read' || required === 'write') && scopes.includes('account_owner')) {
    return;
  }

  // V-481 broad-satisfies-granular.
  const idx = required.indexOf(':');
  if (idx !== -1) {
    const verb = required.slice(0, idx);
    if (
      (verb === 'read' && (scopes.includes('read') || scopes.includes('account_owner'))) ||
      (verb === 'write' && (scopes.includes('write') || scopes.includes('account_owner'))) ||
      (verb === 'admin' && (scopes.includes('admin') || scopes.includes('account_owner')))
    ) {
      return;
    }
  }

  throw new ForbiddenError(`This action requires the "${required}" scope.`);
}

// ───────────────────────────────────────────────────────────────────────────
// V-326 — effective-account resolver for Team RBAC
// ───────────────────────────────────────────────────────────────────────────

/**
 * Result of resolving a request's "effective account" — the account
 * whose resources the request acts on. For a non-team-member request,
 * effective = ctx.account (the calling account itself); for a team
 * member acting on the owner's behalf, effective = the owner account
 * + the membership row that grants access.
 *
 * Routes that participate in team RBAC call `resolveEffectiveAccount`
 * once and use `effective.accountId` everywhere they previously used
 * `ctx.account.id`. Membership.role lets the route enforce role-based
 * restrictions (e.g. only `admin` members can rotate keys).
 */
export type EffectiveAccount =
  | { kind: 'self'; accountId: string }
  | {
      kind: 'team';
      accountId: string;
      role: 'member' | 'admin';
      membership: TeamMembership;
    };

/**
 * Resolve the effective account for a request. The caller passes the
 * (optional) `X-Driftstack-Account` header value (a public account id
 * like `acc_<uuid>`); when present + valid, the resolver looks up the
 * matching team membership and returns the owner-account scope.
 *
 * Forbidden cases:
 *   - Header references an account the caller is neither owner of nor
 *     member on → 403.
 *   - Header references the caller's own account → equivalent to no
 *     header (kind: 'self'). Documented for clarity, not error.
 *
 * Header shape is `acc_<uuid>` exactly; case-sensitive prefix match.
 */
export function resolveEffectiveAccount(
  ctx: AccountContext,
  requestedAccountIdHeader: string | undefined,
): EffectiveAccount {
  if (!requestedAccountIdHeader || requestedAccountIdHeader.length === 0) {
    return { kind: 'self', accountId: ctx.account.id };
  }
  const PREFIX = 'acc_';
  if (!requestedAccountIdHeader.startsWith(PREFIX)) {
    throw new ForbiddenError(
      'Invalid X-Driftstack-Account header. Expected an account id of shape "acc_<uuid>".',
    );
  }
  const requestedUuid = requestedAccountIdHeader.slice(PREFIX.length);
  if (requestedUuid === ctx.account.id) {
    return { kind: 'self', accountId: ctx.account.id };
  }
  const membership = ctx.teams.find((t) => t.ownerAccountId === requestedUuid);
  if (!membership) {
    throw new ForbiddenError('X-Driftstack-Account references an account you are not a member of.');
  }
  return {
    kind: 'team',
    accountId: membership.ownerAccountId,
    role: membership.role,
    membership,
  };
}
