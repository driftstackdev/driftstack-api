// User-facing auth flows: signup, email verification, password login,
// magic-link request/consume, password-reset request/confirm, web-session
// refresh + logout.
//
// V-079 scaffolding shape:
//   - Service is repo-driven (`AuthFlowsRepo`) so tests can swap an
//     in-memory implementation for the Drizzle one. Same boundary
//     pattern as `auth.ts` / `sessions.ts` / `webhooks.ts`.
//   - Email sends fan out to the existing `EmailService` (Postmark,
//     V-057). Sends are fire-and-forget; failure is logged at warn,
//     never thrown — auth flow stays up even if email is misconfigured.
//   - Tokens generate as 32-byte URL-safe base64 plaintext, sha256-hashed
//     at rest. Re-presentation hashes-and-equality-compares.
//   - Error surface is `AuthFlowError` codes the route layer maps to
//     RFC 7807 problem responses.

import type { Logger } from '../lib/logger.js';
import { canonicalOneTimeTokenUrl } from '../lib/canonical-one-time-token-url.js';
import { isUniqueViolation } from '../lib/pg-error.js';
import { maskEmail } from '../lib/redact-url.js';
import type { EmailService } from './email.js';
import type { AuthCache } from './auth-cache.js';
import {
  AccountFailureLimiter,
  BoundedMemoryFailureLimiterStore,
  FailoverFailureLimiterStore,
  MFA_SIGN_IN_LIMIT,
  PASSWORD_SIGN_IN_LIMIT,
  type ReservedAttempt,
} from './account-failure-limiter.js';
import type { OAuthClientProvider } from '../lib/oauth-client-providers.js';
import { RateLimitedError } from '../lib/errors.js';
import type { AccountAuditService } from './account-audit.js';
import type { RevocationWebhookEmitter } from './api-keys.js';
import { logLostWebhookEvent } from './webhooks.js';
import type { EmailPreferencesService } from './email-preferences.js';
import type { MfaService } from './mfa.js';
import {
  type MfaChallengeMethod,
  type MfaChallengePayload,
  type MfaChallengeStore,
  isMfaChallengeMethod,
  generateChallengeToken,
  redisKey as mfaChallengeKey,
  attemptsKey as mfaChallengeAttemptsKey,
  MFA_CHALLENGE_TTL_SECONDS,
  MAX_MFA_CHALLENGE_ATTEMPTS,
} from './mfa-challenge-store.js';
import {
  AUTH_TOKEN_TTL_MS,
  generateAuthToken,
  hashPassword,
  tokenHash,
  verifyPassword,
} from '../lib/auth-tokens.js';
import type { AccountStatus, AccountTier } from '@driftstack/api-types';

// ───────────────────────────────────────────────────────────────────────────
// Repo boundary
// ───────────────────────────────────────────────────────────────────────────

export interface AuthFlowAccountRow {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
  tier: AccountTier;
  status: AccountStatus;
  /** V-590 — incremented whenever password authority changes. */
  authEpoch: number;
  createdAt: Date;
}

export interface AuthFlowTokenRow {
  id: string;
  accountId: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface WebSessionRow {
  id: string;
  accountId: string;
  tokenHash: string;
  /** Account auth epoch captured when this bearer was minted. */
  authEpoch: number;
  expiresAt: Date;
  lastUsedAt: Date;
  revokedAt: Date | null;
  issuedFromIp: string | null;
  userAgent: string | null;
  /** V-353d — most recent successful MFA challenge on this session,
   *  or null if never satisfied. Step-up gates check
   *  `now - mfaSatisfiedAt < 15min`. Sessions issued via the legacy
   *  pre-MFA-enrollment login path also start null and are lazily
   *  satisfied on first post-enrollment request. */
  mfaSatisfiedAt: Date | null;
  createdAt: Date;
}

export type AuthFlowKind = 'email_verify' | 'magic_link' | 'password_reset';

export interface AuthFlowsRepo {
  /** Look up account by canonical (lowercased) email; null if absent. */
  findAccountByEmail(email: string): Promise<AuthFlowAccountRow | null>;
  /**
   * 2026-07-01 security fix — look up account by its DEDUP-canonical
   * email (see `canonicalizeEmailForDedup` below), backed by the
   * `accounts.canonical_email` unique index. This is what actually
   * closes the Gmail dot/+tag alias-abuse gap: `createAccount` stores
   * every account's canonical form at insert time (regardless of which
   * literal variant the customer typed), so this single lookup finds a
   * collision REGARDLESS of which literal variant was registered
   * first — the earlier per-request re-canonicalize-and-look-up-by-
   * literal-email approach only caught the "canonical form registered
   * first" ordering. Null if no account's canonical form matches.
   */
  findAccountByCanonicalEmail(canonicalEmail: string): Promise<AuthFlowAccountRow | null>;
  /** Look up account by id; null if absent. */
  findAccountById(id: string): Promise<AuthFlowAccountRow | null>;
  /** Create a new account + return its row. Caller has already validated uniqueness. */
  createAccount(args: {
    email: string;
    name: string | null;
    passwordHash: string;
    initialTier: AccountTier;
    // Arc 1 sub-slice 6.2 (v2-#6) — bundled-LLM opt-in captured at
    // signup; both flow through to migration 0050's column defaults
    // when omitted (consent=false, cap=$20).
    bundledLlmConsent?: boolean;
    bundledLlmMonthlyCapUsdCents?: number;
  }): Promise<AuthFlowAccountRow>;
  /**
   * Update password_hash and atomically increment auth_epoch. Returns the
   * updated active account, or null if the account vanished/became inactive.
   */
  setPassword(accountId: string, passwordHash: string): Promise<AuthFlowAccountRow | null>;
  /** Mark email as verified — idempotent (no-op if already verified). */
  /** C9 — returns true iff THIS call performed the null→verified transition
   *  (so the caller can fire the one-time signup-welcome exactly once). */
  markEmailVerified(accountId: string, at: Date): Promise<boolean>;
  /**
   * Sign-in audit #1 — the mailbox owner's FIRST proof of the address by a magic
   * link, in ONE update: mark the email verified, drop any password set before
   * that proof (the '' "no password" marker) and advance auth_epoch, so a
   * password chosen by whoever registered the address never survives and every
   * session minted under it ends. Returns the updated row iff THIS call performed
   * the unverified→verified transition; null when the address was already
   * verified (nothing changed) or the account is gone.
   */
  verifyEmailDroppingUnprovenPassword(
    accountId: string,
    at: Date,
  ): Promise<AuthFlowAccountRow | null>;
  /**
   * Sign-in audit #5 — delete one linked Google/GitHub sign-in of the account,
   * refusing, atomically with the delete, when it is the account's last way to
   * sign in: no password and no other link that still signs in. A link the
   * provider already revoked (`last_revoked_at` set) never signs in, so it never
   * counts as a way in and can always be removed.
   */
  removeOAuthLink(args: { accountId: string; linkId: string }): Promise<RemoveOAuthLinkResult>;

  /** Insert a single-use token of the given kind. */
  insertAuthToken(args: {
    kind: AuthFlowKind;
    accountId: string;
    tokenHash: string;
    expiresAt: Date;
    requestedFromIp: string | null;
  }): Promise<AuthFlowTokenRow>;
  /** Look up an unconsumed, non-expired token by its hash. */
  findActiveAuthToken(args: {
    kind: AuthFlowKind;
    tokenHash: string;
    now: Date;
  }): Promise<AuthFlowTokenRow | null>;
  /**
   * Atomically mark a token consumed (UPDATE … WHERE id AND consumed_at IS
   * NULL). Returns true iff THIS call claimed it (one row updated); false if it
   * was already consumed — letting the caller reject a concurrent race-loser
   * instead of running the consume's side effects twice (single-use under
   * concurrency; the find-then-consume gap would otherwise let two simultaneous
   * requests both pass the find and both proceed).
   */
  consumeAuthToken(args: { kind: AuthFlowKind; id: string; at: Date }): Promise<boolean>;
  /**
   * Atomically consume the presented token and every still-unconsumed sibling
   * of the same kind/account. Returns true only when the presented id was part
   * of this call's UPDATE, so two different verification, magic, or reset
   * links racing for one account cannot both perform authentication or
   * credential-changing side effects.
   */
  consumeAuthTokenFamily(args: {
    kind: AuthFlowKind;
    id: string;
    accountId: string;
    at: Date;
  }): Promise<boolean>;
  /**
   * 2026-05-20 — sweeper-driven bulk delete of stale token rows.
   * `consumedBefore` deletes rows whose `consumedAt` is non-null
   * and older than the cutoff (keeps a forensic window for support
   * tickets). `expiredBefore` deletes rows whose `expiresAt` is
   * before the cutoff AND `consumedAt` is null. Returns the
   * number of rows deleted across both predicates. Idempotent;
   * safe to call from a scheduled job.
   */
  deleteStaleAuthTokens(args: {
    kind: AuthFlowKind;
    consumedBefore: Date;
    expiredBefore: Date;
  }): Promise<number>;

