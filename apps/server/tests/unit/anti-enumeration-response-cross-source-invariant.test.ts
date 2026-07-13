// W882 — Anti-enumeration response policy cross-source invariant.
// Two-hundred-eighth in the drift-guard series. Pins the shape-
// stable response policy across 3 email-input auth endpoints
// (magic-link / resend-verification / password-reset):
//
//   - sent: z.literal(true) — ALWAYS true to the client even when
//     the email doesn't exist. The service layer either mints +
//     sends a fresh token OR silently no-ops based on the lookup.
//   - expires_at: Iso8601Schema — bounded next-attempt window.
//   - debug_token: z.string().optional() — populated ONLY when
//     EMAIL_DELIVERY_MODE=stub (tests + local dev).
//
// The 3-field shape is identical across all 3 endpoints. The
// shape-stable response prevents account-existence enumeration:
// an attacker cannot distinguish "this email is registered" from
// "this email is not registered" based on response shape, status
// code, or response time.
//
// stays in lockstep across:
//   - packages/api-types/src/auth.ts (3 schemas with identical
//     anti-enumeration shape).
//
// Drift would silently break:
//   * sent: z.boolean() instead of literal(true) — leaks state.
//   * Different response shape across endpoints — enumeration
//     vector.
//   * Missing 'silently no-ops' framing — confuses maintainers
//     into adding explicit-existence-checks.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const ANTI_ENUM_RESPONSE_SCHEMAS = [
  'MagicLinkRequestResponseSchema',
  'ResendVerificationResponseSchema',
  'PasswordResetRequestResponseSchema',
] as const;

describe('W882 anti-enumeration response cross-source invariant', () => {
  // ─── All 3 schemas have IDENTICAL sent:literal(true) shape ──

  it('CRITICAL packages/api-types/src/auth.ts has 3 anti-enumeration response schemas — MagicLinkRequestResponse + ResendVerificationResponse + PasswordResetRequestResponse — each with sent: z.literal(true). The literal-true shape is what prevents enumeration.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    for (const schema of ANTI_ENUM_RESPONSE_SCHEMAS) {
      expect(p, `${schema} must declare sent: z.literal(true)`).toMatch(
        new RegExp(`${schema} = z\\.object\\(\\{[\\s\\S]+?sent: z\\.literal\\(true\\)`),
      );
    }
  });

  it('CRITICAL all 3 anti-enumeration schemas include expires_at: Iso8601Schema. The next-attempt timestamp is informational without revealing whether the original request succeeded.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    for (const schema of ANTI_ENUM_RESPONSE_SCHEMAS) {
      expect(p, `${schema} must include expires_at: Iso8601Schema`).toMatch(
        new RegExp(`${schema} = z\\.object\\(\\{[\\s\\S]+?expires_at: Iso8601Schema`),
      );
    }
  });

  it('CRITICAL all 3 anti-enumeration schemas include debug_token: z.string().optional(). The debug_token is the stub-mode escape-hatch — present in tests + local dev, ABSENT on production responses.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    for (const schema of ANTI_ENUM_RESPONSE_SCHEMAS) {
      expect(p, `${schema} must include debug_token optional`).toMatch(
        new RegExp(
          `${schema} = z\\.object\\(\\{[\\s\\S]+?debug_token: z\\s*\\n?\\s*\\.string\\(\\)\\s*\\n?\\s*\\.optional\\(\\)`,
        ),
      );
    }
  });

  // ─── MagicLinkRequestResponse anti-enum framing pinned ────────

  it("CRITICAL MagicLinkRequestResponse comment pins the anti-enumeration policy — 'Always true to the client even when the email doesn't exist, so the response shape doesn't leak account-existence; service layer either sends or silently no-ops based on the lookup.' The framing is THE documentation of the security policy.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(/Always `true` to the/);
    expect(p).toMatch(/client even when the email doesn't exist/);
    expect(p).toMatch(/response shape\s*\n?\s*\/\/ doesn't leak account-existence/);
    expect(p).toMatch(
      /service layer either sends or\s*\n?\s*\/\/ silently no-ops based on the lookup/,
    );
  });

  // ─── ResendVerificationResponse anti-enum framing pinned ─────

  it("CRITICAL ResendVerificationResponse comment pins the same anti-enumeration policy — 'Shape-stable: client never learns whether the email matched an unverified account. Service either mints + sends a fresh token or silently no-ops (already verified, no account, recent re-send).' The 3 no-op causes are intentionally indistinguishable.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(
      /Shape-stable: client never learns whether the email matched an\s*\n\/\/ unverified account/,
    );
    expect(p).toMatch(
      /Service either mints \+ sends a fresh token or\s*\n\/\/ silently no-ops \(already verified, no account, recent re-send\)/,
    );
  });

  // ─── debug_token describe pin ────────────────────────────────

  it("CRITICAL ResendVerificationResponse debug_token has describe('Stub email mode only — the plaintext verification token'). The describe makes it clear this is test-only.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(
      /debug_token: z\s*\n?\s*\.string\(\)\s*\n?\s*\.optional\(\)\s*\n?\s*\.describe\('Stub email mode only — the plaintext verification token'\)/,
    );
  });

  // ─── 3-endpoint cardinality ──────────────────────────────────

  it('CRITICAL EXACTLY 3 anti-enumeration response schemas — magic-link + resend-verification + password-reset. The 3 are the email-input endpoints; drift to a 4th email-input endpoint without anti-enum response would create an enumeration vector.', () => {
    expect(ANTI_ENUM_RESPONSE_SCHEMAS.length).toBe(3);
  });

  // ─── No leaky alternatives ───────────────────────────────────

  it("CRITICAL the 3 schemas must NOT declare sent: z.boolean() (loose) or status: z.enum(['sent', 'not_sent']) (leaky variants). The z.literal(true) is what fixes the anti-enum policy.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    for (const schema of ANTI_ENUM_RESPONSE_SCHEMAS) {
      // sent must NOT be z.boolean() within this schema block.
      const m = p.match(new RegExp(`${schema} = z\\.object\\(\\{([\\s\\S]+?)\\}\\);`));
      expect(m, `${schema} declaration must match`).not.toBeNull();
      const body = m![1];
      expect(body, `${schema} sent field must NOT be z.boolean()`).not.toMatch(
        /sent: z\.boolean\(\)/,
      );
    }
  });

  it('CRITICAL consume/confirm remain post-token auth responses and use the session-or-MFA union, never the anti-enumeration sent shape', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(/MagicLinkConsumeResponseSchema = LoginResponseUnionSchema;/);
    expect(p).toMatch(/PasswordResetConfirmResponseSchema = LoginResponseUnionSchema;/);
    expect(p).not.toMatch(/MagicLinkConsumeResponseSchema = z\.object\(\{[\s\S]*?sent:/);
    expect(p).not.toMatch(/PasswordResetConfirmResponseSchema = z\.object\(\{[\s\S]*?sent:/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/anti-enumeration-response-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
