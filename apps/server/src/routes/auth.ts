// User-facing auth-flow endpoints (V-079).
//
//   POST /v1/auth/signup                 — email + password
//   POST /v1/auth/verify-email           — consume signup-verify token
//   POST /v1/auth/login                  — email + password → web session
//   POST /v1/auth/magic-link/request     — request a magic-link email
//   POST /v1/auth/magic-link/consume     — consume magic-link → web session
//   POST /v1/auth/password-reset/request — request a password-reset email
//   POST /v1/auth/password-reset/confirm — confirm reset + new password
//   POST /v1/auth/refresh                — rotate web session
//   POST /v1/auth/logout                 — revoke web session
//
// All endpoints are public (no requireAuth — these ARE the gate).
//
// V-251 — IP-based rate limiting wired on signup / login / verify-email
// / password-reset-request. Per-IP token-bucket via the same
// `RateLimitStore` the account-keyed limiter uses; bucket key prefix
// per endpoint. Limits set in `middleware/ip-rate-limit.ts::AUTH_IP_LIMITS`
// per founder direction (P1-004 deferral overridden 2026-05-07).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  LoginRequestSchema,
  LogoutRequestSchema,
  MagicLinkConsumeRequestSchema,
  MagicLinkRequestSchema,
  MfaChallengeRequestSchema,
  MfaStepUpRequestSchema,
  PasswordResetConfirmRequestSchema,
  PasswordResetRequestSchema,
  RefreshSessionRequestSchema,
  SignupRequestSchema,
  VerifyEmailRequestSchema,
} from '@driftstack/api-types';
import {
  AuthFlowError,
  type AuthFlowsService,
  type WebSessionRow,
  type AuthFlowAccountRow,
} from '../services/auth-flows.js';
import {
  EmailAlreadyRegisteredError,
  EmailNotVerifiedError,
  InvalidAuthTokenError,
  InvalidCredentialsError,
  ValidationError,
  ForbiddenError,
} from '../lib/errors.js';
import { AUTH_IP_LIMITS, ipRateLimit } from '../middleware/ip-rate-limit.js';
import type { RateLimitStore } from '../services/rate-limit.js';

function clientIp(req: FastifyRequest): string | null {
  // Fastify resolves `req.ip` honouring the X-Forwarded-For chain when
  // trustProxy is set; falls through to the socket address otherwise.
  return req.ip ?? null;
}

function userAgent(req: FastifyRequest): string | null {
  const v = req.headers['user-agent'];
  if (typeof v !== 'string' || v.length === 0) return null;
  return v.slice(0, 512);
}

function sessionResponse(args: {
  account: AuthFlowAccountRow;
  session: { plaintext: string; row: WebSessionRow };
}): {
  session: {
    token: string;
    expires_at: string;
    account_id: string;
  };
} {
  return {
    session: {
      token: args.session.plaintext,
      expires_at: args.session.row.expiresAt.toISOString(),
      account_id: `acc_${args.account.id}`,
    },
  };
}

function mapAuthFlowError(err: unknown): never {
  if (!(err instanceof AuthFlowError)) throw err;
  switch (err.code) {
    case 'email_already_registered':
      throw new EmailAlreadyRegisteredError();
    case 'invalid_credentials':
      throw new InvalidCredentialsError();
    case 'invalid_auth_token':
      throw new InvalidAuthTokenError();
    case 'email_not_verified':
      throw new EmailNotVerifiedError();
    case 'account_suspended':
      throw new ForbiddenError('Account is suspended.');
  }
}