  /**
   * Insert a new web-session row. `createdAt` is the time of the SIGN-IN the
   * session descends from: omitted for a sign-in (now), passed by a refresh so
   * the rotated row keeps it. A refresh rotates the bearer; it is not a sign-in,
   * and "signed in within the last ten minutes" (sign-in audit #4) must not be
   * renewable by refreshing a stolen session.
   */
  insertWebSession(args: {
    accountId: string;
    tokenHash: string;
    authEpoch: number;
    expiresAt: Date;
    issuedFromIp: string | null;
    userAgent: string | null;
    createdAt?: Date;
  }): Promise<WebSessionRow | null>;
  findActiveWebSession(args: { tokenHash: string; now: Date }): Promise<WebSessionRow | null>;
  touchWebSession(id: string, at: Date): Promise<void>;
  /** Atomically revoke an active session. True iff this call changed the row;
   *  false means another process already revoked it (refresh claim loser). */
  revokeWebSession(id: string, at: Date): Promise<boolean>;
  /**
   * V-355 — list non-revoked, non-expired web sessions for the given
   * account. Sorted by lastUsedAt desc so the active one(s) sort
   * first. Caller is responsible for matching `currentTokenHash` to
   * the calling request to mark which row is "this device".
   */
  listActiveWebSessionsForAccount(accountId: string, now: Date): Promise<WebSessionRow[]>;
  /**
   * V-355 — find a web-session by id scoped to an account; null if
   * absent or owned by another account. Used for the revoke handler
   * so callers can't burn another account's session by id.
   */
  findWebSessionByIdForAccount(id: string, accountId: string): Promise<WebSessionRow | null>;
  /**
   * V-355 — bulk-revoke every active web session for the account
   * EXCEPT the one matching `exceptId`. Used by "Sign out everywhere
   * else." Returns count of rows updated.
   */
  revokeAllWebSessionsExcept(accountId: string, exceptId: string, at: Date): Promise<number>;
  /**
   * GDPR Article 17 — bulk-revoke EVERY active web session for the
   * account, no exclusion. Sibling of revokeAllWebSessionsExcept
   * (customer "sign out everywhere else" — which keeps the calling
   * device alive); this one backs the admin account-deletion flow,
   * where there is no "current session" to keep. Returns count of
   * rows updated.
   */
  revokeAllWebSessionsForAccount(accountId: string, at: Date): Promise<number>;
  /**
   * A password reset's revocation, in ONE transaction: every active web session
   * of the account (all of them, or all but `keepSessionId` — the session the
   * reset just issued), AND every live desktop device credential of the account
   * — an unrevoked, unexpired `api_keys` row with `provenance = 'cli_device'`.
   * The keys the customer minted themselves (provenance NULL) are integrations
   * and are left alone. Returns what it revoked, the keys ordered by id.
   */
  revokeCredentialsAfterPasswordReset(
    accountId: string,
    keepSessionId: string | null,
    at: Date,
  ): Promise<PasswordResetRevocation>;
  /**
   * V-353d — set web_sessions.mfa_satisfied_at on a session id. Used
   * by completeMfaChallenge so step-up gates pass.
   */
  markWebSessionMfaSatisfied(id: string, at: Date): Promise<void>;
}

/** What {@link AuthFlowsRepo.removeOAuthLink} did. */
export type RemoveOAuthLinkResult =
  | { kind: 'removed'; provider: string; providerEmail: string | null }
  | { kind: 'not_found' }
  | { kind: 'last_sign_in_method' };

/** What {@link AuthFlowsRepo.revokeCredentialsAfterPasswordReset} revoked. */
export interface PasswordResetRevocation {
  webSessions: number;
  deviceKeys: Array<{ id: string; name: string }>;
}

// ───────────────────────────────────────────────────────────────────────────
// Errors
// ───────────────────────────────────────────────────────────────────────────

export type AuthFlowErrorCode =
  | 'email_already_registered'
  | 'invalid_credentials'
  | 'email_not_verified'
  | 'invalid_auth_token'
  | 'account_suspended'
  // Sign-in audit #1 — the verification link needs the account's password.
  | 'password_required';

export class AuthFlowError extends Error {
  readonly code: AuthFlowErrorCode;
  constructor(code: AuthFlowErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'AuthFlowError';
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Email dedup canonicalization
// ───────────────────────────────────────────────────────────────────────────

/**
 * Signup-time email dedup canonicalization (security hardening,
 * 2026-06-30; storage-backed 2026-07-01; provider scope corrected
 * 2026-07-13). Gmail-specific normalizations are applied to the local
 * part only:
 *
 *   1. For gmail.com / googlemail.com, strip a `+tag` suffix.
 *   2. For those same two domains, also strip dots.
 *
 * RFC 5233 describes provider-controlled subaddressing; it does NOT make
 * `+tag` a universal mailbox alias. Other domains may deliver
 * `foo+tag@example.com` to a mailbox distinct from `foo@example.com`, so
 * their local part must remain literal. Treating them as aliases lets an
 * anonymous recovery request resolve one account through canonical_email
 * while naming a different mailbox.
 *
 * The result is stored verbatim in `accounts.canonical_email` (unique-
 * indexed) at account-creation time — see `AuthFlowsRepo.createAccount`
 * — and is what `findAccountByCanonicalEmail` looks up against for the
 * signup dedup pre-check below. It never changes what's stored,
 * displayed, or emailed as the account's real address; the account
 * row's `email` column always keeps the customer's literal entered
 * address. Exported so both repo implementations (Drizzle + the
 * in-memory test fixture) compute it identically — never re-derive
 * this logic elsewhere.
 */
export function canonicalizeEmailForDedup(email: string): string {
  const at = email.lastIndexOf('@');
  if (at === -1) return email;
  const localPart = email.slice(0, at);
  const domain = email.slice(at + 1);
  const isGmail = domain === 'gmail.com' || domain === 'googlemail.com';
  const canonicalLocal = isGmail ? (localPart.split('+')[0] ?? '').replace(/\./g, '') : localPart;
  return `${canonicalLocal}@${domain}`;
}

/**
 * The one way to resolve a typed or provider-asserted email to an account: by
 * its literal (lowercased) address AND by its dedup-canonical form, both lookups
 * always run (see the timing note on the service's private wrapper).
 *
 * The email is trimmed and lowercased FIRST. `canonicalizeEmailForDedup` keys
 * Gmail handling on the literal domain `gmail.com`, so canonicalising a
 * mixed-case address (`First.Last@Gmail.com`, as a provider may assert it)
 * skipped the Gmail rules and missed the stored `firstlast@gmail.com` — sign-in
 * audit #6, V-1724 again for mixed case, a 500 on the OAuth /redeem when the
 * miss fell through to creating a second account.
 */
export async function findAccountByEmailOrCanonical(
  repo: Pick<AuthFlowsRepo, 'findAccountByEmail' | 'findAccountByCanonicalEmail'>,
  email: string,
): Promise<AuthFlowAccountRow | null> {
  const normalized = email.trim().toLowerCase();
  const [byLiteral, byCanonical] = await Promise.all([
    repo.findAccountByEmail(normalized),
    repo.findAccountByCanonicalEmail(canonicalizeEmailForDedup(normalized)),
  ]);
  return byLiteral ?? byCanonical;
}

/**
 * Sign-in audit #6 — the Google/GitHub sign-in's account lookup. Production
 * (bootstrap) and the test app's OAuth wiring both call this, so the in-memory
 * suites exercise the lookup production runs instead of a literal-only copy of
 * their own.
 */
export async function findAccountIdForSignInEmail(
  repo: Pick<AuthFlowsRepo, 'findAccountByEmail' | 'findAccountByCanonicalEmail'>,
  email: string,
): Promise<string | null> {
  return (await findAccountByEmailOrCanonical(repo, email))?.id ?? null;
}

/** '' is the "no password" marker (OAuth-created accounts, a password a magic
 *  link dropped); null predates the column. Neither is a password. */
function holdsPassword(passwordHash: string | null): passwordHash is string {
  return passwordHash !== null && passwordHash !== '';
}

// ───────────────────────────────────────────────────────────────────────────
// Service
// ───────────────────────────────────────────────────────────────────────────

export interface AuthFlowsServiceConfig {
  /** Base URL the verify-email link points at. */
  verifyEmailUrl: string;
  /** Base URL the magic-link points at. */
  magicLinkUrl: string;
  /** Base URL the password-reset link points at. */
  passwordResetUrl: string;
  /**
   * When true, the signup / magic-link / password-reset response includes
   * a `debug_token` field with the plaintext token. Wired in dev / test
   * builds where there is no real Postmark deliverability path, so tests
   * can exercise the consume endpoints without scraping email.
   */
  exposeDebugToken: boolean;
  /** Tier assigned to newly-created accounts. Default 'free'. */
  initialTier?: AccountTier;
}

export interface SignupArgs {
  email: string;
  password: string;
  name?: string;
  requestedFromIp: string | null;
}

export interface SignupResult {
  account: AuthFlowAccountRow;
  verifyExpiresAt: Date;
  debugToken: string | null;
}

export interface VerifyEmailArgs {
  token: string;
  /** Sign-in audit #1 — required when the account has a password. */
  password?: string;
  issuedFromIp: string | null;
  userAgent: string | null;
}

/** V-720 — shaped as a union mirroring {@link LoginResult}. Verifying an email
 *  proves mailbox control, NOT possession of an enrolled second factor, so this
 *  flow branches through MFA like every other session-minting flow. The union
 *  (rather than an interface with optional fields) is deliberate: it makes the
 *  compiler reject a caller that ignores the challenge branch, which is exactly
 *  how the gap this replaces survived — the old interface let routes/auth.ts
 *  pass the result straight to sessionResponse(). */
export type VerifyEmailResult =
  | {
      kind: 'session';
      account: AuthFlowAccountRow;
      session: { plaintext: string; row: WebSessionRow };
    }
  | {
      kind: 'mfa_required';
      account: AuthFlowAccountRow;
      challengeToken: string;
      challengeExpiresAt: Date;
    };

export interface LoginArgs {
  email: string;
  password: string;
  issuedFromIp: string | null;
  userAgent: string | null;
}

export type LoginResult =
  | {
      kind: 'session';
      account: AuthFlowAccountRow;
      session: { plaintext: string; row: WebSessionRow };
    }
  | {
      kind: 'mfa_required';
      account: AuthFlowAccountRow;
      challengeToken: string;
      challengeExpiresAt: Date;
    };

export type OAuthWebSessionResult =
  | {
      kind: 'session';
      session: { plaintext: string; row: WebSessionRow };
    }
  | {
      kind: 'mfa_required';
      challengeToken: string;
      challengeExpiresAt: Date;
    };

/** V-353d — body of /v1/auth/mfa/challenge. Either `code` (TOTP
 *  6-digit) or `recovery_code` (10-char recovery; hyphen optional). */
export interface MfaChallengeArgs {
  challengeToken: string;
  code?: string;
  recoveryCode?: string;
  /** Source IP of the challenge attempt — must match the issuing IP
   *  to refuse cross-channel theft. Best-effort defense. */
  sourceIp: string | null;
  userAgent: string | null;
}

export interface MfaChallengeResult {
  account: AuthFlowAccountRow;
  session: { plaintext: string; row: WebSessionRow };
  /** Whether the customer used a recovery code. The route emits a
   *  different audit action on recovery vs TOTP, and the dashboard
   *  may want to surface a "you used 1/10 recovery codes" reminder. */
  via: 'totp' | 'recovery';
}

export interface ResendVerificationArgs {
  email: string;
  requestedFromIp: string | null;
}

export interface ResendVerificationResult {
  /** True if a fresh verify-email token was minted + an email sent; false
   *  silently no-ops the response shape (no account, already verified,
   *  email lookup failed). */
  sent: boolean;
  expiresAt: Date;
  debugToken: string | null;
}

export interface MagicLinkRequestArgs {
  email: string;
  requestedFromIp: string | null;
}

export interface MagicLinkRequestResult {
  /** True if the email matched an account; false silently no-ops the response shape. */
  sent: boolean;
  expiresAt: Date;
  debugToken: string | null;
}

export interface MagicLinkConsumeArgs {
  token: string;
  issuedFromIp: string | null;
  userAgent: string | null;
}

/**
 * A magic-link sign-in. `passwordRemoved` is true when this link was the
 * address's first confirmation and removed the password the account held, so
 * the person can be told (sign-in re-audit, round 1, defect 2).
 */
export type MagicLinkConsumeResult = LoginResult & { passwordRemoved: boolean };

export interface PasswordResetRequestArgs {
  email: string;
  requestedFromIp: string | null;
}

export interface PasswordResetRequestResult {
  sent: boolean;
  expiresAt: Date;
  debugToken: string | null;
}

export interface PasswordResetConfirmArgs {
  token: string;
  newPassword: string;
  issuedFromIp: string | null;
  userAgent: string | null;
}

export type PasswordResetConfirmResult = LoginResult;

export interface RefreshSessionArgs {
  token: string;
  issuedFromIp: string | null;
  userAgent: string | null;
}

export interface RefreshSessionResult {
  account: AuthFlowAccountRow;
  session: { plaintext: string; row: WebSessionRow };
}

// Login user-enumeration timing mitigation (CWE-208). When an email has no
// account (or is OAuth-only with a null password hash), login still runs a
// throwaway scrypt verify against this fixed dummy hash so the no-account path
// takes ~the same time as a real wrong-password attempt (scrypt logN=15 is
// tens of ms; skipping it would let an attacker enumerate registered emails by
// response latency). Computed lazily once, then reused — the plaintext is a
// fixed non-secret; only the resulting scrypt cost matters.
let dummyPasswordHashPromise: Promise<string> | null = null;
function dummyPasswordHash(): Promise<string> {
  dummyPasswordHashPromise ??= hashPassword('driftstack-login-timing-equalizer');
  return dummyPasswordHashPromise;
}

// Security fix (2026-06-30 audit) — V-353e.A per-account attempt-lockout
// key for stepUpReauth. Distinct from `mfaChallengeAttemptsKey` (imported
// above as `mfaChallengeAttemptsKey`), which keys the login-path
// challenge-token counter; this flow has no per-attempt token to key on
// (the caller already holds a persistent, valid web session), so it keys
// on the account instead. See stepUpReauth()'s doc comment for the full
// rationale.
function stepUpAttemptsKey(accountId: string): string {
  return `mfa-stepup-attempts:${accountId}`;
}

/**
 * Sign-in re-audit, round 1, defect 1 — the MFA sign-in limit's subject: the
 * account AND the sign-in method that started the challenge. Keyed on the account
 * alone, ten wrong codes entered after a GitHub sign-in paused every way in, so
 * whoever held a linked identity could keep the owner out indefinitely.
 */
function mfaSignInSubject(accountId: string, method: MfaChallengeMethod): string {
  return `${accountId}:${method}`;
}

/** How a pause refusal names the method it applies to. */
function mfaMethodName(method: MfaChallengeMethod): string {
  switch (method) {
    case 'google':
      return 'Google';
    case 'github':
      return 'GitHub';
    case 'email_link':
      return 'an email link';
    case 'password':
      return 'your password';
  }
}

/**
 * Sign-in audit #2 — the refusal while an account's MFA sign-in by `method` is
 * paused: 429, Retry-After, and what to do. After a password reset the reset
 * itself went through, and the detail says so. The password-method details are
 * worded exactly as before the pause became per method: the dashboard shows
 * those two, word for word, from an allow-list (DashboardLayout.astro).
 */
function mfaSignInPausedError(
  retryAfterSeconds: number,
  method: MfaChallengeMethod,
  opts: { afterPasswordChange?: boolean } = {},
): RateLimitedError {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  const wait = `${minutes.toString()} minute${minutes === 1 ? '' : 's'}`;
  if (opts.afterPasswordChange === true) {
    return new RateLimitedError(
      retryAfterSeconds,
      `Your password was changed. Two-factor sign-in for this account is paused after too many incorrect codes — sign in with your new password in ${wait}.`,
    );
  }
  if (method === 'password') {
    return new RateLimitedError(
      retryAfterSeconds,
      `Too many incorrect two-factor codes for this account. Two-factor sign-in is paused — try again in ${wait}.`,
    );
  }
  const name = mfaMethodName(method);
  return new RateLimitedError(
    retryAfterSeconds,
    `Too many incorrect two-factor codes after signing in with ${name}. Two-factor sign-in with ${name} is paused — try again in ${wait}, or sign in another way.`,
  );
}

function parseMfaChallengePayload(raw: string): MfaChallengePayload | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const { account_id, email, source_ip, issued_at, issued_user_agent, method } = record;
  if (typeof account_id !== 'string' || account_id.length === 0) return null;
  if (typeof email !== 'string' || email.length === 0) return null;
  if (source_ip !== null && typeof source_ip !== 'string') return null;
  if (typeof issued_at !== 'number' || !Number.isFinite(issued_at)) return null;
  if (issued_user_agent !== null && typeof issued_user_agent !== 'string') return null;
  // The method decides which count a wrong code lands in; without it there is no
  // right count to charge, so the challenge fails closed like any corrupt one (a
  // challenge issued before the method was recorded: sign in again).
  if (!isMfaChallengeMethod(method)) return null;

  return { account_id, email, source_ip, issued_at, issued_user_agent, method };
}

export class AuthFlowsService {
  /**
   * Sign-in audit #3 — password sign-in limit, keyed on the canonical email.
   * Sign-in audit #2 — MFA sign-in code limit, keyed on the account and the
   * sign-in method that started the challenge (re-audit defect 1).
   * Both live in the short-lived store the MFA hand-off uses (Redis in
   * production, always wired by bootstrap); null only where a caller builds the
   * service without that store. While that store is unreachable the password
   * limit counts in a bounded store inside this process instead of letting every
   * guess through (re-audit defect 4).
   */
  private readonly passwordSignInLimiter: AccountFailureLimiter | null;
  private readonly mfaSignInLimiter: AccountFailureLimiter | null;

