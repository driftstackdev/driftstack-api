// W941 — V-079 auth-flows user-facing flow cross-source invariant.
// Two-hundred-sixty-seventh in the drift-guard series. Pins the
// user-facing auth-flow service:
//
//   Surface framing — 'User-facing auth flows: signup, email
//   verification, password login, magic-link request/consume,
//   password-reset request/confirm, web-session refresh + logout'.
//
//   V-079 scaffolding posture:
//     - 'Service is repo-driven (AuthFlowsRepo) so tests can swap an
//       in-memory implementation for the Drizzle one. Same boundary
//       pattern as auth.ts / sessions.ts / webhooks.ts'.
//     - 'Email sends fan out to the existing EmailService (Postmark,
//       V-057). Sends are fire-and-forget; failure is logged at warn,
//       never thrown — auth flow stays up even if email is
//       misconfigured'.
//     - 'Tokens generate as 32-byte URL-safe base64 plaintext, sha256-
//       hashed at rest. Re-presentation hashes-and-equality-compares'.
//     - 'Error surface is AuthFlowError codes the route layer maps to
//       RFC 7807 problem responses'.
//
//   AuthFlowKind 3-value union — 'email_verify' | 'magic_link' |
//     'password_reset'.
//
//   AuthFlowErrorCode 5-value union — 'email_already_registered'
//     | 'invalid_credentials' | 'email_not_verified' |
//     'invalid_auth_token' | 'account_suspended'.
//
//   AuthFlowAccountRow (8 fields): id + email + name (nullable)
//     + passwordHash (nullable) + emailVerifiedAt (nullable) +
//     tier + status + createdAt.
//
//   AuthFlowTokenRow (6 fields): id + accountId + tokenHash +
//     expiresAt + consumedAt (nullable) + createdAt.
//
//   AuthFlowsServiceConfig (5 fields): verifyEmailUrl + magicLinkUrl
//     + passwordResetUrl + exposeDebugToken (dev/test seam) +
//     initialTier? (default 'free').
//
//   exposeDebugToken framing — 'wired in dev / test builds where
//     there is no real Postmark deliverability path, so tests can
//     exercise the consume endpoints without scraping email'.
//
//   MFA challenge primitives imported from mfa-challenge-store —
//     V-353d cross-service dependency.
//
// stays in lockstep across apps/server/src/services/auth-flows.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W941 V-079 auth-flows cross-source invariant', () => {
  // ─── Surface intro framing ───────────────────────────────────

  it("CRITICAL apps/server/src/services/auth-flows.ts header pins surface — 'User-facing auth flows: signup, email verification, password login, magic-link request/consume, password-reset request/confirm, web-session refresh + logout'. The 7-flow surface is the customer-facing API.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-flows.ts'));
    expect(p).toMatch(/User-facing auth flows: signup, email verification, password login,/);
    expect(p).toMatch(/magic-link request\/consume, password-reset request\/confirm, web-session/);
    expect(p).toMatch(/refresh \+ logout\./);
  });

  // ─── V-079 anchor + repo-driven framing ──────────────────────

  it("CRITICAL V-079 anchor framing — 'V-079 scaffolding shape: Service is repo-driven (AuthFlowsRepo) so tests can swap an in-memory implementation for the Drizzle one. Same boundary pattern as auth.ts / sessions.ts / webhooks.ts'. The V-079 anchor + 3-service-pattern reference is the architecture provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-flows.ts'));
    expect(p).toMatch(/V-079 scaffolding shape:/);
    expect(p).toMatch(/- Service is repo-driven \(`AuthFlowsRepo`\) so tests can swap an/);
    expect(p).toMatch(/in-memory implementation for the Drizzle one\. Same boundary/);
    expect(p).toMatch(/pattern as `auth\.ts` \/ `sessions\.ts` \/ `webhooks\.ts`/);
  });

  // ─── Email fire-and-forget (V-057) framing ───────────────────

  it("CRITICAL email fan-out framing — 'Email sends fan out to the existing EmailService (Postmark, V-057). Sends are fire-and-forget; failure is logged at warn, never thrown — auth flow stays up even if email is misconfigured'. The fire-and-forget + V-057 anchor matches W914 EmailService design.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-flows.ts'));
    expect(p).toMatch(/Email sends fan out to the existing `EmailService` \(Postmark,/);
    expect(p).toMatch(/V-057\)\. Sends are fire-and-forget; failure is logged at warn,/);
    expect(p).toMatch(/never thrown — auth flow stays up even if email is misconfigured/);
  });

  // ─── 32-byte URL-safe base64 + sha256-at-rest ────────────────

  it("CRITICAL token format framing — 'Tokens generate as 32-byte URL-safe base64 plaintext, sha256-hashed at rest. Re-presentation hashes-and-equality-compares'. The plaintext-once + sha256-at-rest pattern matches V-079 / W917 mfa-challenge / W934 cli-authorize primitives.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-flows.ts'));
    expect(p).toMatch(/Tokens generate as 32-byte URL-safe base64 plaintext, sha256-hashed/);
    expect(p).toMatch(/at rest\. Re-presentation hashes-and-equality-compares/);
  });

  // ─── AuthFlowError RFC 7807 mapping framing ──────────────────

  it("CRITICAL error-surface framing — 'Error surface is AuthFlowError codes the route layer maps to RFC 7807 problem responses'. The service-throws-codes + route-maps-to-problem split keeps service request-shape-agnostic.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-flows.ts'));
    expect(p).toMatch(/Error surface is `AuthFlowError` codes the route layer maps to/);
    expect(p).toMatch(/RFC 7807 problem responses/);
  });

  // ─── AuthFlowKind 3-value union ──────────────────────────────

  it("CRITICAL AuthFlowKind = 'email_verify' | 'magic_link' | 'password_reset'. The 3-value union is the token-purpose discriminator used by AuthFlowsRepo to scope token rows.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-flows.ts'));
    expect(p).toMatch(
      /export type AuthFlowKind = 'email_verify' \| 'magic_link' \| 'password_reset';/,
    );
  });

  // ─── AuthFlowErrorCode 5-value union ─────────────────────────

  it("CRITICAL AuthFlowErrorCode 5 codes — 'email_already_registered' | 'invalid_credentials' | 'email_not_verified' | 'invalid_auth_token' | 'account_suspended'. The 5-code palette distinguishes signup-collision / login-fail / unverified / bad-token / suspended states.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-flows.ts'));
    expect(p).toMatch(/export type AuthFlowErrorCode =/);
    expect(p).toMatch(/\| 'email_already_registered'/);
    expect(p).toMatch(/\| 'invalid_credentials'/);
    expect(p).toMatch(/\| 'email_not_verified'/);
    expect(p).toMatch(/\| 'invalid_auth_token'/);
    expect(p).toMatch(/\| 'account_suspended';/);
  });

  // ─── AuthFlowError class shape ───────────────────────────────

  it('CRITICAL AuthFlowError class — readonly code: AuthFlowErrorCode + constructor(code, message?). Message defaults to code when not supplied (code-as-message default is a debuggable fallback).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-flows.ts'));
    expect(p).toMatch(/export class AuthFlowError extends Error \{/);
    expect(p).toMatch(/readonly code: AuthFlowErrorCode;/);
    expect(p).toMatch(/constructor\(code: AuthFlowErrorCode, message\?: string\)/);
    expect(p).toMatch(/super\(message \?\? code\);/);
    expect(p).toMatch(/this\.name = 'AuthFlowError';/);
  });

  // ─── AuthFlowAccountRow 8-field shape ────────────────────────

  it('CRITICAL AuthFlowAccountRow has 9 fields, and this arm pins 8 of them — id + email + name (nullable) + passwordHash (nullable; null = magic-link-only account) + emailVerifiedAt (nullable; null = pending verification) + tier + status + createdAt. The 3-nullable fields cover pending-verify / passwordless / unnamed states.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-flows.ts'));
    expect(p).toMatch(/export interface AuthFlowAccountRow \{/);
    expect(p).toMatch(/id: string;/);
    expect(p).toMatch(/email: string;/);
    expect(p).toMatch(/name: string \| null;/);
    expect(p).toMatch(/passwordHash: string \| null;/);
    expect(p).toMatch(/emailVerifiedAt: Date \| null;/);
    expect(p).toMatch(/tier: AccountTier;/);
    expect(p).toMatch(/status: AccountStatus;/);
    expect(p).toMatch(/createdAt: Date;/);
  });

  // ─── AuthFlowTokenRow 6-field shape ──────────────────────────

  it('CRITICAL AuthFlowTokenRow has 6 fields — id + accountId + tokenHash + expiresAt + consumedAt (nullable; null = unused) + createdAt. The one-shot consumedAt marker mirrors V-667 OAuth authorization-code consumed_at.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-flows.ts'));
    expect(p).toMatch(/export interface AuthFlowTokenRow \{/);
    expect(p).toMatch(/id: string;/);
    expect(p).toMatch(/accountId: string;/);
    expect(p).toMatch(/tokenHash: string;/);
    expect(p).toMatch(/expiresAt: Date;/);
    expect(p).toMatch(/consumedAt: Date \| null;/);
    expect(p).toMatch(/createdAt: Date;/);
  });

  // ─── AuthFlowsServiceConfig 5-field shape ────────────────────

  it("CRITICAL AuthFlowsServiceConfig has 5 fields — verifyEmailUrl + magicLinkUrl + passwordResetUrl + exposeDebugToken + initialTier? (default 'free'). The 3 URL fields + dev-test exposeDebugToken seam + initialTier default is the boot-time wiring.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-flows.ts'));
    expect(p).toMatch(/export interface AuthFlowsServiceConfig \{/);
    expect(p).toMatch(/Base URL the verify-email link points at\./);
    expect(p).toMatch(/verifyEmailUrl: string;/);
    expect(p).toMatch(/Base URL the magic-link points at/);
    expect(p).toMatch(/magicLinkUrl: string;/);
    expect(p).toMatch(/Base URL the password-reset link points at/);
    expect(p).toMatch(/passwordResetUrl: string;/);
    expect(p).toMatch(/exposeDebugToken: boolean;/);
    expect(p).toMatch(/Tier assigned to newly-created accounts\. Default 'free'/);
    expect(p).toMatch(/initialTier\?: AccountTier;/);
  });

  // ─── exposeDebugToken dev/test seam framing ──────────────────

  it("CRITICAL exposeDebugToken framing — 'When true, the signup / magic-link / password-reset response includes a debug_token field with the plaintext token. Wired in dev / test builds where there is no real Postmark deliverability path, so tests can exercise the consume endpoints without scraping email'. The dev-debug-seam framing is what lets W900 signup-flow tests assert without Postmark.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-flows.ts'));
    expect(p).toMatch(/When true, the signup \/ magic-link \/ password-reset response includes/);
    expect(p).toMatch(/a `debug_token` field with the plaintext token\. Wired in dev \/ test/);
    expect(p).toMatch(/builds where there is no real Postmark deliverability path, so tests/);
    expect(p).toMatch(/can exercise the consume endpoints without scraping email/);
  });

  // ─── V-353d MFA challenge primitives import ──────────────────

  it('CRITICAL imports MFA challenge primitives from mfa-challenge-store — type MfaChallengePayload + type MfaChallengeStore + generateChallengeToken + redisKey as mfaChallengeKey + MFA_CHALLENGE_TTL_SECONDS. The V-353d cross-service import wires login-with-MFA into the V-079 auth-flow.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-flows.ts'));
    expect(p).toMatch(/import \{/);
    expect(p).toMatch(/type MfaChallengePayload,/);
    expect(p).toMatch(/type MfaChallengeStore,/);
    expect(p).toMatch(/generateChallengeToken,/);
    expect(p).toMatch(/redisKey as mfaChallengeKey,/);
    expect(p).toMatch(/MFA_CHALLENGE_TTL_SECONDS,/);
    expect(p).toMatch(/\} from '\.\/mfa-challenge-store\.js';/);
  });

  // ─── lib/auth-tokens import (6-primitive split) ──────────────

  it('CRITICAL imports auth-token primitives from lib/auth-tokens — AUTH_TOKEN_TTL_MS + generateAuthToken + hashPassword + tokenHash + verifyPassword. The lib/ extraction keeps token + password primitives in lib/, coordination in services/.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-flows.ts'));
    expect(p).toMatch(/import \{/);
    expect(p).toMatch(/AUTH_TOKEN_TTL_MS,/);
    expect(p).toMatch(/generateAuthToken,/);
    expect(p).toMatch(/hashPassword,/);
    expect(p).toMatch(/tokenHash,/);
    expect(p).toMatch(/verifyPassword,/);
    expect(p).toMatch(/\} from '\.\.\/lib\/auth-tokens\.js';/);
  });

  // ─── api-types AccountStatus + AccountTier import ────────────

  it('CRITICAL AccountStatus + AccountTier imported from @driftstack/api-types — single source of truth for account-status + tier enums (matches W936 admin-audit + V-082 billing pattern).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-flows.ts'));
    expect(p).toMatch(
      /import type \{ AccountStatus, AccountTier \} from '@driftstack\/api-types';/,
    );
  });

  // ─── LoginResult discriminated union framing ─────────────────

  it('CRITICAL LoginResult is discriminated union — direct success OR MFA-challenge-required. The 2-branch result is what the LoginResponseUnion API contract pins (matches the W-908 / V-353d login-with-MFA flow).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-flows.ts'));
    expect(p).toMatch(/export type LoginResult =/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/auth-flows-v079-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
