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
  /** Tier assigned to newly-created accounts. Default 'trial_pack'. */
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

export interface LoginResult {
  account: AuthFlowAccountRow;
  session: { plaintext: string; row: WebSessionRow };
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
    const account = await this.repo.createAccount({
      email,
      name: args.name ?? null,
      passwordHash,
      initialTier: this.config.initialTier ?? 'trial_pack',
    });

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
      issuedFromIp: args.issuedFromIp,
      userAgent: args.userAgent,
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

    const session = await this.issueWebSession(account, args.issuedFromIp, args.userAgent);
    await this.emitAuditBestEffort(account.id, 'account.login', {
      method: 'password',
      issuedFromIp: args.issuedFromIp,
      userAgent: args.userAgent,
    });
    return { account, session };
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
      issuedFromIp: args.issuedFromIp,
      userAgent: args.userAgent,
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
      sessionId: row.id,
    });
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
}