  constructor(
    private readonly repo: AuthFlowsRepo,
    private readonly email: EmailService,
    private readonly logger: Logger,
    private readonly config: AuthFlowsServiceConfig,
    /**
     * V-168 — optional auth cache for logout invalidation. When wired,
     * logout bumps the account-version so any cached web-session
     * AccountContext misses on the next read (D-020 / D-025 invariant).
     * Tests that don't exercise the cache pass null (no-op).
     */
    private readonly authCache: AuthCache | null = null,
    /**
     * V-224 — optional customer-facing audit log. When wired, emits
     * account.email_verified / account.login / account.logout /
     * account.password_changed entries at the matching flow points.
     * Best-effort; emit failures never break the auth flow itself.
     * Tests that don't exercise the audit log pass null.
     */
    private readonly accountAudit: AccountAuditService | null = null,
    /**
     * V-353d — optional MFA service. When wired, login() consults
     * mfa.getStatus(account) and returns a challenge_token instead of
     * a session if the account is enrolled. Tests that don't exercise
     * MFA pass null (login behaves as pre-V-353d).
     */
    private readonly mfa: MfaService | null = null,
    /**
     * V-353d — optional challenge-token store. Required when `mfa` is
     * non-null; stores `MfaChallengePayload` JSON for 5min, single-
     * use consumption on /v1/auth/mfa/challenge.
     */
    private readonly mfaChallenges: MfaChallengeStore | null = null,
    /**
     * C9 (V-204) — optional email-preferences service. When wired, the
     * signup-welcome send honors the customer's 'signup-welcome' opt-out.
     * Tests that don't exercise preferences pass null (always sends).
     */
    private readonly emailPreferences: EmailPreferencesService | null = null,
    /**
     * Sends `api_key.revoked` for each desktop credential a password reset
     * revokes — the event fires whenever a key is revoked, whoever initiated it
     * (webhooks/events.md). Same payload as the ordinary revoke path. Tests that
     * don't exercise webhooks pass null.
     */
    private readonly webhooksService: RevocationWebhookEmitter | null = null,
  ) {
    this.passwordSignInLimiter =
      mfaChallenges === null
        ? null
        : new AccountFailureLimiter(
            new FailoverFailureLimiterStore(
              mfaChallenges,
              new BoundedMemoryFailureLimiterStore(),
              // Once per outage, not once per request.
              (err) => {
                this.logger.warn(
                  { component: 'auth-flows', flow: 'login', err },
                  'password sign-in limit store unreachable — counting in this process until it answers again',
                );
              },
              () => {
                this.logger.info(
                  { component: 'auth-flows', flow: 'login' },
                  'password sign-in limit store answers again — counting there',
                );
              },
            ),
            PASSWORD_SIGN_IN_LIMIT,
          );
    this.mfaSignInLimiter =
      mfaChallenges === null ? null : new AccountFailureLimiter(mfaChallenges, MFA_SIGN_IN_LIMIT);
  }

  /** Where a customer starts a password reset: the dashboard's forgot-password page. */
  private forgotPasswordUrl(): string {
    return `${new URL(this.config.passwordResetUrl).origin}/forgot-password`;
  }

  /** The dashboard's Security page, where a linked sign-in is removed. */
  private securityUrl(): string {
    return `${new URL(this.config.passwordResetUrl).origin}/security`;
  }

  /**
   * Sign-in audit #2 — refuse while the account's MFA sign-in by `method` is
   * paused. The detail says what happened and when to come back;
   * `afterPasswordChange` is the password-reset case, where the reset itself
   * already went through.
   */
  private async refuseWhileMfaSignInPaused(
    accountId: string,
    method: MfaChallengeMethod,
    opts: { afterPasswordChange?: boolean } = {},
  ): Promise<void> {
    if (this.mfaSignInLimiter === null) return;
    const seconds = await this.mfaSignInLimiter.lockedFor(mfaSignInSubject(accountId, method));
    if (seconds === null) return;
    throw mfaSignInPausedError(seconds, method, opts);
  }

  /**
   * Sign-in audit #2 — the account just reached ten wrong codes by `method`. One
   * "Recent activity" row, written by the platform, and one email to the owner
   * naming the method. Both best-effort: the pause itself is what protects the
   * account.
   */
  private async announceMfaSignInPause(
    accountId: string,
    method: MfaChallengeMethod,
    pausedUntil: Date,
  ): Promise<void> {
    if (this.accountAudit !== null) {
      try {
        await this.accountAudit.record({
          accountId,
          actorType: 'system',
          actorAccountId: null,
          actorKeyId: null,
          action: 'account.mfa_sign_in_locked',
          targetResourceId: null,
          payload: {
            failed_codes: MFA_SIGN_IN_LIMIT.maxFailures,
            paused_until: pausedUntil.toISOString(),
            method,
          },
        });
      } catch (err) {
        this.logger.warn(
          { component: 'auth-flows', action: 'account.mfa_sign_in_locked', accountId, err },
          'account-audit emit failed (best-effort, swallowed)',
        );
      }
    }
    try {
      const account = await this.repo.findAccountById(accountId);
      if (account !== null) {
        void this.email.sendMfaSignInLocked({
          to: account.email,
          pausedUntil,
          method,
          resetUrl: this.forgotPasswordUrl(),
          securityUrl: this.securityUrl(),
        });
      }
    } catch (err) {
      this.logger.warn(
        { component: 'auth-flows', flow: 'mfa-sign-in-pause', accountId, err },
        'MFA sign-in pause notice not sent (best-effort, swallowed)',
      );
    }
  }

  /**
   * Sign-in audit #3 — reserve a password attempt for this email, or refuse
   * with 429 while the email is locked. Keyed on the CANONICAL email and taken
   * before the account lookup, so it runs identically whether or not an account
   * exists. If Redis is unreachable the limit counts in a bounded store inside
   * this process (re-audit defect 4: it used to let every guess through), so a
   * blip neither takes password sign-in down nor lifts the limit. Only if that
   * store fails too is the request refused — never admitted unlimited.
   */
  private async admitPasswordSignIn(email: string): Promise<ReservedAttempt | null> {
    if (this.passwordSignInLimiter === null) return null;
    let admission: Awaited<ReturnType<AccountFailureLimiter['admit']>>;
    try {
      admission = await this.passwordSignInLimiter.admit(canonicalizeEmailForDedup(email));
    } catch (err) {
      this.logger.warn(
        { component: 'auth-flows', flow: 'login', err },
        'password sign-in limit unavailable in Redis and in this process — refusing',
      );
      throw new RateLimitedError(60, 'Sign-in is temporarily unavailable. Try again in a minute.');
    }
    if (admission.kind === 'locked') {
      const minutes = Math.max(1, Math.ceil(admission.retryAfterSeconds / 60));
      throw new RateLimitedError(
        admission.retryAfterSeconds,
        `Too many incorrect passwords for this email. Try again in ${minutes.toString()} minute${minutes === 1 ? '' : 's'}, or reset your password.`,
      );
    }
    return admission.attempt;
  }

