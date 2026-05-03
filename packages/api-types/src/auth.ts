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
  debug_token: z.string().optional(),
});
export type MagicLinkRequestResponse = z.infer<typeof MagicLinkRequestResponseSchema>;

export const MagicLinkConsumeRequestSchema = z.object({
  token: AuthTokenSchema,
});
export type MagicLinkConsumeRequest = z.infer<typeof MagicLinkConsumeRequestSchema>;

export const MagicLinkConsumeResponseSchema = z.object({
  session: WebSessionSchema,
});
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
  debug_token: z.string().optional(),
});
export type PasswordResetRequestResponse = z.infer<typeof PasswordResetRequestResponseSchema>;

export const PasswordResetConfirmRequestSchema = z.object({
  token: AuthTokenSchema,
  new_password: AuthPasswordSchema,
});
export type PasswordResetConfirmRequest = z.infer<typeof PasswordResetConfirmRequestSchema>;

// Successful reset issues a fresh web session — same UX as verify-email.
export const PasswordResetConfirmResponseSchema = z.object({
  session: WebSessionSchema,
});
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