export interface AuthRoutesDeps {
  service: AuthFlowsService;
  /**
   * V-251 — rate-limit store shared with the account-keyed limiter.
   * IP-keyed buckets use distinct namespaces (`auth-ip:*`) so they
   * don't conflict with account-keyed buckets (`rl:*`).
   */
  rateLimitStore: RateLimitStore;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDeps): void {
  const { service, rateLimitStore } = deps;

  const signupGate = ipRateLimit(rateLimitStore, {
    bucketPrefix: 'auth-ip:signup',
    capacity: AUTH_IP_LIMITS.signup.capacity,
    refillPerSecond: AUTH_IP_LIMITS.signup.refillPerSecond,
  });
  const loginGate = ipRateLimit(rateLimitStore, {
    bucketPrefix: 'auth-ip:login',
    capacity: AUTH_IP_LIMITS.login.capacity,
    refillPerSecond: AUTH_IP_LIMITS.login.refillPerSecond,
  });
  const verifyEmailGate = ipRateLimit(rateLimitStore, {
    bucketPrefix: 'auth-ip:verify-email',
    capacity: AUTH_IP_LIMITS.verifyEmail.capacity,
    refillPerSecond: AUTH_IP_LIMITS.verifyEmail.refillPerSecond,
  });
  const passwordResetRequestGate = ipRateLimit(rateLimitStore, {
    bucketPrefix: 'auth-ip:password-reset-request',
    capacity: AUTH_IP_LIMITS.passwordResetRequest.capacity,
    refillPerSecond: AUTH_IP_LIMITS.passwordResetRequest.refillPerSecond,
  });

  app.post('/v1/auth/signup', { preHandler: [signupGate] }, async (req) => {
    const parsed = SignupRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());

    try {
      const result = await service.signup({
        email: parsed.data.email,
        password: parsed.data.password,
        name: parsed.data.name,
        requestedFromIp: clientIp(req),
      });
      return {
        verification_email_expires_at: result.verifyExpiresAt.toISOString(),
        ...(result.debugToken !== null ? { debug_token: result.debugToken } : {}),
      };
    } catch (e) {
      mapAuthFlowError(e);
    }
  });

  app.post('/v1/auth/verify-email', { preHandler: [verifyEmailGate] }, async (req) => {
    const parsed = VerifyEmailRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());

    try {
      const result = await service.verifyEmail({
        token: parsed.data.token,
        issuedFromIp: clientIp(req),
        userAgent: userAgent(req),
      });
      return sessionResponse(result);
    } catch (e) {
      mapAuthFlowError(e);
    }
  });

  app.post('/v1/auth/login', { preHandler: [loginGate] }, async (req) => {
    const parsed = LoginRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());

    try {
      const result = await service.login({
        email: parsed.data.email,
        password: parsed.data.password,
        issuedFromIp: clientIp(req),
        userAgent: userAgent(req),
      });
      // V-353d — discriminated-union response. MFA-enrolled accounts
      // get a challenge token instead of a session; client posts the
      // token + 6-digit (or recovery) to /v1/auth/mfa/challenge.
      if (result.kind === 'mfa_required') {
        return {
          mfa_required: true as const,
          challenge_token: result.challengeToken,
          challenge_expires_at: result.challengeExpiresAt.toISOString(),
        };
      }
      return sessionResponse(result);
    } catch (e) {
      mapAuthFlowError(e);
    }
  });

  // V-353d — exchange the challenge_token + 6-digit (or recovery) for
  // a real session. Rate-limited via the same loginGate (per-IP).
  app.post('/v1/auth/mfa/challenge', { preHandler: [loginGate] }, async (req) => {
    const parsed = MfaChallengeRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());

    try {
      const result = await service.completeMfaChallenge({
        challengeToken: parsed.data.challenge_token,
        code: parsed.data.code,
        recoveryCode: parsed.data.recovery_code,
        sourceIp: clientIp(req),
        userAgent: userAgent(req),
      });
      return {
        session: {
          token: result.session.plaintext,
          expires_at: result.session.row.expiresAt.toISOString(),
          account_id: `acc_${result.account.id}`,
        },
        via: result.via,
      };
    } catch (e) {
      mapAuthFlowError(e);
    }
  });

  // V-353e — step-up reauth on the EXISTING web session. Caller is
  // bearer-authed; we verify the 6-digit (or recovery) code and stamp
  // `mfa_satisfied_at` on their session. Step-up-gated routes
  // (DELETE /v1/account/mfa, future DELETE /v1/account) pass for the
  // next 15 min.
  //
  // 401 if the caller isn't authed; 401 if not a web session
  // (API-key callers can't step-up since there's no session row to
  // refresh). Rate-limited via loginGate to slow brute force.
  app.post('/v1/auth/mfa/step-up', { preHandler: [app.requireAuth, loginGate] }, async (req) => {
    const ctx = req.account;
    if (!ctx) throw new Error('account context missing after requireAuth');
    if (ctx.webSession === null) {
      throw new ForbiddenError('MFA step-up is only callable from a web session.');
    }
    const parsed = MfaStepUpRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());

    try {
      const result = await service.stepUpReauth({
        accountId: ctx.account.id,
        sessionId: ctx.webSession.id,
        input: parsed.data.code ?? parsed.data.recovery_code!,
      });
      return {
        via: result.via,
        mfa_satisfied_at: result.mfaSatisfiedAt.toISOString(),
      };
    } catch (e) {
      mapAuthFlowError(e);
    }
  });

  app.post('/v1/auth/magic-link/request', {}, async (req) => {
    const parsed = MagicLinkRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());

    const result = await service.requestMagicLink({
      email: parsed.data.email,
      requestedFromIp: clientIp(req),
    });
    // Always shape-stable: client never learns whether the email
    // matched an account from this response.
    return {
      sent: true as const,
      expires_at: result.expiresAt.toISOString(),
      ...(result.debugToken !== null ? { debug_token: result.debugToken } : {}),
    };
  });

  app.post('/v1/auth/magic-link/consume', {}, async (req) => {
    const parsed = MagicLinkConsumeRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());

    try {
      const result = await service.consumeMagicLink({
        token: parsed.data.token,
        issuedFromIp: clientIp(req),
        userAgent: userAgent(req),
      });
      return sessionResponse(result);
    } catch (e) {
      mapAuthFlowError(e);
    }
  });

  app.post(
    '/v1/auth/password-reset/request',
    { preHandler: [passwordResetRequestGate] },
    async (req) => {
      const parsed = PasswordResetRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());

      const result = await service.requestPasswordReset({
        email: parsed.data.email,
        requestedFromIp: clientIp(req),
      });
      return {
        sent: true as const,
        expires_at: result.expiresAt.toISOString(),
        ...(result.debugToken !== null ? { debug_token: result.debugToken } : {}),
      };
    },
  );

  app.post('/v1/auth/password-reset/confirm', {}, async (req) => {
    const parsed = PasswordResetConfirmRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());

    try {
      const result = await service.confirmPasswordReset({
        token: parsed.data.token,
        newPassword: parsed.data.new_password,
        issuedFromIp: clientIp(req),
        userAgent: userAgent(req),
      });
      return sessionResponse(result);
    } catch (e) {
      mapAuthFlowError(e);
    }
  });

  app.post('/v1/auth/refresh', {}, async (req) => {
    const parsed = RefreshSessionRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());

    try {
      const result = await service.refreshSession({
        token: parsed.data.token,
        issuedFromIp: clientIp(req),
        userAgent: userAgent(req),
      });
      return sessionResponse(result);
    } catch (e) {
      mapAuthFlowError(e);
    }
  });

  app.post('/v1/auth/logout', {}, async (req) => {
    const parsed = LogoutRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());

    await service.logout(parsed.data.token);
    return { ok: true as const };
  });
}