  /** Settle a password attempt without letting a store error fail the sign-in. */
  private async settlePasswordAttempt(settle: () => Promise<unknown>): Promise<void> {
    try {
      await settle();
    } catch (err) {
      this.logger.warn(
        { component: 'auth-flows', flow: 'login', err },
        'password sign-in limit not updated (best-effort, swallowed)',
      );
    }
  }

  /**
   * `method` is the sign-in that started the challenge; the challenge carries it,
   * so its wrong codes count — and pause — that method only (re-audit defect 1).
   */
  private async createMfaChallenge(
    account: AuthFlowAccountRow,
    sourceIp: string | null,
    userAgent: string | null,
    method: MfaChallengeMethod,
    opts: { afterPasswordChange?: boolean } = {},
  ): Promise<{ challengeToken: string; challengeExpiresAt: Date }> {
    if (this.mfaChallenges === null) {
      throw new AuthFlowError('invalid_auth_token', 'MFA challenge not available on this server.');
    }
    // Sign-in audit #2 — no new challenge while the account's MFA sign-in by
    // this method is paused: a fresh sign-in must not buy a fresh set of guesses.
    await this.refuseWhileMfaSignInPaused(account.id, method, opts);
    const challengeToken = generateChallengeToken();
    const challengeExpiresAt = new Date(Date.now() + MFA_CHALLENGE_TTL_SECONDS * 1000);
    const payload: MfaChallengePayload = {
      account_id: account.id,
      email: account.email,
      source_ip: sourceIp,
      issued_at: Date.now(),
      issued_user_agent: userAgent,
      method,
    };
    await this.mfaChallenges.set(
      mfaChallengeKey(challengeToken),
      JSON.stringify(payload),
      MFA_CHALLENGE_TTL_SECONDS,
    );
    return { challengeToken, challengeExpiresAt };
  }

  /**
   * Process-local single-flight queue keyed on an arbitrary string
   * (refreshSession uses the presented token hash). This avoids duplicate
   * work on one host; revokeWebSession's conditional UPDATE remains the
   * authoritative cross-process/cross-host first-winner claim.
   */
  private readonly keyedLocks = new Map<string, Promise<void>>();

  private withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previousTail = this.keyedLocks.get(key) ?? Promise.resolve();
    const result = previousTail.then(fn);
    const tail: Promise<void> = result.then(
      () => undefined,
      () => undefined,
    );
    this.keyedLocks.set(key, tail);
    void tail.then(() => {
      // Only this call's own queue entry should be cleaned up — a
      // newer caller may have already chained another tail onto this
      // key while we were running.
      if (this.keyedLocks.get(key) === tail) this.keyedLocks.delete(key);
    });
    return result;
  }

  private async emitAuditBestEffort(
    accountId: string,
    action:
      | 'account.email_verified'
      | 'account.login'
      | 'account.logout'
      | 'account.password_changed'
      | 'account.oauth_link_removed'
      | 'api_key.revoked',
    payload: Record<string, unknown>,
    actorAccountId: string | null = null,
    opts: { targetResourceId?: string } = {},
  ): Promise<void> {
    if (this.accountAudit === null) return;
    try {
      await this.accountAudit.record({
        accountId,
        actorType: 'customer',
        actorAccountId: actorAccountId ?? accountId,
        actorKeyId: null,
        action,
        targetResourceId: opts.targetResourceId ?? null,
        payload,
      });
    } catch (err) {
      this.logger.warn(
        { component: 'auth-flows', action, accountId, err },
        'account-audit emit failed (best-effort, swallowed)',
      );
    }
  }

  /**
   * Audit fix (2026-07-01) — login/resend-verification/magic-link/password-
   * reset all used to look up ONLY by the literal (lowercased) email. Since
   * signup dedup already treats Gmail dot/+tag variants as the SAME account
   * (canonicalizeEmailForDedup + findAccountByCanonicalEmail, closing the
   * alias-abuse gap fixed earlier this session), a customer who signed up
   * with one variant (e.g. `foo.bar@gmail.com`, however their password
   * manager or memory happened to store it) but later types an
   * equivalent-but-different variant (`foobar@gmail.com` — the SAME Gmail
   * inbox) at any of these entry points would get a literal-lookup miss and
   * be told "invalid credentials" / silently get no reset email, even though
   * the system's own dedup logic already knows these are the same account
   * owner. This helper closes that gap consistently across all four flows.
   *
   * Deliberately runs BOTH lookups unconditionally (never conditionally
   * short-circuits on the literal hit) rather than "try literal, then only
   * if null try canonical": `login()` specifically follows this call with a
   * constant-time password verify (real or dummy hash) to close a CWE-208
   * timing side-channel, and a conditional second query would make total
   * query count (and therefore response time) vary with whether the exact
   * literal email matched — a new, subtler timing signal. Always doing
   * both queries keeps this helper's own cost constant-shape regardless of
   * which case applies, so it introduces no new timing distinction for
   * login() to worry about.
   */
  private async findAccountByEmailOrCanonical(email: string): Promise<AuthFlowAccountRow | null> {
    return findAccountByEmailOrCanonical(this.repo, email);
  }

  async signup(args: SignupArgs): Promise<SignupResult> {
    const email = args.email.trim().toLowerCase();
    const existing = await this.repo.findAccountByEmail(email);
    if (existing !== null) {
      throw new AuthFlowError('email_already_registered');
    }

    // 2026-06-30 security fix, made race-free + order-independent
    // 2026-07-01 — Gmail dot/+tag dedup pre-check. A signup using a
    // `+tag` suffix or (Gmail-only) dot-variant of an address that's
    // ALREADY registered lands in the exact same real inbox as the
    // existing account, so letting it through would let one mailbox
    // mint unlimited "distinct" free-tier accounts.
    //
    // This MUST look up by canonical form UNCONDITIONALLY (not only
    // when `canonicalEmail !== email`) and MUST hit the dedicated
    // `accounts.canonical_email` unique index (via
    // `findAccountByCanonicalEmail`), not the literal `email` column —
    // otherwise it only catches the "canonical form registered first"
    // ordering. The realistic abuse ordering is the opposite: a
    // variant registers FIRST (e.g. attacker+1@gmail.com, which is
    // ALSO its own canonical form, so the `canonicalEmail !== email`
    // gate used to skip the extra lookup entirely for it), then a
    // second variant or the bare address signs up — and a literal-
    // column lookup against the first variant's literal email would
    // never match. Every account's canonical form is stored at
    // creation time (`AuthFlowsRepo.createAccount`), so this single
    // lookup catches a collision regardless of registration order —
    // this is an ADDITIONAL, STRICTER pre-check ahead of the
    // `accounts_email_unique` DB constraint below; it doesn't relax or
    // replace that constraint.
    const canonicalEmail = canonicalizeEmailForDedup(email);
    const canonicalExisting = await this.repo.findAccountByCanonicalEmail(canonicalEmail);
    if (canonicalExisting !== null) {
      throw new AuthFlowError('email_already_registered');
    }

    const passwordHash = await hashPassword(args.password);
    let account: Awaited<ReturnType<typeof this.repo.createAccount>>;
    try {
      account = await this.repo.createAccount({
        email,
        name: args.name ?? null,
        passwordHash,
        initialTier: this.config.initialTier ?? 'free',
      });
    } catch (err) {
      // Concurrent same-email signup race (e.g. a double-clicked submit):
      // both calls pass the findAccountByEmail pre-check above before either
      // commits, then both insert; the accounts_email_unique index lets one
      // win and raises 23505 on the loser. Translate to the same
      // email_already_registered (409) the pre-check throws — not an
      // uncaught 500. Any other error re-throws untouched.
      if (isUniqueViolation(err, 'accounts_email_unique')) {
        throw new AuthFlowError('email_already_registered');
      }
      // 2026-07-01 — the canonical-email sibling of the race above: two
      // concurrent signups for DIFFERENT literal alias variants of the
      // same mailbox (e.g. attacker+1@gmail.com / attacker+2@gmail.com)
      // both pass the findAccountByCanonicalEmail pre-check above before
      // either commits, then both insert; accounts_canonical_email_unique
      // lets one win and raises 23505 on the loser. Same translation as
      // the literal-email race — not an uncaught 500.
      if (isUniqueViolation(err, 'accounts_canonical_email_unique')) {
        throw new AuthFlowError('email_already_registered');
      }
      throw err;
    }

    const plaintext = generateAuthToken();
    const expiresAt = new Date(Date.now() + AUTH_TOKEN_TTL_MS.signupVerification);
    await this.repo.insertAuthToken({
      kind: 'email_verify',
      accountId: account.id,
      tokenHash: tokenHash(plaintext),
      expiresAt,
      requestedFromIp: args.requestedFromIp,
    });

    const link = canonicalOneTimeTokenUrl(this.config.verifyEmailUrl, plaintext);
    void this.email.sendSignupVerification({ to: email, link, expiresAt });

    return {
      account,
      verifyExpiresAt: expiresAt,
      debugToken: this.config.exposeDebugToken ? plaintext : null,
    };
  }

  // #187 — self-service resend of the signup verification email.
  //
  // Shape-stable: response is identical whether the email matches an
  // unverified account, an already-verified account, or no account at
  // all — clients can't enumerate. The IP rate-limiter (3/min, same
  // cap as password-reset) caps abuse independent of account state.
  //
  // Previously-issued email_verify tokens are not expired at resend time, so
  // a user may click either delivered link. Verification atomically consumes
  // the whole account token family, making whichever link is clicked first
  // the sole winner and retiring every leaked/stale sibling before session
  // issuance.
  async resendSignupVerification(args: ResendVerificationArgs): Promise<ResendVerificationResult> {
    const email = args.email.trim().toLowerCase();
    const expiresAt = new Date(Date.now() + AUTH_TOKEN_TTL_MS.signupVerification);

    const account = await this.findAccountByEmailOrCanonical(email);
    if (account === null || account.emailVerifiedAt !== null) {
      // Don't leak account-existence or verification-state. Return the
      // shape that would have happened on success; no email is sent.
      return { sent: false, expiresAt, debugToken: null };
    }

    const plaintext = generateAuthToken();
    await this.repo.insertAuthToken({
      kind: 'email_verify',
      accountId: account.id,
      tokenHash: tokenHash(plaintext),
      expiresAt,
      requestedFromIp: args.requestedFromIp,
    });

    const link = canonicalOneTimeTokenUrl(this.config.verifyEmailUrl, plaintext);
    // Account-bound credentials always go to the address persisted on the
    // account, never an anonymous request's alternate spelling. Canonical
    // lookup is only an identity-resolution aid for known Gmail aliases.
    void this.email.sendSignupVerification({ to: account.email, link, expiresAt });

    return {
      sent: true,
      expiresAt,
      debugToken: this.config.exposeDebugToken ? plaintext : null,
    };
  }

