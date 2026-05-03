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
// Rate limiting is intentionally NOT wired here at scaffolding time:
// the existing `app.rateLimit()` middleware is account-keyed and
// requires an authenticated request, which doesn't exist for these
// public flows. IP-based rate limiting (a different middleware shape
// that doesn't require `request.account`) is the right fit and lands
// as a follow-on V-NNN once the abuse surface is observable in
// staging logs.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  LoginRequestSchema,
  LogoutRequestSchema,
  MagicLinkConsumeRequestSchema,
  MagicLinkRequestSchema,
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
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDeps): void {
  const { service } = deps;

  app.post('/v1/auth/signup', {}, async (req) => {
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

  app.post('/v1/auth/verify-email', {}, async (req) => {
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

  app.post('/v1/auth/login', {}, async (req) => {
    const parsed = LoginRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());

    try {
      const result = await service.login({
        email: parsed.data.email,
        password: parsed.data.password,
        issuedFromIp: clientIp(req),
        userAgent: userAgent(req),
      });
      return sessionResponse(result);
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

  app.post('/v1/auth/password-reset/request', {}, async (req) => {
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
  });

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
