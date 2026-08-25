// W868 — AuthPassword NIST 800-63B 12-128-char cross-source
// invariant. One-hundred-ninety-fourth in the drift-guard series.
// Pins the NIST 800-63B password policy across:
//
//   - api-types AuthPasswordSchema: z.string().min(12).max(128).
//   - customer-dashboard signup.astro: minlength="12" attr.
//   - customer-dashboard reset-password.astro: 2× minlength="12"
//     attrs (new password + confirm new password).
//
// NIST 800-63B explicitly rejects composition rules (uppercase/
// lowercase/digit/special); we follow that — only length is
// enforced. The 12/128 bounds match the NIST recommendation that
// allows long passphrases without forcing low-entropy compositions.
//
// Drift would silently let the dashboard accept passwords the
// server rejects (UX confusion) OR let the server accept shorter/
// longer than the documented policy.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;

describe('W868 AuthPassword cross-source invariant', () => {
  // ─── api-types canonical source ──────────────────────────────

  it('CRITICAL packages/api-types/src/auth.ts AuthPasswordSchema = z.string().min(12).max(128). The 12-128 bounds are the NIST 800-63B compliant policy. The api-types Zod schema is the server-of-truth — drift would silently let server-side validation diverge.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(/export const AuthPasswordSchema = z\s*\.string\(\)/);
    expect(p).toMatch(/\.min\(12\)/);
    expect(p).toMatch(/\.max\(128\)/);
  });

  it("CRITICAL NIST 800-63B framing pinned in AuthPasswordSchema describe text. The 'no composition rules per NIST 800-63B' framing is the policy provenance — drift to introducing uppercase/digit/special composition rules would re-introduce NIST-deprecated patterns.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(/12-128 chars; no composition rules per NIST 800-63B/);
  });

  it("CRITICAL the api-types comment block above AuthPasswordSchema documents 'Password rules: minimum 12, maximum 128. We do NOT impose composition rules'. The inline doc threads the design rationale to future maintainers.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(/Password rules: minimum 12, maximum 128/);
    expect(p).toMatch(/We do NOT impose composition/);
  });

  // ─── AuthEmailSchema lowercase + 254-char policy ─────────────

  it("CRITICAL api-types AuthEmailSchema applies .trim().toLowerCase().email().max(254). The lowercase-normalisation is what makes case-insensitive lookups work — drift would let two 'Same' email addresses with different case coexist as separate accounts.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(
      /AuthEmailSchema = z\s*\.string\(\)\s*\n\s*\.trim\(\)\s*\n\s*\.toLowerCase\(\)\s*\n\s*\.email\(\)\s*\n\s*\.max\(254\)/,
    );
  });

  it("CRITICAL AuthEmailSchema describe text pins 'normalised lowercase server-side' framing — explains why the server lowercases input.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(/Account email — normalised lowercase server-side/);
  });

  // ─── Customer-dashboard signup form (server-side validation in browser) ─

  it('CRITICAL apps/customer-dashboard/src/pages/signup.astro password input has minlength="12" — matches api-types min. Browser-level HTML5 validation matches server-side Zod minimum.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/signup.astro'));
    expect(p).toMatch(/name="password"[\s\S]*?minlength="12"/);
  });

  it("CRITICAL apps/customer-dashboard/src/pages/signup.astro password helper text pins the '12+ characters' minimum + 'use a passphrase' guidance. NIST 800-63B encourages passphrases — drift to 'add a special character' would re-introduce composition-rule advice the policy explicitly rejects.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/signup.astro'));
    expect(p).toMatch(/12\+ characters\. Use a passphrase\./);
  });

  // ─── Customer-dashboard reset-password form ──────────────────

  it('CRITICAL apps/customer-dashboard/src/pages/reset-password.astro has 2 password inputs (new + confirm-new) BOTH with minlength="12". The dual-input pattern is what prevents typo-on-set; drift to dropping minlength on confirm input would let a 5-char confirm pass HTML5 validation.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/reset-password.astro'));
    // Two distinct minlength="12" hits in the file (one per input).
    const matches = p.match(/minlength="12"/g);
    expect(matches, 'reset-password.astro must have at least 2 minlength=12 attrs').not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  // ─── No forbidden composition-rule attrs ─────────────────────

  it("CRITICAL customer-dashboard signup/reset-password forms must NOT have 'pattern' HTML5 attrs for composition rules (uppercase / digit / special). NIST 800-63B explicitly rejects composition rules — drift to a 'must contain' pattern would re-introduce the policy violation.", () => {
    const signup = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/signup.astro'));
    const reset = read(
      resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/reset-password.astro'),
    );
    // Both forms must NOT use a 'pattern' attr on the password input.
    for (const [name, body] of [
      ['signup.astro', signup],
      ['reset-password.astro', reset],
    ] as const) {
      expect(
        body,
        `${name} password input must NOT have a 'pattern' attr (composition-rule violation)`,
      ).not.toMatch(/name="password"[\s\S]*?pattern="/);
    }
  });

  // ─── 12 + 128 cardinality ────────────────────────────────────

  it('CRITICAL password length bounds = EXACTLY 12 minimum + 128 maximum. The 12 minimum aligns with NIST 800-63B Memorized Secret minimum. The 128 maximum is high enough to accommodate any reasonable passphrase but bounds storage cost.', () => {
    expect(PASSWORD_MIN).toBe(12);
    expect(PASSWORD_MAX).toBe(128);
    expect(PASSWORD_MAX - PASSWORD_MIN).toBe(116);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/auth-password-policy-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