  async verifyEmail(args: VerifyEmailArgs): Promise<VerifyEmailResult> {
    const now = new Date();
    const row = await this.repo.findActiveAuthToken({
      kind: 'email_verify',
      tokenHash: tokenHash(args.token),
      now,
    });
    if (row === null) throw new AuthFlowError('invalid_auth_token');

    // Sign-in audit #1 — the link proves the mailbox, not that the person
    // clicking it chose the account's password. Anyone can sign up with someone
    // else's address and a password of their own; if the mailbox owner's click
    // alone verified the account, that password would then sign in with full
    // owner rights. So when the account has a password, verification needs it:
    // the person who signed up knows it, a person who never signed up does not,
    // and the account stays unverified — useless to whoever holds its password.
    // Checked BEFORE the token is consumed, so a mistyped password does not use
    // up the link. (A forgotten one: a password reset proves the mailbox too and
    // verifies the address — see confirmPasswordReset.)
    const holder = await this.requireAccount(row.accountId);
    if (holdsPassword(holder.passwordHash)) {
      if (args.password === undefined || args.password.length === 0) {
        throw new AuthFlowError(
          'password_required',
          'Enter the password you chose when you signed up to confirm this email address.',
        );
      }
      if (!(await verifyPassword(args.password, holder.passwordHash))) {
        throw new AuthFlowError(
          'password_required',
          "That password doesn't match. Enter the password you chose when you signed up.",
        );
      }
    }

    // Account-family single-use under concurrency: the first live verification
    // link claims every sibling. A different old/resend link cannot later mint
    // another passwordless session, and concurrent siblings have one winner.
    const consumed = await this.repo.consumeAuthTokenFamily({
      kind: 'email_verify',
      id: row.id,
      accountId: row.accountId,
      at: now,
    });
    if (!consumed) throw new AuthFlowError('invalid_auth_token');
    const account = await this.requireAccount(row.accountId);
    if (account.status !== 'active') throw new AuthFlowError('account_suspended');
    const firstVerification = await this.repo.markEmailVerified(row.accountId, now);

    // V-720 — a verification link proves mailbox control, not possession of the
    // account's enrolled second factor. login/consumeMagicLink/
    // confirmPasswordReset/issueOAuthWebSession all branch here; this flow did
    // not, so a live signup link minted a FULL session on an MFA-enrolled
    // account — an MFA bypass for whoever holds the inbox, which is the precise
    // threat MFA backstops.
    //
    // Reachable inside the 30-minute signupVerification TTL: consumeMagicLink
    // marks the email verified itself (see its emailVerifiedAt branch) and
    // mints a session, so the owner can enrol MFA while the original signup
    // token is still live and unconsumed. resendSignupVerification refuses once
    // verified, but the ALREADY-issued token is untouched by that guard.
    //
    // The email is still marked verified above — verification is a property of
    // the mailbox and the link did prove it. Only the SESSION waits for the
    // second factor. createMfaChallenge fails closed if its store is down.
    const outcome: VerifyEmailResult =
      this.mfa !== null && (await this.mfa.getStatus(account.id)).enrolled
        ? {
            kind: 'mfa_required',
            account,
            // A link sent to the address started this sign-in.
            ...(await this.createMfaChallenge(
              account,
              args.issuedFromIp,
              args.userAgent,
              'email_link',
            )),
          }
        : {
            kind: 'session',
            account,
            session: await this.issueWebSession(account, args.issuedFromIp, args.userAgent),
          };

    await this.emitAuditBestEffort(account.id, 'account.email_verified', {
      issued_from_ip: args.issuedFromIp,
      user_agent: args.userAgent,
    });

    // V-202 — fire signup-welcome email after the verify lands. Derive
    // the dashboard origin from `verifyEmailUrl` (the verify link
    // already lives on the customer dashboard host). Fire-and-forget;
    // matches the email-service posture used elsewhere.
    //
    // C9 — send ONLY on the first null→verified transition and honor the
    // V-204 'signup-welcome' opt-out when the email-preferences service is
    // wired. Sibling tokens were retired by the family claim above.
    if (firstVerification) {
      void (async (): Promise<void> => {
        if (
          this.emailPreferences !== null &&
          !(await this.emailPreferences.shouldSend(account.id, 'signup-welcome'))
        ) {
          return;
        }
        const origin = new URL(this.config.verifyEmailUrl).origin;
        await this.email.sendSignupWelcome({
          to: account.email,
          dashboardUrl: `${origin}/select-tier`,
        });
      })().catch(() => {
        /* fire-and-forget */
      });
    }

    return outcome;
  }

  async login(args: LoginArgs): Promise<LoginResult> {
    const email = args.email.trim().toLowerCase();
    // Sign-in audit #3 — the per-email limit, reserved before anything about the
    // account is looked up (so it behaves the same for an unknown email) and
    // settled once the password has been checked.
    const attempt = await this.admitPasswordSignIn(email);
    let authenticated: AuthFlowAccountRow | null;
    try {
      authenticated = await this.authenticatePassword(args);
    } catch (err) {
      if (attempt !== null) await this.settlePasswordAttempt(() => attempt.abandoned());
      throw err;
    }
    if (authenticated === null) {
      if (attempt !== null) await this.settlePasswordAttempt(() => attempt.failed());
      throw new AuthFlowError('invalid_credentials');
    }
    // A correct password clears the email's count.
    if (attempt !== null) {
      await this.settlePasswordAttempt(() => attempt.succeeded({ clear: true }));
    }
    const account = authenticated;
    // Account-state checks come AFTER authentication: a wrong-password attempt
    // on a suspended/unverified account is then indistinguishable from any
    // other bad login, so neither state leaks to an unauthenticated probe. A
    // correct-password caller (the account owner) still learns the real state.
    if (account.status !== 'active') {
      throw new AuthFlowError('account_suspended');
    }
    if (account.emailVerifiedAt === null) {
      throw new AuthFlowError('email_not_verified');
    }
    return this.finishPasswordSignIn(account, args);
  }

  /**
   * The password check itself: the account when the password is right, null for
   * every kind of wrong (unknown email, no password, wrong password) — all at
   * the same cost.
   */
  private async authenticatePassword(args: {
    email: string;
    password: string;
  }): Promise<AuthFlowAccountRow | null> {
    const email = args.email.trim().toLowerCase();
    const password = args.password;
    const account = await this.findAccountByEmailOrCanonical(email);

    // Authenticate BEFORE branching on account state so the response time +
    // error are identical whether the email is unknown, password-less
    // (OAuth-only), suspended, or simply wrong-password — closing a login
    // user-enumeration side-channel (CWE-208). A non-existent / password-less
    // account runs a throwaway scrypt verify against a dummy hash so it can't
    // be told apart from a real wrong-password attempt by latency.
    // Audit-2 2026-07-08 (C3) — OAuth/IdP-created accounts carry the
    // EMPTY-STRING password sentinel (createFromIdp writes passwordHash: ''),
    // not null. verifyPassword('') fails FAST in its catch (unparseable hash,
    // zero scrypt work), so without the '' check here an OAuth-only account
    // returns ~instantly while a real password account takes ~scrypt-time —
    // re-opening the exact enumeration channel this branch exists to close.
    if (account === null || account.passwordHash === null || account.passwordHash === '') {
      await verifyPassword(password, await dummyPasswordHash());
      return null;
    }
    return (await verifyPassword(password, account.passwordHash)) ? account : null;
  }

  private async finishPasswordSignIn(
    account: AuthFlowAccountRow,
    args: LoginArgs,
  ): Promise<LoginResult> {
    // V-353d — branch on MFA enrollment. If enrolled, issue a
    // challenge token instead of a session; the customer exchanges it
    // at /v1/auth/mfa/challenge with their 6-digit code (or recovery
    // code) to get the actual session.
    if (this.mfa) {
      const status = await this.mfa.getStatus(account.id);
      if (status.enrolled) {
        const challenge = await this.createMfaChallenge(
          account,
          args.issuedFromIp,
          args.userAgent,
          'password',
        );
        return {
          kind: 'mfa_required',
          account,
          ...challenge,
        };
      }
    }

    const session = await this.issueWebSession(account, args.issuedFromIp, args.userAgent);
    await this.emitAuditBestEffort(account.id, 'account.login', {
      method: 'password',
      issued_from_ip: args.issuedFromIp,
      user_agent: args.userAgent,
    });
    return { kind: 'session', account, session };
  }

