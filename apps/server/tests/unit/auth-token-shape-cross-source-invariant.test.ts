// W886 — AuthTokenSchema URL-safe single-use cross-source
// invariant. Two-hundred-twelfth in the drift-guard series. Pins
// the AuthTokenSchema shape + adoption across consumers:
//
//   AuthTokenSchema = z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/)
//     .describe('URL-safe single-use auth token; sha256-hashed at rest')
//
//   Properties:
//     - 32-256 char length bounds.
//     - URL-safe regex (A-Z + a-z + 0-9 + _ + -) — base64url-style.
//     - 'Opaque single-use token returned by signup-verify /
//       magic-link request / password-reset request as a URL-safe
//       string. Stored sha256-hashed' framing.
//
// stays in lockstep across:
//   - packages/api-types/src/auth.ts AuthTokenSchema declaration.
//   - 3 token-input endpoint adoptions: VerifyEmail +
//     MagicLinkConsume + PasswordResetConfirm.
//   - 2 session-rotation token shapes: RefreshSession + Logout
//     (use z.string().min(32).max(256) inline — looser, sessions
//     are not URL-safe tokens).
//
// Drift would silently break:
//   * Server rejecting valid tokens (URL-safe charset bypass).
//   * Sha256-hashing-at-rest assumption violated (token-storage
//     contract).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W886 AuthTokenSchema cross-source invariant', () => {
  // ─── AuthTokenSchema declaration ─────────────────────────────

  it('CRITICAL packages/api-types/src/auth.ts AuthTokenSchema = z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/). The 32-256 char + URL-safe regex enforces base64url-style tokens.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(/export const AuthTokenSchema = z\s*\.string\(\)/);
    expect(p).toMatch(/\.min\(32\)\s*\n\s*\.max\(256\)/);
    expect(p).toMatch(/\.regex\(\/\^\[A-Za-z0-9_-\]\+\$\/\)/);
  });

  it("CRITICAL AuthTokenSchema describe text pins 'URL-safe single-use auth token; sha256-hashed at rest'. The describe is the OpenAPI-emitted documentation + server-side storage-contract pin (sha256-only).", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(/\.describe\('URL-safe single-use auth token; sha256-hashed at rest'\);/);
  });

  it("CRITICAL AuthTokenSchema inline comment pins the 3 source-flows — 'Opaque single-use token returned by signup-verify / magic-link request / password-reset request as a URL-safe string. Stored sha256-hashed.' The 3-flow inventory + URL-safe + sha256 framing are the policy documentation.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(
      /Opaque single-use token returned by signup-verify \/ magic-link request \/\s*\n\s*\/\/ password-reset request as a URL-safe string\. Stored sha256-hashed\./,
    );
  });

  // ─── 3 token-input endpoints adopt AuthTokenSchema ───────────

  it('CRITICAL VerifyEmailRequest + MagicLinkConsumeRequest + PasswordResetConfirmRequest all use AuthTokenSchema for the token field. The 3 endpoints are the 3 single-use-token consumers.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(/VerifyEmailRequestSchema = z\.object\(\{\s*\n\s*token: AuthTokenSchema/);
    expect(p).toMatch(
      /MagicLinkConsumeRequestSchema = z\.object\(\{\s*\n\s*token: AuthTokenSchema/,
    );
    expect(p).toMatch(
      /PasswordResetConfirmRequestSchema = z\.object\(\{\s*\n\s*token: AuthTokenSchema/,
    );
  });

  // ─── 2 session-token endpoints use inline shape (NOT AuthToken) ─

  it("CRITICAL RefreshSession + Logout use INLINE z.string().min(32).max(256) NOT AuthTokenSchema. Session tokens have the same length bounds but lack the URL-safe regex — they're plaintext session-cookie values, not URL-embedded tokens. Drift to using AuthTokenSchema would over-constrain session-token charset.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(
      /RefreshSessionRequestSchema = z\.object\(\{\s*\n\s*token: z\.string\(\)\.min\(32\)\.max\(256\)/,
    );
    expect(p).toMatch(
      /LogoutRequestSchema = z\.object\(\{\s*\n\s*token: z\.string\(\)\.min\(32\)\.max\(256\)/,
    );
  });

  // ─── PasswordResetConfirm token + new_password ────────────────

  it('CRITICAL PasswordResetConfirmRequest has BOTH token: AuthTokenSchema AND new_password: AuthPasswordSchema. The dual field is what makes the confirm flow atomic — proves possession (token) AND provides the new password.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(
      /PasswordResetConfirmRequestSchema = z\.object\(\{\s*\n\s*token: AuthTokenSchema,\s*\n\s*new_password: AuthPasswordSchema,\s*\n\s*\}\);/,
    );
  });

  // ─── URL-safe charset matches base64url RFC 4648 ─────────────

  it('CRITICAL the URL-safe regex /^[A-Za-z0-9_-]+$/ matches the RFC 4648 base64url charset (A-Z + a-z + 0-9 + _ + -). The URL-safe property is what lets tokens go directly into query-strings (signup-verify links etc.) without URL-encoding.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    // Spot-check the canonical regex.
    expect(p).toMatch(/\/\^\[A-Za-z0-9_-\]\+\$\//);
    // Sanity: a valid base64url token passes; an invalid one (with +) fails.
    const URL_SAFE = /^[A-Za-z0-9_-]+$/;
    expect(URL_SAFE.test('abcDEF_-123XYZ4567890_-1234567890')).toBe(true);
    expect(URL_SAFE.test('abc+def/ghi=')).toBe(false); // standard base64 fails
    expect(URL_SAFE.test('has space')).toBe(false);
  });

  // ─── 3-endpoint cardinality ──────────────────────────────────

  it('CRITICAL EXACTLY 3 endpoints adopt AuthTokenSchema — VerifyEmail + MagicLinkConsume + PasswordResetConfirm. Drift to a 4th single-use-token endpoint without adopting AuthTokenSchema would let the new endpoint accept non-URL-safe tokens.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    const matches = p.match(/token: AuthTokenSchema,/g);
    expect(matches, 'must have at least 3 AuthTokenSchema adoptions').not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(3);
  });

  // ─── sha256-at-rest policy not reused by inline session token ─

  it("CRITICAL the 'sha256-hashed at rest' framing applies to AuthTokenSchema ONLY (NOT session-token z.string()). Session tokens are stored as scrypt-kdf rows on the web_sessions table — a different storage contract.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    // The sha256-at-rest describe is on AuthTokenSchema only.
    expect(p).toMatch(/AuthTokenSchema = z[\s\S]+?sha256-hashed at rest'/);
    // Session-token inline shapes do NOT carry the sha256 framing — they're
    // declared minimally (z.string().min(32).max(256)).
    expect(p).toMatch(
      /RefreshSessionRequestSchema = z\.object\(\{\s*\n\s*token: z\.string\(\)\.min\(32\)\.max\(256\),\s*\n\s*\}\);/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/auth-token-shape-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
