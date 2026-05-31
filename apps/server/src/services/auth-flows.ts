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
import type { EmailService } from './email.js';
import type { AuthCache } from './auth-cache.js';
import type { AccountAuditService } from './account-audit.js';
import type { MfaService } from './mfa.js';
import {
  type MfaChallengePayload,
  type MfaChallengeStore,
  generateChallengeToken,
  redisKey as mfaChallengeKey,
  MFA_CHALLENGE_TTL_SECONDS,
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
  markEmailVerified(accountId: string, at: Date): Promise<void>;

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
  /** Mark a token consumed. Idempotent — caller checks the find first. */
  consumeAuthToken(args: { kind: AuthFlowKind; id: string; at: Date }): Promise<void>;
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
  /**
   * Arc 1 sub-slice 6.2 (v2-#6) — bundled-LLM opt-in captured at
   * signup. Both default through to the migration 0050 column defaults
   * (consent=false, cap=$20). The route layer validates the cap range;
   * the service forwards verbatim to the repo's createAccount call.
   */
  bundledLlmConsent?: boolean;
  bundledLlmMonthlyCapUsdCents?: number;
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
  ) {}

  private async emitAuditBestEffort(
    accountId: string,
    action:
      | 'account.email_verified'
      | 'account.login'
      | 'account.logout'
      | 'account.password_changed',
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

  async signup(args: SignupArgs): Promise<SignupResult> {
    const email = args.email.trim().toLowerCase();
    const existing = await this.repo.findAccountByEmail(email);
    if (existing !== null) {
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
        ...(args.bundledLlmConsent !== undefined
          ? { bundledLlmConsent: args.bundledLlmConsent }
          : {}),
        ...(args.bundledLlmMonthlyCapUsdCents !== undefined
          ? { bundledLlmMonthlyCapUsdCents: args.bundledLlmMonthlyCapUsdCents }
          : {}),
      });
    } catch (err) {
      // Concurrent same-email signup race (e.g. a double-clicked submit):
      // both calls pass the findAccountByEmail pre-check above before either
      // commits, then both insert; the accounts_email_unique index lets one
      // win and raises 23505 on the loser. Translate to the same
      // email_already_registered (409) the pre-check throws — not an
      // uncaught 500. Any other error re-throws untouched.
      if (
        typeof (err as { code?: unknown }).code === 'string' &&
        (err as { code: string }).code === '23505' &&
        (err as { constraint_name?: unknown }).constraint_name === 'accounts_email_unique'
      ) {
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

    const account = await this.repo.findAccountByEmail(email);
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

    await this.repo.consumeAuthToken({ kind: 'email_verify', id: row.id, at: now });
    await this.repo.markEmailVerified(row.accountId, now);

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
    try {
      const origin = new URL(this.config.verifyEmailUrl).origin;
      void this.email.sendSignupWelcome({
        to: account.email,
        dashboardUrl: `${origin}/select-tier`,
      });
    } catch {
      /* fire-and-forget */
    }

    return { account, session };
  }

  async login(args: LoginArgs): Promise<LoginResult> {
    const account = await this.repo.findAccountByEmail(args.email.trim().toLowerCase());
    if (account === null || account.passwordHash === null) {
      throw new AuthFlowError('invalid_credentials');
    }
    if (account.status !== 'active') {
      throw new AuthFlowError('account_suspended');
    }
    const ok = await verifyPassword(args.password, account.passwordHash);
    if (!ok) throw new AuthFlowError('invalid_credentials');
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
      // Failed verify — leave the token alive so customer can retype.
      // Route layer enforces a rate limit; service stays simple.
      throw new AuthFlowError(
        'invalid_auth_token',
        'Code is invalid. Try again or use a recovery code.',
      );
    }

    // Success — consume the token, issue the session with the user-
    // agent recorded at /login time (so the resulting session row
    // looks like the original login attempt, not the challenge POST).
    await this.mfaChallenges.consume(mfaChallengeKey(args.challengeToken));

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
    const account = await this.repo.findAccountByEmail(email);

    // Always return the same shape so the response doesn't leak account
    // existence. If no account, no token is issued and no email is sent.
    const expiresAt = new Date(Date.now() + AUTH_TOKEN_TTL_MS.magicLink);
    if (account === null) {
      this.logger.info(
        { component: 'auth-flows', flow: 'magic-link', email },
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

    await this.repo.consumeAuthToken({ kind: 'magic_link', id: row.id, at: now });
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
    const account = await this.repo.findAccountByEmail(email);
    const expiresAt = new Date(Date.now() + AUTH_TOKEN_TTL_MS.passwordReset);

    if (account === null) {
      this.logger.info(
        { component: 'auth-flows', flow: 'password-reset', email },
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

    await this.repo.consumeAuthToken({ kind: 'password_reset', id: row.id, at: now });
    const account = await this.requireAccount(row.accountId);
    const newHash = await hashPassword(args.newPassword);
    await this.repo.setPassword(account.id, newHash);

    const session = await this.issueWebSession(account, args.issuedFromIp, args.userAgent);
    await this.emitAuditBestEffort(account.id, 'account.password_changed', {
      via: 'password_reset',
      issued_from_ip: args.issuedFromIp,
      user_agent: args.userAgent,
    });
    return { account, session };
  }

  async refreshSession(args: RefreshSessionArgs): Promise<RefreshSessionResult> {
    const now = new Date();
    const old = await this.repo.findActiveWebSession({
      tokenHash: tokenHash(args.token),
      now,
    });
    if (old === null) throw new AuthFlowError('invalid_auth_token');

    // Rotate: revoke the old row, issue a new one. The plaintext returned
    // is the new token; the old plaintext is now useless.
    await this.repo.revokeWebSession(old.id, now);
    const account = await this.requireAccount(old.accountId);
    const session = await this.issueWebSession(account, args.issuedFromIp, args.userAgent);
    return { account, session };
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
