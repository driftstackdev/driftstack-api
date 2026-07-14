// W951 — auth service V-168 + V-326 + V-352 + V-353e cross-source
// invariant. Two-hundred-seventy-seventh in the drift-guard series.
// Pins the central Bearer-auth service:
//
//   Service intro — 'Authenticate a Bearer API key against the
//   account/api_keys store. The service is decoupled from Drizzle
//   via an AccountAuthRepo interface so unit tests can use an
//   in-memory fake. The real implementation lives in
//   apps/server/src/db/auth-repo.ts'.
//
//   CACHE_TTL_SEC = 30 (matches D-020 auth-cache TTL — 'within 30s
//   worst case' for revocation propagation).
//
//   AccountRow V-NNN feature fields:
//     - V-352 timezone (IANA name; null = UTC fallback).
//     - V-352b avatarR2Key (R2 key; null = no avatar uploaded).
//     - V-298a slug (lowercase a-z+0-9+hyphen, 3-32 chars; null =
//       unset).
//     - V-298b region ('us' | 'eu' | 'apac' | null).
//
//   AccountAuthRepo (6+ methods): findApiKeyByPrefix + getAccount
//     + touchApiKeyLastUsed + findActiveRateLimitOverrides +
//     V-168 findActiveWebSession + V-168 touchWebSessionLastUsed
//     + V-326 findTeamMemberships + V-352 updateAccountBasics.
//
//   V-168 web-session framing — 'look up an active web session by
//   sha256(token). Returns null if not found, expired, or revoked.
//   The auth-flows repo (DrizzleAuthFlowsRepo.findActiveWebSession)
//   is the upstream implementation; this method on AccountAuthRepo
//   is the auth-surface adapter'.
//
//   V-326 findTeamMemberships framing — 'load team memberships
//   where this account is a MEMBER (not the owner). Each row
//   exposes the owner's account id + the member's role. Returns an
//   empty array when the account is on no teams'.
//
//   V-352 updateAccountBasics — 'patch self-editable basics
//   (name, timezone). Email + tier + status + stripeCustomerId are
//   NOT editable here'.
//
//   AccountContext (5 fields):
//     - account + apiKey + rateLimitOverrides (Record) + teams
//       (V-326; always present, never undefined) + webSession
//       (V-353e; null for API-key callers).
//
//   V-353e webSession framing — 'populated when the request
//   authenticated via a web session (dashboard / GUI bearer); null
//   for API-key callers. The step-up gate (requireMfaFresh) reads
//   mfaSatisfiedAt against the 15-min freshness window. API-key
//   callers bypass the gate (they're machine-to-machine; MFA is a
//   human-factor concept)'.
//
//   TeamMembership 3-field shape: membershipId + ownerAccountId
//     + role ('member' | 'admin').
//
//   RateLimitOverride 4-field shape: bucketKey + capacity +
//     refillPerSecond + expiresAt.
//
//   BEARER_RE = /^Bearer\\s+(\\S+)\\s*$/i (matches W908 auth-context
//     BEARER_RE invariant).
//
// stays in lockstep across apps/server/src/services/auth.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W951 auth service V-168 + V-326 + V-352 + V-353e cross-source invariant', () => {
  // ─── Service intro + Drizzle-decoupling ──────────────────────

  it("CRITICAL apps/server/src/services/auth.ts header pins surface — 'Authenticate a Bearer API key against the account/api_keys store. The service is decoupled from Drizzle via an AccountAuthRepo interface so unit tests can use an in-memory fake. The real implementation lives in apps/server/src/db/auth-repo.ts'. The repo-decoupling testability contract is the central design.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/Authenticate a Bearer API key against the account\/api_keys store\./);
    expect(p).toMatch(/The service is decoupled from Drizzle via an `AccountAuthRepo` interface/);
    expect(p).toMatch(/so unit tests can use an in-memory fake\. The real implementation lives in/);
    expect(p).toMatch(/`apps\/server\/src\/db\/auth-repo\.ts`/);
  });

  // ─── CACHE_TTL_SEC = 30 ──────────────────────────────────────

  it("CRITICAL CACHE_TTL_SEC = 30 — matches D-020 auth-cache TTL ('within 30s worst case' for revocation propagation; matches W924 D-020 30s framing).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/const CACHE_TTL_SEC = 30;/);
  });

  // ─── AccountRow V-352 timezone framing ───────────────────────

  it('CRITICAL AccountRow.timezone V-352 framing — \'V-352 — IANA timezone name (e.g. "Europe/Amsterdam"). null = UTC fallback\'. The IANA-name + null-is-UTC contract is the V-352 timezone policy.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(
      /V-352 — IANA timezone name \(e\.g\. "Europe\/Amsterdam"\)\. null = UTC fallback\./,
    );
    expect(p).toMatch(/timezone: string \| null;/);
  });

  // ─── AccountRow V-352b avatar framing ────────────────────────

  it("CRITICAL AccountRow.avatarR2Key V-352b framing — 'V-352b — R2 object key for the customer's uploaded avatar. null = no avatar uploaded. The route layer turns this into a presigned GET URL on /v1/account/me reads'. The R2-key-not-URL + route-presigns contract is the V-352b avatar policy.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/V-352b — R2 object key for the customer's uploaded avatar\./);
    expect(p).toMatch(/null = no avatar uploaded\. The route layer turns this into a/);
    expect(p).toMatch(/presigned GET URL on \/v1\/account\/me reads\./);
    expect(p).toMatch(/avatarR2Key: string \| null;/);
  });

  // ─── AccountRow V-298a slug framing ──────────────────────────

  it("CRITICAL AccountRow.slug V-298a framing — 'V-298a — readable account handle (lowercase a-z + 0-9 + hyphen, 3-32 chars, unique-when-set across all accounts). null = unset. Customer can set via PATCH /v1/account/me. URL routing using the slug is a future slice — for now it's a stable identifier for support / billing / audit references'. The 3-32-char + unique-when-set + future-URL-routing framing is the V-298a slug policy.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/V-298a — readable account handle \(lowercase a-z \+ 0-9 \+ hyphen,/);
    expect(p).toMatch(/3-32 chars, unique-when-set across all accounts\)\. null = unset\./);
    expect(p).toMatch(/Customer can set via PATCH \/v1\/account\/me\. URL routing using/);
    expect(p).toMatch(/the slug is a future slice — for now it's a stable identifier/);
    expect(p).toMatch(/for support \/ billing \/ audit references/);
    expect(p).toMatch(/slug: string \| null;/);
  });

  // ─── AccountRow V-298b region framing ────────────────────────

  it("CRITICAL AccountRow.region V-298b framing — 'V-298b — Stripe-style data-residency region preference: us, eu, or apac. null = unset (default infra routing). Customer sets via PATCH /v1/account/me. Currently informational'. The 3-region enum + informational-only contract is the V-298b region policy.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/V-298b — Stripe-style data-residency region preference: 'us',/);
    expect(p).toMatch(/'eu', or 'apac'\. null = unset \(default infra routing\)\. Customer/);
    expect(p).toMatch(/sets via PATCH \/v1\/account\/me\. Currently informational/);
    expect(p).toMatch(/region: 'us' \| 'eu' \| 'apac' \| null;/);
  });

  // ─── AccountAuthRepo V-168 web session ───────────────────────

  it("CRITICAL V-168 findActiveWebSession JSDoc — 'V-168 — look up an active web session by sha256(token). Returns null if not found, expired, or revoked. The auth-flows repo (DrizzleAuthFlowsRepo.findActiveWebSession) is the upstream implementation; this method on AccountAuthRepo is the auth-surface adapter'. The sha256-keyed + 3-null-causes + auth-surface-adapter framing is the V-168 contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/V-168 — look up an active web session by sha256\(token\)\. Returns/);
    expect(p).toMatch(/null if not found, expired, or revoked\. The auth-flows repo/);
    expect(p).toMatch(/\(`DrizzleAuthFlowsRepo\.findActiveWebSession`\) is the upstream/);
    expect(p).toMatch(/implementation; this method on AccountAuthRepo is the auth-surface/);
    expect(p).toMatch(/adapter\./);
    expect(p).toMatch(
      /findActiveWebSession\(args: \{ tokenHash: string; now: Date \}\): Promise<WebSessionAuthRow \| null>;/,
    );
  });

  // ─── V-326 findTeamMemberships framing ───────────────────────

  it("CRITICAL V-326 findTeamMemberships JSDoc — 'V-326 — load team memberships where this account is a MEMBER (not the owner). Each row exposes the owner's account id + the member's role. Returns an empty array when the account is on no teams. Cached inside AccountContext.teams across the auth-cache TTL; cache-invalidated on membership changes via the team-members service's accept / removeMember paths'. The MEMBER-not-OWNER + empty-array-default + cache-invalidate-on-membership-change framing is the V-326 contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/V-326 — load team memberships where this account is a MEMBER/);
    expect(p).toMatch(/\(not the owner\)\. Each row exposes the owner's account id \+ the/);
    expect(p).toMatch(/member's role\. Returns an empty array when the account is on no/);
    expect(p).toMatch(/teams\. Cached inside AccountContext\.teams across the auth-cache/);
    expect(p).toMatch(/TTL; cache-invalidated on membership changes via the team-members/);
    expect(p).toMatch(/service's accept \/ removeMember paths\./);
  });

  // ─── V-352 updateAccountBasics framing ───────────────────────

  it("CRITICAL V-352 updateAccountBasics JSDoc — 'V-352 — patch self-editable basics on the account (name, timezone). Returns the updated row. Used by PATCH /v1/account/me. Email + tier + status + stripeCustomerId are NOT editable here — those go through dedicated flows (auth-flows for email; Stripe webhooks for tier; admin force-actions for status)'. The 2-field-editable + 4-field-NOT-editable carve-out is the V-352 patch contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/V-352 — patch self-editable basics on the account \(name,/);
    expect(p).toMatch(/timezone\)\. Returns the updated row\. Used by PATCH \/v1\/account\/me\./);
    expect(p).toMatch(/Email \+ tier \+ status \+ stripeCustomerId are NOT editable here —/);
    expect(p).toMatch(/those go through dedicated flows \(auth-flows for email; Stripe/);
    expect(p).toMatch(/webhooks for tier; admin force-actions for status\)\./);
  });

  // ─── AccountContext 5-field shape ────────────────────────────

  it('CRITICAL AccountContext has 5 fields — account + apiKey + rateLimitOverrides (Record) + teams (V-326 always-present array) + webSession (V-353e nullable). The 5-field context is what every authenticated handler receives.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/export interface AccountContext \{/);
    expect(p).toMatch(/account: AccountRow;/);
    expect(p).toMatch(/apiKey: ApiKeyRow;/);
    expect(p).toMatch(/rateLimitOverrides: Record<string, RateLimitOverride>;/);
    expect(p).toMatch(/teams: TeamMembership\[\];/);
    expect(p).toMatch(/webSession: \{ id: string; mfaSatisfiedAt: Date \| null \} \| null;/);
  });

  // ─── V-353e webSession framing ───────────────────────────────

  it("CRITICAL V-353e webSession framing — 'V-353e — populated when the request authenticated via a web session (dashboard / GUI bearer); null for API-key callers. The step-up gate (requireMfaFresh) reads mfaSatisfiedAt against the 15-min freshness window. API-key callers bypass the gate (they're machine-to-machine; MFA is a human-factor concept)'. The web-vs-API + machine-bypasses-MFA framing is the V-353e step-up policy.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/V-353e — populated when the request authenticated via a web/);
    expect(p).toMatch(/session \(dashboard \/ GUI bearer\); null for API-key callers\. The/);
    expect(p).toMatch(/step-up gate \(`requireMfaFresh`\) reads `mfaSatisfiedAt` against/);
    expect(p).toMatch(/the 15-min freshness window\. API-key callers bypass the gate/);
    expect(p).toMatch(/\(they're machine-to-machine; MFA is a human-factor concept\)\./);
  });

  // ─── V-326 teams always-present-array framing ────────────────

  it("CRITICAL teams always-present-array framing — 'V-326 — owner accounts this account is a member of, with role. Empty array for accounts that aren't on any team. Always present (never undefined) so call sites can iterate without a null check'. The always-present contract makes ctx.teams.map() safe.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/V-326 — owner accounts this account is a member of, with role\./);
    expect(p).toMatch(/Empty array for accounts that aren't on any team\. Always present/);
    expect(p).toMatch(/\(never undefined\) so call sites can iterate without a null check\./);
  });

  // ─── TeamMembership 3-field shape ────────────────────────────

  it("CRITICAL TeamMembership has 3 fields — membershipId + ownerAccountId + role ('member' | 'admin'). The 3-field shape matches W924 auth-cache SerializedTeamMembership + W929 email-preferences V-330d effectiveAccountId resolver contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/export interface TeamMembership \{/);
    expect(p).toMatch(/membershipId: string;/);
    expect(p).toMatch(/ownerAccountId: string;/);
    expect(p).toMatch(/role: 'member' \| 'admin';/);
  });

  // ─── RateLimitOverride 4-field shape ─────────────────────────

  it('CRITICAL RateLimitOverride has 4 fields — bucketKey + capacity + refillPerSecond + expiresAt. The 4-field shape matches W931 rate-limit-overrides RateLimitOverrideRecord runtime view (minus audit-trail fields).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/export interface RateLimitOverride \{/);
    expect(p).toMatch(/bucketKey: string;/);
    expect(p).toMatch(/capacity: number;/);
    expect(p).toMatch(/refillPerSecond: number;/);
    expect(p).toMatch(/expiresAt: Date;/);
  });

  // ─── BEARER_RE matches W908 ──────────────────────────────────

  it('CRITICAL BEARER_RE = /^Bearer\\s+(\\S+)\\s*$/i — case-insensitive Bearer prefix + token capture. Matches W908 auth-context BEARER_RE invariant.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/const BEARER_RE = \/\^Bearer\\s\+\(\\S\+\)\\s\*\$\/i;/);
  });

  // ─── 5-error class import ────────────────────────────────────

  it('CRITICAL imports 5 error classes — ExpiredKeyError + ForbiddenError + InvalidKeyError + RevokedKeyError + UnauthorizedError. The 5-error palette covers expired + forbidden + invalid + revoked + unauth states.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/import \{/);
    expect(p).toMatch(/ExpiredKeyError,/);
    expect(p).toMatch(/ForbiddenError,/);
    expect(p).toMatch(/InvalidKeyError,/);
    expect(p).toMatch(/RevokedKeyError,/);
    expect(p).toMatch(/UnauthorizedError,/);
    expect(p).toMatch(/\} from '\.\.\/lib\/errors\.js';/);
  });

  // ─── lib/api-keys imports ────────────────────────────────────

  it('CRITICAL imports keyPrefixFromPlaintext + verifyApiKey from lib/api-keys — the 2-primitive split that bridges the auth slow-path to the V-079 scrypt-kdf hash verification.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(
      /import \{ keyPrefixFromPlaintext, verifyApiKey \} from '\.\.\/lib\/api-keys\.js';/,
    );
  });

  // ─── auth-cache + auth-coalescer imports ─────────────────────

  it('CRITICAL imports type AuthCache + sha256Hex from auth-cache + type AuthCoalescer from auth-coalescer — wires D-020 cache + V-012/V-015 single-flight into the central auth path.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/import type \{ AuthCache, AuthCacheVersions \} from '\.\/auth-cache\.js';/);
    expect(p).toMatch(/import \{ sha256Hex \} from '\.\/auth-cache\.js';/);
    expect(p).toMatch(/import type \{ AuthCoalescer \} from '\.\/auth-coalescer\.js';/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/auth-service-v168-v326-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
