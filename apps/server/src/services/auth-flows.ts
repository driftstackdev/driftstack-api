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
import { isUniqueViolation } from '../lib/pg-error.js';
import { maskEmail } from '../lib/redact-url.js';
import type { EmailService } from './email.js';
import type { AuthCache } from './auth-cache.js';
import type { AccountAuditService } from './account-audit.js';
import type { EmailPreferencesService } from './email-preferences.js';
import type { MfaService } from './mfa.js';
import {
  type MfaChallengePayload,
  type MfaChallengeStore,
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
  /** Update password_hash. */
  setPassword(accountId: string, passwordHash: string): Promise<void>;
  /** Mark email as verified — idempotent (no-op if already verified). */
  /** C9 — returns true iff THIS call performed the null→verified transition
   *  (so the caller can fire the one-time signup-welcome exactly once). */
  markEmailVerified(accountId: string, at: Date): Promise<boolean>;

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
   * of this call's UPDATE, so two different reset links racing for one account
   * cannot both perform credential-changing side effects.
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

  /** Insert a new web-session row. */
  insertWebSession(args: {
    accountId: string;
    tokenHash: string;
    expiresAt: Date;
    issuedFromIp: string | null;
    userAgent: string | null;
  }): Promise<WebSessionRow>;
  findActiveWebSession(args: { tokenHash: string; now: Date }): Promise<WebSessionRow | null>;
  touchWebSession(id: string, at: Date): Promise<void>;
  revokeWebSession(id: string, at: Date): Promise<void>;
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
   * V-353d — set web_sessions.mfa_satisfied_at on a session id. Used
   * by completeMfaChallenge so step-up gates pass.
   */
  markWebSessionMfaSatisfied(id: string, at: Date): Promise<void>;
}

// ───────────────────────────────────────────────────────────────────────────
// Errors
// ───────────────────────────────────────────────────────────────────────────

export type AuthFlowErrorCode =
  | 'email_already_registered'
  | 'invalid_credentials'
  | 'email_not_verified'
  | 'invalid_auth_token'
  | 'account_suspended';

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
 * 2026-06-30; storage-backed 2026-07-01). Two normalizations, applied
 * to the local part only:
 *
 *   1. `+tag` subaddressing is stripped for EVERY domain — a
 *      universal Internet convention (RFC 5233), so
 *      `foo+anything@example.com` canonicalizes to `foo@example.com`
 *      regardless of provider.
 *   2. Dots are ALSO stripped, but ONLY for gmail.com / googlemail.com
 *      — Gmail specifically treats `f.o.o@gmail.com` as identical to
 *      `foo@gmail.com`. This is a Gmail-only quirk; dots are
 *      significant in the local part for other providers, so this
 *      must NOT generalize to other domains.
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
  const noTag = localPart.split('+')[0] ?? '';
  const isGmail = domain === 'gmail.com' || domain === 'googlemail.com';
  const canonicalLocal = isGmail ? noTag.replace(/\./g, '') : noTag;
  return `${canonicalLocal}@${domain}`;
}

// ───────────────────────────────────────────────────────────────────────────
// Service
// ───────────────────────────────────────────────────────────────────────────

export interface AuthFlowsServiceConfig {
  /** Base URL the verify-email link points at (no trailing slash). */
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
  issuedFromIp: string | null;
  userAgent: string | null;
}

export interface VerifyEmailResult {
  account: AuthFlowAccountRow;
  session: { plaintext: string; row: WebSessionRow };
}

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

export interface MagicLinkConsumeResult {
  account: AuthFlowAccountRow;
  session: { plaintext: string; row: WebSessionRow };
}

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

export interface PasswordResetConfirmResult {
  account: AuthFlowAccountRow;
  session: { plaintext: string; row: WebSessionRow };
}

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

