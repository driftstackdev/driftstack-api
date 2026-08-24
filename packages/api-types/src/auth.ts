// User-facing auth-flow schemas (signup, verify-email, login, magic-link,
// password-reset, refresh, logout). Distinct from `api-keys.ts` which covers
// the long-lived API-key issuance flow used by SDK consumers.
//
// V-079 scaffolding: the SDK does not surface auth flows — these endpoints
// are consumed by the customer dashboard (browser) and the onboarding flow
// landing pages. Schemas live here so admin/dashboard code can import them
// type-safely without depending on the server package.

import { z } from 'zod';
import { Iso8601Schema } from './common.js';

// Email is normalised lowercase server-side. Length cap is the same 254
// max from RFC 5321 line-length limits — well above any realistic email.
export const AuthEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254)
  .describe('Account email — normalised lowercase server-side');

// Password rules: minimum 12, maximum 128. We do NOT impose composition
// rules (NIST 800-63B-3 explicitly recommends against forcing
// uppercase/digits/symbols mixes). Length is the lever that matters.
export const AuthPasswordSchema = z
  .string()
  .min(12)
  .max(128)
  .describe('Account password — 12-128 chars; no composition rules per NIST 800-63B');

// Opaque single-use token returned by signup-verify / magic-link request /
// password-reset request as a URL-safe string. Stored sha256-hashed.
export const AuthTokenSchema = z
  .string()
  .min(32)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/)
  .describe('URL-safe single-use auth token; sha256-hashed at rest');

// ───────────────────────────────────────────────────────────────────────────
// Signup
// ───────────────────────────────────────────────────────────────────────────

export const SignupRequestSchema = z.object({
  email: AuthEmailSchema,
  password: AuthPasswordSchema,
  // Optional display name. Server stores untrimmed-but-bounded.
  name: z.string().min(1).max(120).optional(),
  // 2026-06-30 security fix — `bundled_llm_consent` /
  // `bundled_llm_monthly_cap_usd_cents` USED to be settable here
  // (Arc 1 sub-slice 6.2, v2-#6). That let an unauthenticated caller
  // self-declare up to the $10,000/month bundled-LLM cap on a brand
  // new free-tier account with no payment method, no tier check, and
  // no manual review — a direct company-funded-spend exposure. Both
  // fields are intentionally ABSENT now; new accounts always get the
  // `accounts` table's column defaults (consent=false, cap=$20). The
  // ONLY way to change either is the authenticated
  // `PATCH /v1/account/me/bundled-llm-settings` route, which requires
  // `account_owner` scope.
});
export type SignupRequest = z.infer<typeof SignupRequestSchema>;

export const SignupResponseSchema = z.object({
  // ISO timestamp the email-verify token expires at. Client renders
  // this so the user knows how long they have to click the link.
  verification_email_expires_at: Iso8601Schema,
  // Absent on real responses — this is a debug field that's only ever
  // populated when the server runs with EMAIL_DELIVERY_MODE=stub. Tests
  // assert against it; production responses always have it omitted.
  debug_token: z
    .string()
    .optional()
    .describe('Stub email mode only — the plaintext verification token'),
});
export type SignupResponse = z.infer<typeof SignupResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Verify email
// ───────────────────────────────────────────────────────────────────────────

export const VerifyEmailRequestSchema = z.object({
  token: AuthTokenSchema,
});
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>;

// Successful verify also issues a web-session, so the user is logged in
// directly from the verification link click without an extra step.
export const WebSessionSchema = z.object({
  // Plaintext session token — returned ONCE here, never retrievable again.
  // Caller stores it in the auth cookie.
  token: z.string(),
  expires_at: Iso8601Schema,
  account_id: z.string(),
});
export type WebSession = z.infer<typeof WebSessionSchema>;

export const VerifyEmailResponseSchema = z.object({
  session: WebSessionSchema,
});
export type VerifyEmailResponse = z.infer<typeof VerifyEmailResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Resend verification
// ───────────────────────────────────────────────────────────────────────────

export const ResendVerificationRequestSchema = z.object({
  email: AuthEmailSchema,
});
export type ResendVerificationRequest = z.infer<typeof ResendVerificationRequestSchema>;

// Shape-stable: client never learns whether the email matched an
// unverified account. Service either mints + sends a fresh token or
// silently no-ops (already verified, no account, recent re-send).
export const ResendVerificationResponseSchema = z.object({
  sent: z.literal(true),
  expires_at: Iso8601Schema,
  debug_token: z
    .string()
    .optional()
    .describe('Stub email mode only — the plaintext verification token'),
});
export type ResendVerificationResponse = z.infer<typeof ResendVerificationResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Login
// ───────────────────────────────────────────────────────────────────────────