  /**
   * V-353d — exchange a challenge_token + 6-digit (or recovery code)
   * for the real session. Single-use: success consumes the token,
   * failure leaves the token alive so the customer can retype the
   * code (rate-limit on the route limits brute force).
   *
   * IP binding: if the challenge was issued from a different IP than
   * the consume request, refuse without consuming. Customer who
   * actually got their token via the legitimate /login response will
   * be on the same IP. Defense-in-depth — token is also short-lived
   * + bound to one account.
   */
  async completeMfaChallenge(args: MfaChallengeArgs): Promise<MfaChallengeResult> {
    if (!this.mfa || !this.mfaChallenges) {
      throw new AuthFlowError('invalid_auth_token', 'MFA challenge not available on this server.');
    }
    if (!args.code && !args.recoveryCode) {
      throw new AuthFlowError(
        'invalid_auth_token',
        'Either `code` or `recovery_code` must be provided.',
      );
    }

    // Peek first so an IP mismatch doesn't consume the token (legit
    // user can still retry from the right IP).
    const challengeKey = mfaChallengeKey(args.challengeToken);
    const peek = await this.mfaChallenges.peek(challengeKey);
    if (peek === null) {
      throw new AuthFlowError(
        'invalid_auth_token',
        'Challenge token is unknown or expired. Sign in again.',
      );
    }
    const payload = parseMfaChallengePayload(peek);
    if (payload === null) {
      // Corrupt state can never become a valid customer retry. Remove it so
      // malformed Redis data fails closed as a stable auth error instead of a
      // repeatable 500 or a verifier call with an invalid account identity.
      await this.mfaChallenges.consume(challengeKey);
      throw new AuthFlowError('invalid_auth_token', 'Challenge token is invalid. Sign in again.');
    }
    if (payload.source_ip !== null && payload.source_ip !== args.sourceIp) {
      throw new AuthFlowError(
        'invalid_auth_token',
        'Challenge token was issued from a different IP. Sign in again.',
      );
    }

    // Sign-in audit #2 — the account's limit, across every challenge. The
    // five-per-challenge bound below is per TOKEN and every fresh password
    // sign-in mints a new token, so on its own it bounded nothing per account.
    // Counted per account AND per the method that started the challenge
    // (re-audit defect 1), so a pause earned through one way in — a linked
    // GitHub account, say — leaves the owner's other ways in open.
    // Reserve-before-verify, like step-up: a burst of concurrent guesses cannot
    // all slip past a stale "not yet paused" read.
    let attempt: ReservedAttempt | null = null;
    if (this.mfaSignInLimiter !== null) {
      const admission = await this.mfaSignInLimiter.admit(
        mfaSignInSubject(payload.account_id, payload.method),
      );
      if (admission.kind === 'locked') {
        throw mfaSignInPausedError(admission.retryAfterSeconds, payload.method);
      }
      attempt = admission.attempt;
    }

    const input = args.code ?? args.recoveryCode!;
    let result: 'totp' | 'recovery' | null;
    try {
      result = await this.mfa.verifyCode({ accountId: payload.account_id, input });
    } catch (err) {
      await attempt?.abandoned();
      throw err;
    }
    if (result === null) {
      const outcome = attempt === null ? null : await attempt.failed();
      if (outcome?.locked === true && outcome.lockedUntil !== null) {
        // This was the tenth wrong code for the account by this method. The
        // challenge is dead with the pause; say so now rather than on the next
        // try.
        await this.mfaChallenges.consume(challengeKey);
        if (outcome.firstNotice) {
          await this.announceMfaSignInPause(
            payload.account_id,
            payload.method,
            outcome.lockedUntil,
          );
        }
        throw mfaSignInPausedError(MFA_SIGN_IN_LIMIT.lockSeconds, payload.method);
      }
      // V-353d.A — bound brute-force on the 6-digit/recovery code. The
      // token is left alive so the customer can retype, BUT only up to
      // MAX_MFA_CHALLENGE_ATTEMPTS wrong codes; past that we invalidate the
      // token so the attacker must re-/login (password + rate-limit) for a
      // fresh challenge. Atomic counter (Redis INCR) so concurrent guesses
      // can't undercount. Not a per-account lockout — no legit-user DoS.
      const attempts = await this.mfaChallenges.incrAttempts(
        mfaChallengeAttemptsKey(args.challengeToken),
        MFA_CHALLENGE_TTL_SECONDS,
      );
      // The sibling bound in stepUpReauth reads `attempts > MAX`, not `>=`, and the
      // difference is load-bearing rather than an inconsistency: this counter is
      // incremented ONLY on a failed verification, so `attempts` is the failure count
      // including this one and `>=` kills the token on the fifth. Step-up reserves a
      // slot BEFORE verifying, so its count includes the in-flight call and `>` refuses
      // the sixth. Both permit exactly MAX failures. Unifying the operators would move
      // a brute-force bound in opposite directions; the integration arm that submits
      // exactly 5 wrong codes and then a CORRECT one is what catches it here.
      if (attempts >= MAX_MFA_CHALLENGE_ATTEMPTS) {
        await this.mfaChallenges.consume(challengeKey);
        throw new AuthFlowError(
          'invalid_auth_token',
          'Too many incorrect codes for this sign-in. Sign in again to retry.',
        );
      }
      throw new AuthFlowError(
        'invalid_auth_token',
        'Code is invalid. Try again or use a recovery code.',
      );
    }

    // A right code is not a failure: give back only this attempt's slot. The
    // account's earlier failures still count, so the owner signing in does not
    // reset the count of someone guessing at the same time.
    await attempt?.succeeded();

    // Success — atomically CLAIM the single-use token before issuing the
    // session. consume() is an atomic GETDEL, so if two requests race the
    // same valid code (or recovery code) on the same challenge token, exactly
    // ONE gets the payload back; the loser must NOT mint a second session —
    // that would violate the stated single-use contract ("success consumes
    // the token"). Sequential reuse is already caught by the peek above; this
    // closes the concurrent window (both peek before either consumes). Issue
    // the session with the user-agent recorded at /login time so the row
    // looks like the original login attempt, not the challenge POST.
    const consumed = await this.mfaChallenges.consume(challengeKey);
    if (consumed === null) {
      throw new AuthFlowError(
        'invalid_auth_token',
        'Challenge token was already used. Sign in again.',
      );
    }

    const account = await this.repo.findAccountById(payload.account_id);
    if (account === null) {
      // Account vanished between issue + consume — treat as expired.
      throw new AuthFlowError('invalid_auth_token', 'Account is no longer active.');
    }
    if (account.status !== 'active') {
      throw new AuthFlowError('account_suspended');
    }

    const session = await this.issueWebSession(
      account,
      payload.source_ip,
      payload.issued_user_agent,
    );
    // V-353d — mark the freshly-issued session as MFA-satisfied so
    // step-up gates pass on it. The repo adapter handles the column
    // update; service stays opaque to the column name.
    await this.repo.markWebSessionMfaSatisfied(session.row.id, new Date());

    await this.emitAuditBestEffort(account.id, 'account.login', {
      method: result === 'recovery' ? 'mfa_recovery' : 'mfa_totp',
      issued_from_ip: payload.source_ip,
      user_agent: payload.issued_user_agent,
    });

    return { account, session, via: result };
  }

  async requestMagicLink(args: MagicLinkRequestArgs): Promise<MagicLinkRequestResult> {
    const email = args.email.trim().toLowerCase();
    const account = await this.findAccountByEmailOrCanonical(email);

    // Always return the same shape so the response doesn't leak account
    // existence. If no account, no token is issued and no email is sent.
    const expiresAt = new Date(Date.now() + AUTH_TOKEN_TTL_MS.magicLink);
    if (account === null) {
      this.logger.info(
        { component: 'auth-flows', flow: 'magic-link', email: maskEmail(email) },
        'magic-link requested for unknown email — no-op',
      );
      return { sent: false, expiresAt, debugToken: null };
    }
    if (account.status !== 'active') {
      this.logger.info(
        { component: 'auth-flows', flow: 'magic-link', accountId: account.id },
        'magic-link suppressed — account not active',
      );
      return { sent: false, expiresAt, debugToken: null };
    }

    const plaintext = generateAuthToken();
    await this.repo.insertAuthToken({
      kind: 'magic_link',
      accountId: account.id,
      tokenHash: tokenHash(plaintext),
      expiresAt,
      requestedFromIp: args.requestedFromIp,
    });

    const link = canonicalOneTimeTokenUrl(this.config.magicLinkUrl, plaintext);
    void this.email.sendSignupVerification({ to: account.email, link, expiresAt });

    return {
      sent: true,
      expiresAt,
      debugToken: this.config.exposeDebugToken ? plaintext : null,
    };
  }

  async consumeMagicLink(args: MagicLinkConsumeArgs): Promise<MagicLinkConsumeResult> {
    const now = new Date();
    const row = await this.repo.findActiveAuthToken({
      kind: 'magic_link',
      tokenHash: tokenHash(args.token),
      now,
    });
    if (row === null) throw new AuthFlowError('invalid_auth_token');

    // Claim every outstanding magic-link sibling for this account in the same
    // atomic UPDATE. One successful passwordless sign-in invalidates older
    // emails, and two different live links racing cannot mint two sessions.
    const consumed = await this.repo.consumeAuthTokenFamily({
      kind: 'magic_link',
      id: row.id,
      accountId: row.accountId,
      at: now,
    });
    if (!consumed) throw new AuthFlowError('invalid_auth_token');
    let account = await this.requireAccount(row.accountId);
    if (account.status !== 'active') throw new AuthFlowError('account_suspended');

    // Magic-link consumption also implicitly verifies the email — the user
    // demonstrably owns the inbox by clicking the link.
    //
    // Sign-in audit #1 — and when it is the FIRST proof of the mailbox, any
    // password on the account was set by whoever registered the address, who
    // never proved it. It must not survive the owner's proof: the same update
    // drops it and advances the auth epoch, ending every session minted under
    // it. The owner signs in now by this link and can set a password by reset.
    //
    // Re-audit defect 2 — and they are told. The person who really signed up
    // with their own password and then used a magic link before verifying lost
    // that password silently: the response now says `passwordRemoved`, and one
    // email goes to the account, sent only by the sign-in whose update removed it.
    let passwordRemoved = false;
    if (account.emailVerifiedAt === null) {
      const proven = await this.repo.verifyEmailDroppingUnprovenPassword(account.id, now);
      if (proven !== null) {
        passwordRemoved = holdsPassword(account.passwordHash);
        if (this.authCache) {
          try {
            await this.authCache.invalidateAccount(account.id);
          } catch {
            /* the epoch check at lookup still refuses the old sessions */
          }
        }
        await this.emitAuditBestEffort(account.id, 'account.email_verified', {
          via: 'magic_link',
          password_removed: passwordRemoved,
          issued_from_ip: args.issuedFromIp,
          user_agent: args.userAgent,
        });
        if (passwordRemoved) {
          void this.email.sendPasswordRemoved({
            to: proven.email,
            removedAt: now,
            resetUrl: this.forgotPasswordUrl(),
          });
        }
      }
      // Whichever proof won, sign in under the account's current authority.
      account = proven ?? (await this.requireAccount(account.id));
    }

    // A magic link proves mailbox control, not possession of the account's
    // enrolled second factor. Mirror password/OAuth login: return the shared
    // short-lived challenge and do not mint a session until TOTP/recovery is
    // verified. createMfaChallenge deliberately fails closed if its store is
    // unavailable.
    if (this.mfa !== null && (await this.mfa.getStatus(account.id)).enrolled) {
      return {
        kind: 'mfa_required',
        account,
        passwordRemoved,
        // A link sent to the address started this sign-in.
        ...(await this.createMfaChallenge(
          account,
          args.issuedFromIp,
          args.userAgent,
          'email_link',
        )),
      };
    }

    const session = await this.issueWebSession(account, args.issuedFromIp, args.userAgent);
    // Sign-in audit #9 — a magic-link sign-in is a sign-in: "Recent activity"
    // promises sessions started, and this one started a session.
    await this.emitAuditBestEffort(account.id, 'account.login', {
      method: 'magic_link',
      issued_from_ip: args.issuedFromIp,
      user_agent: args.userAgent,
    });
    return { kind: 'session', account, session, passwordRemoved };
  }

  async requestPasswordReset(args: PasswordResetRequestArgs): Promise<PasswordResetRequestResult> {
    const email = args.email.trim().toLowerCase();
    const account = await this.findAccountByEmailOrCanonical(email);
    const expiresAt = new Date(Date.now() + AUTH_TOKEN_TTL_MS.passwordReset);

    if (account === null) {
      this.logger.info(
        { component: 'auth-flows', flow: 'password-reset', email: maskEmail(email) },
        'password-reset requested for unknown email — no-op',
      );
      return { sent: false, expiresAt, debugToken: null };
    }
    if (account.status !== 'active') {
      return { sent: false, expiresAt, debugToken: null };
    }

    const plaintext = generateAuthToken();
    await this.repo.insertAuthToken({
      kind: 'password_reset',
      accountId: account.id,
      tokenHash: tokenHash(plaintext),
      expiresAt,
      requestedFromIp: args.requestedFromIp,
    });
    const link = canonicalOneTimeTokenUrl(this.config.passwordResetUrl, plaintext);
    void this.email.sendPasswordReset({ to: account.email, link, expiresAt });

    return {
      sent: true,
      expiresAt,
      debugToken: this.config.exposeDebugToken ? plaintext : null,
    };
  }

