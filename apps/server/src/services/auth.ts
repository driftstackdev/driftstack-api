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
import type { AuthCache } from './auth-cache.js';
import { sha256Hex } from './auth-cache.js';
import type { AuthCoalescer } from './auth-coalescer.js';
import type { ApiKeyScope } from '@driftstack/api-types';
import type { AccountTier } from '@driftstack/api-types';

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
  createdAt: Date;
}

export interface AccountAuthRepo {
  findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null>;
  getAccount(id: string): Promise<AccountRow | null>;
  touchApiKeyLastUsed(id: string, at: Date): Promise<void>;
  /**
   * Load the active (unexpired) rate-limit overrides for an account.
   * Called once per auth-cache miss; the overrides are then cached
   * inside the AccountContext until the next invalidation.
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
   * teams. Cached inside AccountContext.teams across the auth-cache
   * TTL; cache-invalidated on membership changes via the team-members
   * service's accept / removeMember paths.
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
    },
  ): Promise<AccountRow | null>;
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
 * MEMBER (not as the owner). Loaded alongside rate-limit overrides on
 * auth-cache miss; cache-invalidated whenever the membership row
 * changes (accept / remove). Used by the effective-account resolver
 * (`resolveEffectiveAccount` below) so a member can act on the
 * owner's resources by passing `X-Driftstack-Account: acc_<owner>`.
 */
export interface TeamMembership {
  membershipId: string;
  ownerAccountId: string;
  role: 'member' | 'admin';
}

export interface AccountContext {
  account: AccountRow;
  apiKey: ApiKeyRow;
  /**
   * Active (unexpired) rate-limit overrides for this account, keyed by
   * bucketKey. Loaded once on auth-cache miss; subsequent reads come
   * from the cache. When an override expires, `rateLimitConsume` falls
   * through to the tier default (lazy expiry — no background sweep).
   */
  rateLimitOverrides: Record<string, RateLimitOverride>;
  /**
   * V-326 — owner accounts this account is a member of, with role.
   * Empty array for accounts that aren't on any team. Always present
   * (never undefined) so call sites can iterate without a null check.
   */
  teams: TeamMembership[];
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
): Promise<AccountContext> {
  if (plaintext.length < 24) throw new InvalidKeyError();

  // Cache fast path: if Redis has a fresh entry for sha256(plaintext), skip
  // the prefix lookup + scrypt verification entirely. The cache may also
  // throw (broken Redis, network blip, etc.) — graceful degradation is
  // belt-and-suspenders: the cache impl swallows internally AND we wrap
  // here in case a future impl forgets.
  const sha = sha256Hex(plaintext);
  if (cache) {
    let cached: AccountContext | null = null;
    try {
      cached = await cache.get(sha);
    } catch {
      cached = null;
    }
    if (cached) {
      // expiresAt is the only clock-bound condition that can change inside
      // the TTL window — re-check on every cache read so an expiry doesn't
      // leak past its deadline.
      if (cached.apiKey.expiresAt !== null && cached.apiKey.expiresAt.getTime() <= now.getTime()) {
        throw new ExpiredKeyError();
      }
      // Skip the last_used_at touch on cache hits — sampled at TTL granularity
      // (once per 30s in the worst case), which is the acceptable trade for
      // amortising scrypt across the burst window.
      return cached;
    }
  }

  // Slow path: dispatch by token shape.
  //   - `ds_*` prefix → API key path (prefix lookup + scrypt verify).
  //   - everything else → V-168 web session path (sha256 lookup against
  //     `web_sessions` row).
  // Both paths converge on the same AccountContext + cache write.
  const slowPath = async (): Promise<AccountContext> =>
    isApiKeyShape(plaintext)
      ? slowPathApiKey(repo, plaintext, sha, cache, now)
      : slowPathWebSession(repo, plaintext, sha, cache, now);

  if (coalescer) return coalescer.coalesce(sha, slowPath);
  return slowPath();
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
): Promise<AccountContext> {
  const prefix = keyPrefixFromPlaintext(plaintext);
  const apiKey = await repo.findApiKeyByPrefix(prefix);
  if (!apiKey) throw new InvalidKeyError();

  const matches = await verifyApiKey(plaintext, apiKey.keyHash);
  if (!matches) throw new InvalidKeyError();

  if (apiKey.revokedAt !== null) throw new RevokedKeyError();
  if (apiKey.expiresAt !== null && apiKey.expiresAt.getTime() <= now.getTime()) {
    throw new ExpiredKeyError();
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
  const rateLimitOverrides: Record<string, RateLimitOverride> = {};
  for (const o of overrideRows) {
    rateLimitOverrides[o.bucketKey] = o;
  }
  const ctx: AccountContext = { account, apiKey, rateLimitOverrides, teams };

  // Cap TTL at expiresAt so the cache entry can never outlive the key.
  if (cache) {
    let ttl = CACHE_TTL_SEC;
    if (apiKey.expiresAt !== null) {
      const remaining = Math.floor((apiKey.expiresAt.getTime() - now.getTime()) / 1000);
      if (remaining < ttl) ttl = Math.max(1, remaining);
    }
    try {
      await cache.set(sha, apiKey.id, account.id, ctx, ttl);
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
 * SCOPE: web sessions get `['read', 'write', 'admin']` — full
 * customer-account control. The 'admin' scope is required by
 * `/v1/api-keys` POST + DELETE (a customer logged into their own
 * dashboard expects to mint + revoke their own API keys without
 * a pre-existing admin key).
 *
 * KNOWN GAP (pre-existing, not introduced by V-168):
 * `requireScope('admin')` on `/v1/admin/*` routes also fires for
 * any 'admin'-scoped customer key, including web sessions. A
 * customer with admin scope on their own account could theoretically
 * call `/v1/admin/accounts` and act on OTHER customers' accounts.
 * This was true pre-V-168 (any customer-minted admin key could do
 * the same); V-168 makes it true for every dashboard user. Surfaced
 * for a separate scope-architecture refactor (split 'admin' into
 * 'account_owner' + 'driftstack_internal_admin', OR add an
 * isDriftstackInternal flag on accounts). Operationally mitigated
 * today by `admin.driftstack.dev` being a separate Cloudflare-Access-
 * gated origin per V-135 — the route handlers are not reachable from
 * customer dashboard origin without crossing the SSO gate.
 */
async function slowPathWebSession(
  repo: AccountAuthRepo,
  _plaintext: string,
  sha: string,
  cache: AuthCache | null,
  now: Date,
): Promise<AccountContext> {
  const session = await repo.findActiveWebSession({ tokenHash: sha, now });
  // findActiveWebSession already filters expired + revoked rows in the
  // query. A null result here means: token unknown OR expired OR
  // revoked. We can't distinguish the cases (and shouldn't — same
  // 401 InvalidKey response avoids leaking session state).
  if (!session) throw new InvalidKeyError();

  // Defensive: re-check expiry/revocation in case repo impl skips them.
  if (session.revokedAt !== null) throw new RevokedKeyError();
  if (session.expiresAt.getTime() <= now.getTime()) throw new ExpiredKeyError();

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
  const rateLimitOverrides: Record<string, RateLimitOverride> = {};
  for (const o of overrideRows) {
    rateLimitOverrides[o.bucketKey] = o;
  }

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
  const syntheticKey: ApiKeyRow = {
    id: `wsk_${session.id}`,
    accountId: session.accountId,
    name: 'web-session',
    keyPrefix: 'web_session',
    keyHash: '', // never read for web sessions; defensive empty string
    scopes: ['read', 'write', 'account_owner'],
    lastUsedAt: session.lastUsedAt,
    revokedAt: session.revokedAt,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
  };

  const ctx: AccountContext = { account, apiKey: syntheticKey, rateLimitOverrides, teams };

  // Cap TTL at session expiry so the cache entry can never outlive the
  // session token. Same shape as the API key path.
  if (cache) {
    let ttl = CACHE_TTL_SEC;
    const remaining = Math.floor((session.expiresAt.getTime() - now.getTime()) / 1000);
    if (remaining < ttl) ttl = Math.max(1, remaining);
    try {
      await cache.set(sha, syntheticKey.id, account.id, ctx, ttl);
    } catch {
      // Same graceful-degradation as the API key path.
    }
  }

  return ctx;
}

// ───────────────────────────────────────────────────────────────────────────
// Scope check
// ───────────────────────────────────────────────────────────────────────────

/**
 * V-174 — scope check with `'admin'` compat alias. During the
 * migration window, an `'admin'`-scoped key satisfies both
 * `'account_owner'` and `'driftstack_internal_admin'` checks. After
 * migration (when no `'admin'`-scoped keys remain), the alias path is
 * removed and `requireScope` enforces exact match only.
 */
export function requireScope(ctx: AccountContext, required: ApiKeyScope): void {
  if (ctx.apiKey.scopes.includes(required)) return;
  // Compat: 'admin' covers 'account_owner' and 'driftstack_internal_admin'.
  if (
    (required === 'account_owner' || required === 'driftstack_internal_admin') &&
    ctx.apiKey.scopes.includes('admin')
  ) {
    return;
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