export const LoginRequestSchema = z.object({
  email: AuthEmailSchema,
  password: AuthPasswordSchema,
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  session: WebSessionSchema,
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

// V-353d — alternate login response when the account has MFA enrolled.
// The customer must POST the challenge_token + 6-digit code (or
// recovery code) to /v1/auth/mfa/challenge to exchange for the real
// session.
export const LoginMfaRequiredResponseSchema = z.object({
  mfa_required: z.literal(true),
  challenge_token: z.string(),
  challenge_expires_at: Iso8601Schema,
});
export type LoginMfaRequiredResponse = z.infer<typeof LoginMfaRequiredResponseSchema>;

/** Discriminated-union response shape for /v1/auth/login. Clients
 *  branch on `mfa_required` (presence + literal true) to decide
 *  whether to drop into the challenge UI or store the session. */
export const LoginResponseUnionSchema = z.union([
  LoginResponseSchema,
  LoginMfaRequiredResponseSchema,
]);
export type LoginResponseUnion = z.infer<typeof LoginResponseUnionSchema>;

// V-353d — POST /v1/auth/mfa/challenge body.
export const MfaChallengeRequestSchema = z
  .object({
    challenge_token: z.string().min(1),
    code: z
      .string()
      .regex(/^\d{6}$/, 'Must be a 6-digit code.')
      .optional(),
    recovery_code: z.string().min(1).optional(),
  })
  .refine((v) => v.code !== undefined || v.recovery_code !== undefined, {
    message: 'Either `code` or `recovery_code` must be provided.',
  });
export type MfaChallengeRequest = z.infer<typeof MfaChallengeRequestSchema>;

export const MfaChallengeResponseSchema = z.object({
  session: WebSessionSchema,
  via: z.enum(['totp', 'recovery']),
});
export type MfaChallengeResponse = z.infer<typeof MfaChallengeResponseSchema>;

// V-353e — step-up reauth on the existing session. Caller is bearer-
// authed (web session); posts 6-digit (or recovery) code; server
// refreshes `mfa_satisfied_at` so step-up-gated routes pass.
export const MfaStepUpRequestSchema = z
  .object({
    code: z
      .string()
      .regex(/^\d{6}$/, 'Must be a 6-digit code.')
      .optional(),
    recovery_code: z.string().min(1).optional(),
  })
  .refine((v) => v.code !== undefined || v.recovery_code !== undefined, {
    message: 'Either `code` or `recovery_code` must be provided.',
  });
export type MfaStepUpRequest = z.infer<typeof MfaStepUpRequestSchema>;

export const MfaStepUpResponseSchema = z.object({
  via: z.enum(['totp', 'recovery']),
  mfa_satisfied_at: Iso8601Schema,
});
export type MfaStepUpResponse = z.infer<typeof MfaStepUpResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Magic link
// ───────────────────────────────────────────────────────────────────────────

export const MagicLinkRequestSchema = z.object({
  email: AuthEmailSchema,
});
export type MagicLinkRequest = z.infer<typeof MagicLinkRequestSchema>;

export const MagicLinkRequestResponseSchema = z.object({
  // Whether a magic-link email was actually sent. Always `true` to the
  // client even when the email doesn't exist, so the response shape
  // doesn't leak account-existence; service layer either sends or
  // silently no-ops based on the lookup.
  sent: z.literal(true),
  expires_at: Iso8601Schema,
  debug_token: z
    .string()
    .optional()
    .describe('Stub email mode only — the plaintext magic-link token'),
});
export type MagicLinkRequestResponse = z.infer<typeof MagicLinkRequestResponseSchema>;

export const MagicLinkConsumeRequestSchema = z.object({
  token: AuthTokenSchema,
});
export type MagicLinkConsumeRequest = z.infer<typeof MagicLinkConsumeRequestSchema>;

// A magic link proves mailbox control. Accounts with enrolled MFA receive the
// same short-lived challenge union as password/OAuth login instead of a session.
export const MagicLinkConsumeResponseSchema = LoginResponseUnionSchema;
export type MagicLinkConsumeResponse = z.infer<typeof MagicLinkConsumeResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Password reset
// ───────────────────────────────────────────────────────────────────────────

export const PasswordResetRequestSchema = z.object({
  email: AuthEmailSchema,
});
export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;

export const PasswordResetRequestResponseSchema = z.object({
  sent: z.literal(true),
  expires_at: Iso8601Schema,
  debug_token: z
    .string()
    .optional()
    .describe('Stub email mode only — the plaintext password-reset token'),
});
export type PasswordResetRequestResponse = z.infer<typeof PasswordResetRequestResponseSchema>;

export const PasswordResetConfirmRequestSchema = z.object({
  token: AuthTokenSchema,
  new_password: AuthPasswordSchema,
});
export type PasswordResetConfirmRequest = z.infer<typeof PasswordResetConfirmRequestSchema>;

// A successful reset issues a fresh session only when MFA is not enrolled;
// enrolled accounts must exchange the returned challenge first.
export const PasswordResetConfirmResponseSchema = LoginResponseUnionSchema;
export type PasswordResetConfirmResponse = z.infer<typeof PasswordResetConfirmResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Refresh / logout
// ───────────────────────────────────────────────────────────────────────────

// Refresh rotates the session: old session row gets revoked_at, new row
// issued. The plaintext request body carries the current token; the
// response carries the new one.
export const RefreshSessionRequestSchema = z.object({
  token: z.string().min(32).max(256),
});
export type RefreshSessionRequest = z.infer<typeof RefreshSessionRequestSchema>;

export const RefreshSessionResponseSchema = z.object({
  session: WebSessionSchema,
});
export type RefreshSessionResponse = z.infer<typeof RefreshSessionResponseSchema>;

export const LogoutRequestSchema = z.object({
  token: z.string().min(32).max(256),
});
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;

export const LogoutResponseSchema = z.object({
  ok: z.literal(true),
});
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;