  async confirmPasswordReset(args: PasswordResetConfirmArgs): Promise<PasswordResetConfirmResult> {
    const now = new Date();
    const row = await this.repo.findActiveAuthToken({
      kind: 'password_reset',
      tokenHash: tokenHash(args.token),
      now,
    });
    if (row === null) throw new AuthFlowError('invalid_auth_token');

    // Single-use under concurrency: critical here — two concurrent confirms on
    // the same token would each issue a session AND each call
    // revokeAllWebSessionsExceptCurrent, mutually revoking each other (lockout).
    // Reject the loser so exactly one reset+session survives.
    // A successful password reset must invalidate every other reset link for
    // the account. Claiming the whole unconsumed family in one conditional
    // UPDATE also serializes two DIFFERENT valid tokens: exactly one UPDATE
    // returns its presented id, so only one password write/session issuance
    // can proceed.
    const consumed = await this.repo.consumeAuthTokenFamily({
      kind: 'password_reset',
      id: row.id,
      accountId: row.accountId,
      at: now,
    });
    if (!consumed) throw new AuthFlowError('invalid_auth_token');
    const account = await this.requireAccount(row.accountId);
    if (account.status !== 'active') throw new AuthFlowError('account_suspended');
    const mfaRequired = this.mfa !== null && (await this.mfa.getStatus(account.id)).enrolled;
    const newHash = await hashPassword(args.newPassword);
    const accountAfterPasswordChange = await this.repo.setPassword(account.id, newHash);
    if (accountAfterPasswordChange === null) throw new AuthFlowError('account_suspended');

    // Sign-in audit #7 — the reset link arrived in the mailbox and was used, so
    // the reset proves the address exactly as the verification link does. Left
    // unverified, the new password's next sign-in was refused as "not verified".
    // It is also the safe way out of sign-in audit #1: whoever registered the
    // address in someone else's name loses the password they chose.
    if (await this.repo.markEmailVerified(account.id, now)) {
      await this.emitAuditBestEffort(account.id, 'account.email_verified', {
        via: 'password_reset',
        issued_from_ip: args.issuedFromIp,
        user_agent: args.userAgent,
      });
    }
    // Sign-in audit #3 — the new password starts with a clean count: a reset
    // proves the mailbox, so guesses at the OLD password no longer hold the
    // owner out. Best-effort, like every other use of the limit's store here.
    if (this.passwordSignInLimiter !== null) {
      const limiter = this.passwordSignInLimiter;
      await this.settlePasswordAttempt(() =>
        limiter.clear(canonicalizeEmailForDedup(accountAfterPasswordChange.email)),
      );
    }

    if (mfaRequired) {
      // Password reset is a compromise-recovery boundary. With MFA enrolled,
      // there is no new session to retain yet: revoke every old session before
      // issuing the challenge so a stolen bearer cannot survive the reset.
      await this.revokeSessionsAfterPasswordReset(account.id, null, now);
      await this.emitAuditBestEffort(account.id, 'account.password_changed', {
        via: 'password_reset',
        issued_from_ip: args.issuedFromIp,
        user_agent: args.userAgent,
      });
      return {
        kind: 'mfa_required',
        account: accountAfterPasswordChange,
        // A reset hands the person a password, so its challenge counts with
        // password sign-ins: a pause earned through a linked Google/GitHub
        // sign-in or an email link never blocks it (re-audit defect 1), and a
        // password-method pause still does — the reset itself went through and
        // the refusal says so.
        ...(await this.createMfaChallenge(
          accountAfterPasswordChange,
          args.issuedFromIp,
          args.userAgent,
          'password',
          { afterPasswordChange: true },
        )),
      };
    }

    const session = await this.issueWebSession(
      accountAfterPasswordChange,
      args.issuedFromIp,
      args.userAgent,
    );
    // Security: a password reset is a compromise-recovery action, so revoke
    // EVERY OTHER web session (an attacker-held session must not survive the
    // reset) while keeping the just-issued one. The reset-specific helper also
    // invalidates the auth cache and attributes the revocation accurately.
    // Without this, a stolen/lingering session stayed valid after the victim
    // reset — defeating
    // the reset's purpose (OWASP session-management: invalidate sessions on
    // credential change).
    await this.revokeSessionsAfterPasswordReset(account.id, session.row.id, now);
    await this.emitAuditBestEffort(account.id, 'account.password_changed', {
      via: 'password_reset',
      issued_from_ip: args.issuedFromIp,
      user_agent: args.userAgent,
    });
    return { kind: 'session', account: accountAfterPasswordChange, session };
  }

  async refreshSession(args: RefreshSessionArgs): Promise<RefreshSessionResult> {
    const hash = tokenHash(args.token);
    // Security fix (2026-06-30 audit) — serialize concurrent refreshes of
    // the SAME token so the find-then-revoke-then-mint sequence below
    // can't race itself. See withKeyedLock's doc comment for the full
    // rationale.
    return this.withKeyedLock(hash, async () => {
      const now = new Date();
      const old = await this.repo.findActiveWebSession({ tokenHash: hash, now });
      if (old === null) throw new AuthFlowError('invalid_auth_token');

      // Rotate: revoke the old row, issue a new one. The plaintext returned
      // is the new token; the old plaintext is now useless.
      const claimed = await this.repo.revokeWebSession(old.id, now);
      if (!claimed) throw new AuthFlowError('invalid_auth_token');
      // Invalidate any cached web-session AccountContext for the rotated-out
      // token — mirrors every other revoke path here (logout / stepUpReauth /
      // revokeWebSessionForAccount / revokeAll*). Without this the DB-revoked
      // old token keeps authenticating on the cache fast-path (which re-checks
      // only expiresAt, not revokedAt) for up to the 30s TTL, a rotation-replay
      // window. Best-effort — a cache failure doesn't undo the DB revocation.
      if (this.authCache) {
        try {
          await this.authCache.invalidateAccount(old.accountId);
        } catch {
          // Drop on the floor; cache will TTL out within 30s.
        }
      }
      const account = await this.requireAccount(old.accountId);
      // The rotated row keeps the chain's sign-in time (its createdAt), as it
      // keeps the epoch: a refresh is not a sign-in (sign-in audit #4).
      const session = await this.issueWebSession(
        account,
        args.issuedFromIp,
        args.userAgent,
        old.authEpoch,
        old.createdAt,
      );
      return { account, session };
    });
  }

  async logout(plaintextToken: string): Promise<void> {
    const now = new Date();
    const row = await this.repo.findActiveWebSession({
      tokenHash: tokenHash(plaintextToken),
      now,
    });
    if (row === null) return; // already-revoked / unknown token: no-op
    await this.repo.revokeWebSession(row.id, now);
    // V-168 — invalidate any cached web-session AccountContext. Same
    // pattern API key revocation uses (V-016 / D-025). Best-effort —
    // a cache failure here doesn't undo the DB-level revocation.
    if (this.authCache) {
      try {
        await this.authCache.invalidateAccount(row.accountId);
      } catch {
        // Drop on the floor; cache will TTL out within 30s.
      }
    }
    await this.emitAuditBestEffort(row.accountId, 'account.logout', {
      session_id: row.id,
    });
  }

  /**
   * V-353e — step-up reauth WITHOUT re-logging-in. Caller is already
   * authenticated via web session; they post the 6-digit (or recovery)
   * code, we verify against their MFA enrollment, and refresh the
   * `mfa_satisfied_at` column on the calling session. Distinct from
   * `completeMfaChallenge` which is the LOGIN-PATH hand-off (no
   * pre-existing session).
   */
  async stepUpReauth(args: {
    accountId: string;
    sessionId: string;
    input: string;
  }): Promise<{ via: 'totp' | 'recovery'; mfaSatisfiedAt: Date }> {
    if (!this.mfa) {
      throw new AuthFlowError('invalid_auth_token', 'MFA step-up not available on this server.');
    }
    // Security fix (2026-06-30 audit) — bound brute-force the same way
    // completeMfaChallenge (the login-path sibling, above) does. That
    // flow keys its counter on the single-use challenge_token and
    // invalidates the token past MAX_MFA_CHALLENGE_ATTEMPTS, forcing a
    // fresh /login. stepUpReauth has no token to invalidate — the
    // caller already holds a persistent, valid web session — so this
    // keys the same counter primitive on accountId instead. Each in-flight
    // proof reserves a slot before verification (so a concurrent burst cannot
    // pass a stale precheck); invalid proofs retain it, while valid proofs and
    // verifier errors release only their own reservation. Once the account has
    // MAX failed/in-flight proofs, further calls are refused until a slot is
    // released or the window lapses. Without this, loginGate's per-IP-only
    // throttle could be bypassed by spreading guesses across source IPs.
    const attemptKey = stepUpAttemptsKey(args.accountId);
    if (this.mfaChallenges) {
      const attempts = await this.mfaChallenges.incrAttempts(attemptKey, MFA_CHALLENGE_TTL_SECONDS);
      // Reads `>` where completeMfaChallenge's sibling bound reads `>=`. Deliberate:
      // that counter increments only on a failed verification, while this one reserves
      // a slot before verification for every proof, so the in-flight call is already
      // counted here. Both permit exactly MAX failures. A consistency cleanup that
      // unified them would silently tighten one side and loosen the other; the content
      // -parity pin on this line is what catches it here.
      if (attempts > MAX_MFA_CHALLENGE_ATTEMPTS) {
        await this.releaseStepUpAttemptBestEffort(attemptKey);
        throw new AuthFlowError(
          'invalid_auth_token',
          'Too many incorrect codes. Wait a few minutes and try again.',
        );
      }
    }
    let result: 'totp' | 'recovery' | null;
    try {
      result = await this.mfa.verifyCode({
        accountId: args.accountId,
        input: args.input,
      });
    } catch (err) {
      if (this.mfaChallenges) await this.releaseStepUpAttemptBestEffort(attemptKey);
      throw err;
    }
    if (result === null) {
      // Invalid proofs retain the reservation as one failed attempt.
      throw new AuthFlowError(
        'invalid_auth_token',
        'Code is invalid. Try again or use a recovery code.',
      );
    }
    // A valid proof is not a failed attempt. Release only this request's
    // reservation; concurrent invalid proofs keep their own slots.
    if (this.mfaChallenges) await this.releaseStepUpAttemptBestEffort(attemptKey);
    const now = new Date();
    await this.repo.markWebSessionMfaSatisfied(args.sessionId, now);
    if (this.authCache) {
      try {
        await this.authCache.invalidateAccount(args.accountId);
      } catch {
        /* swallow */
      }
    }
    return { via: result, mfaSatisfiedAt: now };
  }

  // ──────────────────── V-355: web-session list / revoke ────────────────────

  /**
   * V-355 — list the calling account's currently-active web sessions
   * for the dashboard's "Active sign-ins" section. Filtered to
   * non-revoked + non-expired rows. Tokens are NOT returned (token-
   * hash is derived from the plaintext that the caller already has;
   * exposing it serves no purpose and risks accidental log capture).
   */
  async listActiveWebSessions(accountId: string, now = new Date()): Promise<WebSessionRow[]> {
    return this.repo.listActiveWebSessionsForAccount(accountId, now);
  }

  /**
   * V-355 — revoke a single web session by id, scoped to an account.
   * Returns false when the session doesn't exist or belongs to a
   * different account (route layer turns false into 404). Already-
   * revoked sessions short-circuit to true (idempotent). On success,
   * invalidates the auth cache so the next request from that token
   * misses and re-resolves to the now-revoked row.
   */
  async revokeWebSessionForAccount(
    accountId: string,
    sessionId: string,
    now = new Date(),
  ): Promise<boolean> {
    const row = await this.repo.findWebSessionByIdForAccount(sessionId, accountId);
    if (row === null) return false;
    if (row.revokedAt === null) {
      await this.repo.revokeWebSession(row.id, now);
      if (this.authCache) {
        try {
          await this.authCache.invalidateAccount(accountId);
        } catch {
          /* cache TTLs out within 30s */
        }
      }
      await this.emitAuditBestEffort(accountId, 'account.logout', {
        session_id: row.id,
        revoked_via: 'self_dashboard',
      });
    }
    return true;
  }