export class AuthFlowsService {
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
  ) {}

  /**
   * Security fix (2026-06-30 audit) — in-process single-flight queue
   * keyed on an arbitrary string (refreshSession keys on the presented
   * token's hash). Closes a TOCTOU race: refreshSession does
   * find-active-session (SELECT) → revoke (UPDATE) → mint (INSERT) with
   * no atomic claim between the read and the mint — unlike every OTHER
   * single-use-token flow in this file (verifyEmail / consumeMagicLink /
   * confirmPasswordReset), which reject a concurrent loser via
   * `consumeAuthToken`'s atomic UPDATE...RETURNING boolean.
   * `AuthFlowsRepo.revokeWebSession` has no equivalent boolean return,
   * so two requests racing the SAME refresh token could both pass the
   * find before either's revoke lands, and both mint an independent new
   * session. `withKeyedLock` serializes callers sharing a key so the
   * second caller's find always observes the first caller's revoke and
   * correctly rejects with `invalid_auth_token` — the same "reject the
   * race loser" contract the codebase already guarantees elsewhere.
   * This is process-wide (not cross-process/cross-host); the Driftstack
   * API runs one Node process per host (systemd Type=simple, no cluster
   * mode — infra/systemd/driftstack-api.service), so this closes the
   * race for the current deployment topology. If the service is ever
   * horizontally scaled, the durable fix is to give
   * `AuthFlowsRepo.revokeWebSession` an atomic claim-and-return-boolean
   * (mirroring `consumeAuthToken`) so the guarantee survives across
   * processes too.
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
      'account.email_verified' | 'account.login' | 'account.logout' | 'account.password_changed',
    payload: Record<string, unknown>,
    actorAccountId: string | null = null,
  ): Promise<void> {
    if (this.accountAudit === null) return;
    try {
      await this.accountAudit.record({
        accountId,
        actorType: 'customer',
        actorAccountId: actorAccountId ?? accountId,
        actorKeyId: null,
        action,
        targetResourceId: null,
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
    const canonicalEmail = canonicalizeEmailForDedup(email);
    const [byLiteral, byCanonical] = await Promise.all([
      this.repo.findAccountByEmail(email),
      this.repo.findAccountByCanonicalEmail(canonicalEmail),
    ]);
    return byLiteral ?? byCanonical;
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

    const link = `${this.config.verifyEmailUrl}?token=${plaintext}`;
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
  // Previously-issued email_verify tokens for the account are NOT
  // expired here; the verify-email handler is single-use anyway, so a
  // user who happens to click an old link still works. The new token
  // is appended.
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

    const link = `${this.config.verifyEmailUrl}?token=${plaintext}`;
    void this.email.sendSignupVerification({ to: email, link, expiresAt });

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

    // Single-use under concurrency: only the request that actually claims the
    // token proceeds. A concurrent loser (consume returned false) is rejected
    // rather than issuing a second session + re-firing the welcome email.
    const consumed = await this.repo.consumeAuthToken({
      kind: 'email_verify',
      id: row.id,
      at: now,
    });
    if (!consumed) throw new AuthFlowError('invalid_auth_token');
    const firstVerification = await this.repo.markEmailVerified(row.accountId, now);

    const account = await this.requireAccount(row.accountId);
    const session = await this.issueWebSession(account, args.issuedFromIp, args.userAgent);

    await this.emitAuditBestEffort(account.id, 'account.email_verified', {
      issued_from_ip: args.issuedFromIp,
      user_agent: args.userAgent,
    });

    // V-202 — fire signup-welcome email after the verify lands. Derive
    // the dashboard origin from `verifyEmailUrl` (the verify link
    // already lives on the customer dashboard host). Fire-and-forget;
    // matches the email-service posture used elsewhere.
    //
    // C9 — send ONLY on the first null→verified transition (a re-verification
    // via a second outstanding token still mints a session but must not
    // re-welcome), and honor the V-204 'signup-welcome' opt-out when the
    // email-preferences service is wired.
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

    return { account, session };
  }

  async login(args: LoginArgs): Promise<LoginResult> {
    const account = await this.findAccountByEmailOrCanonical(args.email.trim().toLowerCase());

    // Authenticate BEFORE branching on account state so the response time +
    // error are identical whether the email is unknown, password-less
    // (OAuth-only), suspended, or simply wrong-password — closing a login
    // user-enumeration side-channel (CWE-208). A non-existent / password-less
    // account runs a throwaway scrypt verify against a dummy hash so it can't
    // be told apart from a real wrong-password attempt by latency.
    // Fable audit-2 2026-07-08 (C3) — OAuth/IdP-created accounts carry the
    // EMPTY-STRING password sentinel (createFromIdp writes passwordHash: ''),
    // not null. verifyPassword('') fails FAST in its catch (unparseable hash,
    // zero scrypt work), so without the '' check here an OAuth-only account
    // returns ~instantly while a real password account takes ~scrypt-time —
    // re-opening the exact enumeration channel this branch exists to close.
    if (account === null || account.passwordHash === null || account.passwordHash === '') {
      await verifyPassword(args.password, await dummyPasswordHash());
      throw new AuthFlowError('invalid_credentials');
    }
    const ok = await verifyPassword(args.password, account.passwordHash);
    if (!ok) throw new AuthFlowError('invalid_credentials');
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

    // V-353d — branch on MFA enrollment. If enrolled, issue a
    // challenge token instead of a session; the customer exchanges it
    // at /v1/auth/mfa/challenge with their 6-digit code (or recovery
    // code) to get the actual session.
    if (this.mfa && this.mfaChallenges) {
      const status = await this.mfa.getStatus(account.id);
      if (status.enrolled) {
        const token = generateChallengeToken();
        const payload: MfaChallengePayload = {
          account_id: account.id,
          email: account.email,
          source_ip: args.issuedFromIp,
          issued_at: Date.now(),
          issued_user_agent: args.userAgent,
        };
        await this.mfaChallenges.set(
          mfaChallengeKey(token),
          JSON.stringify(payload),
          MFA_CHALLENGE_TTL_SECONDS,
        );
        return {
          kind: 'mfa_required',
          account,
          challengeToken: token,
          challengeExpiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_SECONDS * 1000),
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
    const peek = await this.mfaChallenges.peek(mfaChallengeKey(args.challengeToken));
    if (peek === null) {
      throw new AuthFlowError(
        'invalid_auth_token',
        'Challenge token is unknown or expired. Sign in again.',
      );
    }
    const payload = JSON.parse(peek) as MfaChallengePayload;
    if (
      payload.source_ip !== null &&
      args.sourceIp !== null &&
      payload.source_ip !== args.sourceIp
    ) {
      throw new AuthFlowError(
        'invalid_auth_token',
        'Challenge token was issued from a different IP. Sign in again.',
      );
    }

    const input = args.code ?? args.recoveryCode!;
    const result = await this.mfa.verifyCode({ accountId: payload.account_id, input });
    if (result === null) {
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
      if (attempts >= MAX_MFA_CHALLENGE_ATTEMPTS) {
        await this.mfaChallenges.consume(mfaChallengeKey(args.challengeToken));
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

    // Success — atomically CLAIM the single-use token before issuing the
    // session. consume() is an atomic GETDEL, so if two requests race the
    // same valid code (or recovery code) on the same challenge token, exactly
    // ONE gets the payload back; the loser must NOT mint a second session —
    // that would violate the stated single-use contract ("success consumes
    // the token"). Sequential reuse is already caught by the peek above; this
    // closes the concurrent window (both peek before either consumes). Issue
    // the session with the user-agent recorded at /login time so the row
    // looks like the original login attempt, not the challenge POST.
    const consumed = await this.mfaChallenges.consume(mfaChallengeKey(args.challengeToken));
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

    const link = `${this.config.magicLinkUrl}?token=${plaintext}`;
    void this.email.sendSignupVerification({ to: email, link, expiresAt });

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
    const account = await this.requireAccount(row.accountId);
    if (account.status !== 'active') throw new AuthFlowError('account_suspended');

    // Magic-link consumption also implicitly verifies the email — the user
    // demonstrably owns the inbox by clicking the link.
    if (account.emailVerifiedAt === null) {
      await this.repo.markEmailVerified(account.id, now);
    }

    const session = await this.issueWebSession(account, args.issuedFromIp, args.userAgent);
    return { account, session };
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
    const link = `${this.config.passwordResetUrl}?token=${plaintext}`;
    void this.email.sendPasswordReset({ to: email, link, expiresAt });

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
    const newHash = await hashPassword(args.newPassword);
    await this.repo.setPassword(account.id, newHash);

    const session = await this.issueWebSession(account, args.issuedFromIp, args.userAgent);
    // Security: a password reset is a compromise-recovery action, so revoke
    // EVERY OTHER web session (an attacker-held session must not survive the
    // reset) while keeping the just-issued one. Reuses the V-355 helper, which
    // also invalidates the auth cache + audits the revocation. Without this a
    // stolen/lingering session stayed valid after the victim reset — defeating
    // the reset's purpose (OWASP session-management: invalidate sessions on
    // credential change).
    await this.revokeAllWebSessionsExceptCurrent(account.id, session.row.id, now);
    await this.emitAuditBestEffort(account.id, 'account.password_changed', {
      via: 'password_reset',
      issued_from_ip: args.issuedFromIp,
      user_agent: args.userAgent,
    });
    return { account, session };
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
      await this.repo.revokeWebSession(old.id, now);
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
      const session = await this.issueWebSession(account, args.issuedFromIp, args.userAgent);
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
    // keys the same counter primitive on accountId instead: once an
    // account hits MAX_MFA_CHALLENGE_ATTEMPTS attempts inside the
    // MFA_CHALLENGE_TTL_SECONDS window, every further attempt — even a
    // correct code — is refused (without even calling mfa.verifyCode)
    // until the window lapses. Without this, loginGate's per-IP-only
    // throttle (routes/auth.ts) could be bypassed by spreading guesses
    // across source IPs against this already-authenticated endpoint.
    if (this.mfaChallenges) {
      const attempts = await this.mfaChallenges.incrAttempts(
        stepUpAttemptsKey(args.accountId),
        MFA_CHALLENGE_TTL_SECONDS,
      );
      if (attempts > MAX_MFA_CHALLENGE_ATTEMPTS) {
        throw new AuthFlowError(
          'invalid_auth_token',
          'Too many incorrect codes. Wait a few minutes and try again.',
        );
      }
    }
    const result = await this.mfa.verifyCode({
      accountId: args.accountId,
      input: args.input,
    });
    if (result === null) {
      throw new AuthFlowError(
        'invalid_auth_token',
        'Code is invalid. Try again or use a recovery code.',
      );
    }
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
   * emit shape as its sibling above.
   */
  async revokeAllWebSessionsForAccount(accountId: string, now = new Date()): Promise<number> {
    const n = await this.repo.revokeAllWebSessionsForAccount(accountId, now);
    if (n > 0 && this.authCache) {
      try {
        await this.authCache.invalidateAccount(accountId);
      } catch {
        /* cache TTLs out within 30s */
      }
    }
    if (n > 0) {
      await this.emitAuditBestEffort(accountId, 'account.logout', {
        revoked_via: 'admin_account_deletion',
        revoked_count: n,
      });
    }
    return n;
  }

  // ──────────────────── helpers ────────────────────

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
  ): Promise<{ plaintext: string; row: WebSessionRow }> {
    const plaintext = generateAuthToken();
    const expiresAt = new Date(Date.now() + AUTH_TOKEN_TTL_MS.webSession);
    const row = await this.repo.insertWebSession({
      accountId: account.id,
      tokenHash: tokenHash(plaintext),
      expiresAt,
      issuedFromIp,
      userAgent,
    });
    return { plaintext, row };
  }

  /**
   * 2026-05-19 — public wrapper for OAuth-client callback after
   * linkOrCreateAccount succeeds. Looks up the account, mints the
   * same 30-day web session the password/magic-link/MFA paths mint,
   * then emits an `account.login` audit row attributing the sign-in
   * to the IDP provider. The IDP's trust attestation IS the auth
   * event here; no password/MFA gate applies.
   *
   * Founder report 2026-05-19: prior to this method, the OAuth
   * callback returned `{outcome, account_id, redirect_to}` with NO
   * session token; the dashboard then showed "Sign in to see live
   * account data" because localStorage was empty. This closes the
   * gap.
   *
   * Returns `null` if the account was deleted between
   * linkOrCreateAccount + this call (extremely rare).
   */
  async issueOAuthWebSession(args: {
    accountId: string;
    issuedFromIp: string | null;
    userAgent: string | null;
    provider: string;
  }): Promise<{ plaintext: string; row: WebSessionRow } | null> {
    const account = await this.repo.findAccountById(args.accountId);
    if (account === null) return null;
    const session = await this.issueWebSession(account, args.issuedFromIp, args.userAgent);
    await this.emitAuditBestEffort(args.accountId, 'account.login', {
      kind: 'oauth_callback',
      provider: args.provider,
      session_id: session.row.id,
    });
    return session;
  }
}