  /**
   * V-355 — bulk-revoke every web session for the account except the
   * one the caller is currently using. Used by "Sign out everywhere
   * else." Returns the count of rows revoked.
   */
  async revokeAllWebSessionsExceptCurrent(
    accountId: string,
    currentSessionId: string,
    now = new Date(),
  ): Promise<number> {
    const n = await this.repo.revokeAllWebSessionsExcept(accountId, currentSessionId, now);
    if (n > 0 && this.authCache) {
      try {
        await this.authCache.invalidateAccount(accountId);
      } catch {
        /* cache TTLs out within 30s */
      }
    }
    if (n > 0) {
      await this.emitAuditBestEffort(accountId, 'account.logout', {
        revoked_via: 'self_dashboard_revoke_all',
        revoked_count: n,
        kept_session_id: currentSessionId,
      });
    }
    return n;
  }

  /**
   * GDPR Article 17 — bulk-revoke EVERY web session for the account,
   * no exclusion. Backs AccountsAdminService.deleteAccount(); unlike
   * revokeAllWebSessionsExceptCurrent (customer "sign out everywhere
   * else"), there is no session to keep alive during an admin-
   * triggered account termination. Same cache-invalidate + audit-
   * emit shape as its sibling above, except that the row names the
   * staff member who terminated the account (`staff`, no key) — it
   * used to read as the customer signing themselves out.
   */
  async revokeAllWebSessionsForAccount(
    accountId: string,
    now: Date,
    staffAccountId: string,
  ): Promise<number> {
    const n = await this.repo.revokeAllWebSessionsForAccount(accountId, now);
    if (n > 0 && this.authCache) {
      try {
        await this.authCache.invalidateAccount(accountId);
      } catch {
        /* cache TTLs out within 30s */
      }
    }
    if (n > 0 && this.accountAudit !== null) {
      try {
        await this.accountAudit.record({
          accountId,
          actorType: 'staff',
          actorAccountId: staffAccountId,
          actorKeyId: null,
          action: 'account.logout',
          targetResourceId: null,
          payload: { revoked_via: 'admin_account_deletion', revoked_count: n },
        });
      } catch (err) {
        this.logger.warn(
          { component: 'auth-flows', action: 'account.logout', accountId, err },
          'account-audit emit failed (best-effort, swallowed)',
        );
      }
    }
    return n;
  }

  /**
   * Sign-in audit #5 — remove one of the account's linked Google/GitHub
   * sign-ins. The row is DELETED (not stamped revoked): the next sign-in with
   * that identity finds no link and goes to the emailed merge confirmation, like
   * any identity never linked — so the removed link can no longer sign in, and
   * the owner can still link it again later through that confirmation. Refused
   * when it is the account's last way to sign in. A removal leaves a "Recent
   * activity" row and emails the account.
   *
   * It does not end sessions already signed in through the link; "Sign out
   * everywhere else" does that, and the dashboard says so.
   */
  async removeOAuthLink(args: {
    accountId: string;
    linkId: string;
  }): Promise<'removed' | 'not_found' | 'last_sign_in_method'> {
    const result = await this.repo.removeOAuthLink(args);
    if (result.kind !== 'removed') return result.kind;
    const removedAt = new Date();
    await this.emitAuditBestEffort(
      args.accountId,
      'account.oauth_link_removed',
      { provider: result.provider },
      null,
      { targetResourceId: `ol_${args.linkId}` },
    );
    try {
      const account = await this.repo.findAccountById(args.accountId);
      if (account !== null) {
        void this.email.sendOauthLinkRemoved({
          to: account.email,
          provider: result.provider,
          providerEmail: result.providerEmail,
          removedAt,
          resetUrl: this.forgotPasswordUrl(),
        });
      }
    } catch (err) {
      this.logger.warn(
        { component: 'auth-flows', flow: 'oauth-link-removal', accountId: args.accountId, err },
        'linked sign-in removal notice not sent (best-effort, swallowed)',
      );
    }
    return 'removed';
  }

  // ──────────────────── helpers ────────────────────

  /**
   * A password reset is how a customer recovers from a stolen credential, so it
   * ends every prior sign-in: the web sessions AND the desktop app's device
   * credentials. The desktop app does not hold a web session — its sign-in is an
   * API key minted by the device-code flow (`provenance = 'cli_device'`) — so a
   * reset that revoked only web sessions left a stolen desktop credential working,
   * with `account_owner`, contrary to the docs ("Every prior device must
   * re-authenticate"). Both are revoked in one transaction by the repo. Keys the
   * customer minted themselves are integrations and are not revoked.
   *
   * Each revoked device credential gets its auth-cache entry dropped, the
   * `api_key.revoked` webhook (the ordinary revoke path's payload), and one
   * `api_key.revoked` row on the account's log, attributed exactly as the
   * reset's own sign-out row is: `customer`, the account itself, no key. All of
   * it after the repo's transaction has committed, and best-effort: the
   * revocation itself is what makes the reset safe.
   */
  private async revokeSessionsAfterPasswordReset(
    accountId: string,
    keepSessionId: string | null,
    now: Date,
  ): Promise<number> {
    const revoked = await this.repo.revokeCredentialsAfterPasswordReset(
      accountId,
      keepSessionId,
      now,
    );
    // Password change increments auth_epoch even when the physical sweep finds
    // no live rows. Always invalidate: a previously cached context must not
    // survive the credential boundary merely because its DB row was already
    // revoked or a concurrent refresh lost the epoch fence.
    if (this.authCache) {
      try {
        await this.authCache.invalidateAccount(accountId);
      } catch {
        /* cache TTLs out within 30s */
      }
      for (const key of revoked.deviceKeys) {
        try {
          await this.authCache.invalidateKey(key.id);
        } catch {
          /* the cache hit re-reads the key row, which is already revoked */
        }
      }
    }
    if (revoked.webSessions > 0) {
      await this.emitAuditBestEffort(accountId, 'account.logout', {
        revoked_via: 'password_reset',
        revoked_count: revoked.webSessions,
        ...(keepSessionId === null ? {} : { kept_session_id: keepSessionId }),
      });
    }
    for (const key of revoked.deviceKeys) {
      if (this.webhooksService !== null) {
        try {
          await this.webhooksService.enqueueEvent(accountId, 'api_key.revoked', {
            api_key_id: `key_${key.id}`,
            name: key.name,
            revoked_at: now.toISOString(),
          });
        } catch (err) {
          // Best-effort, but at ERROR with the event type and account (webhooks
          // audit #5): no endpoint will ever receive this revocation.
          logLostWebhookEvent(this.logger, {
            component: 'auth-flows',
            accountId,
            eventType: 'api_key.revoked',
            err,
            context: { flow: 'password-reset', api_key_id: key.id },
          });
        }
      }
      await this.emitAuditBestEffort(
        accountId,
        'api_key.revoked',
        { name: key.name, revoked_at: now.toISOString(), revoked_via: 'password_reset' },
        null,
        { targetResourceId: `key_${key.id}` },
      );
    }
    return revoked.webSessions;
  }

  private async releaseStepUpAttemptBestEffort(key: string): Promise<void> {
    try {
      await this.mfaChallenges?.releaseAttempt(key);
    } catch (err) {
      // A transient Redis release failure must not discard a TOTP that was
      // already consumed successfully. The counter expires after five minutes.
      this.logger.warn(
        { component: 'auth-flows', flow: 'mfa-step-up', err },
        'failed to release successful MFA step-up attempt reservation',
      );
    }
  }

  private async requireAccount(id: string): Promise<AuthFlowAccountRow> {
    // Same repo doesn't expose a getById; we read via email lookup as a
    // last-resort, but the caller path always knows the account row was
    // present moments ago, so we avoid the round-trip and reconstruct
    // minimally — refactor to add findById if a real need surfaces.
    const all = await this.repo.findAccountById(id);
    if (all === null) {
      // This should not happen in practice — caller always has a fresh row.
      throw new AuthFlowError('invalid_auth_token', 'account vanished mid-flow');
    }
    return all;
  }

  private async issueWebSession(
    account: AuthFlowAccountRow,
    issuedFromIp: string | null,
    userAgent: string | null,
    authorityEpoch = account.authEpoch,
    /** The sign-in this session descends from; omitted for a sign-in (now). */
    signedInAt?: Date,
  ): Promise<{ plaintext: string; row: WebSessionRow }> {
    // Shared fail-closed invariant for every current/future session-mint path.
    // Callers may retain earlier checks for clearer flow ordering, but none can
    // accidentally create a latent 30-day row while an account is suspended.
    if (account.status !== 'active') throw new AuthFlowError('account_suspended');
    const plaintext = generateAuthToken();
    const expiresAt = new Date(Date.now() + AUTH_TOKEN_TTL_MS.webSession);
    const row = await this.repo.insertWebSession({
      accountId: account.id,
      tokenHash: tokenHash(plaintext),
      authEpoch: authorityEpoch,
      expiresAt,
      issuedFromIp,
      userAgent,
      ...(signedInAt !== undefined ? { createdAt: signedInAt } : {}),
    });
    // A password/status transition won after the caller's account read. The
    // repo did not insert a row, so never surface the generated plaintext.
    if (row === null) throw new AuthFlowError('invalid_auth_token');
    return { plaintext, row };
  }

  /**
   * 2026-05-19 — public wrapper for OAuth-client callback after
   * linkOrCreateAccount succeeds. Looks up the account, mints the
   * same 30-day web session the password/magic-link/MFA paths mint,
   * then emits an `account.login` audit row attributing the sign-in
   * to the IDP provider. The IDP attestation is the primary factor;
   * an enrolled Driftstack second factor still applies below.
   *
   * Founder report 2026-05-19: prior to this method, the OAuth
   * callback returned `{outcome, account_id, redirect_to}` with NO
   * session token; the dashboard then showed "Sign in to see live
   * account data" because localStorage was empty. This closes the
   * gap.
   *
   * Returns `null` if the account was deleted or became inactive. Enrolled
   * accounts receive the same short-lived, IP-bound MFA challenge used by
   * password login instead of session plaintext.
   */
  async issueOAuthWebSession(args: {
    accountId: string;
    issuedFromIp: string | null;
    userAgent: string | null;
    provider: OAuthClientProvider;
  }): Promise<OAuthWebSessionResult | null> {
    const account = await this.repo.findAccountById(args.accountId);
    if (account === null || account.status !== 'active') return null;
    if (this.mfa !== null && (await this.mfa.getStatus(account.id)).enrolled) {
      if (this.mfaChallenges === null) return null;
      return {
        kind: 'mfa_required',
        // The linked provider started this sign-in; its wrong codes pause only
        // this provider's sign-ins (re-audit defect 1).
        ...(await this.createMfaChallenge(
          account,
          args.issuedFromIp,
          args.userAgent,
          args.provider,
        )),
      };
    }
    const session = await this.issueWebSession(account, args.issuedFromIp, args.userAgent);
    await this.emitAuditBestEffort(args.accountId, 'account.login', {
      kind: 'oauth_callback',
      provider: args.provider,
      session_id: session.row.id,
    });
    return { kind: 'session', session };
  }
}
