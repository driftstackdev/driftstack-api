// W880 — V-353d LoginResponseUnion discriminated cross-source
// invariant. Two-hundred-sixth in the drift-guard series. Pins
// the V-353d alternate-MFA-login response discriminated-union:
//
//   LoginResponseUnion = LoginResponse | LoginMfaRequiredResponse:
//     - LoginResponse: { session: WebSession }
//     - LoginMfaRequiredResponse: { mfa_required: literal(true) +
//       challenge_token: string + challenge_expires_at: ISO }
//
// Clients branch on `mfa_required` presence + literal true. The
// discriminator pattern lets the login endpoint return EITHER a
// session OR a challenge — never both, never neither.
//
// stays in lockstep across:
//   - packages/api-types/src/auth.ts (Zod canonical z.union).
//   - packages/sdk-typescript/src/index.ts (re-exports
//     LoginMfaRequiredResponse + LoginResponseUnion).
//   - packages/sdk-typescript/src/resources/auth.ts (login()
//     return type is LoginResponseUnion + 'mfa_required' in out
//     example).
//   - apps/customer-dashboard/src/pages/login.astro (branches on
//     body.mfa_required === true).
//
// Drift would silently break:
//   * MFA-enrolled customers stuck at login (dashboard ignores
//     mfa_required branch).
//   * SDK consumers expecting always-session response (Type
//     error on unhandled branch).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W880 LoginResponseUnion cross-source invariant', () => {
  // ─── api-types canonical: 3 schemas ──────────────────────────

  it('CRITICAL packages/api-types/src/auth.ts LoginResponseSchema = z.object({ session: WebSessionSchema }). The 1-field happy-path response.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(
      /export const LoginResponseSchema = z\.object\(\{\s*\n\s*session: WebSessionSchema,\s*\n\s*\}\);/,
    );
  });

  it('CRITICAL packages/api-types/src/auth.ts LoginMfaRequiredResponseSchema = z.object({ mfa_required: z.literal(true) + challenge_token + challenge_expires_at: Iso8601Schema }). The 3-field alternate-MFA response.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(
      /LoginMfaRequiredResponseSchema = z\.object\(\{\s*\n\s*mfa_required: z\.literal\(true\),\s*\n\s*challenge_token: z\.string\(\),\s*\n\s*challenge_expires_at: Iso8601Schema,/,
    );
  });

  it('CRITICAL LoginResponseUnionSchema = z.union([LoginResponseSchema, LoginMfaRequiredResponseSchema]) — the discriminated-union response shape for /v1/auth/login.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(
      /export const LoginResponseUnionSchema = z\.union\(\[\s*\n\s*LoginResponseSchema,\s*\n\s*LoginMfaRequiredResponseSchema,\s*\n\s*\]\);/,
    );
  });

  it('CRITICAL all 3 types re-export from z.infer (drift-proof).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(/export type LoginResponse = z\.infer<typeof LoginResponseSchema>;/);
    expect(p).toMatch(
      /export type LoginMfaRequiredResponse = z\.infer<typeof LoginMfaRequiredResponseSchema>;/,
    );
    expect(p).toMatch(
      /export type LoginResponseUnion = z\.infer<typeof LoginResponseUnionSchema>;/,
    );
  });

  // ─── V-353d anchor + discriminator framing ───────────────────

  it("CRITICAL V-353d anchor pinned for the alternate-login response. The 'must POST the challenge_token + 6-digit code (or recovery code) to /v1/auth/mfa/challenge' framing is the call-flow doc.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(/V-353d — alternate login response when the account has MFA enrolled/);
    expect(p).toMatch(
      /must POST the challenge_token \+ 6-digit code \(or\s*\n\/\/ recovery code\) to \/v1\/auth\/mfa\/challenge/,
    );
  });

  it("CRITICAL LoginResponseUnionSchema doc pins the discriminator pattern — 'Clients branch on mfa_required (presence + literal true) to decide whether to drop into the challenge UI or store the session.' The doc is what teaches SDK consumers + dashboard authors how to branch.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(/Discriminated-union response shape for \/v1\/auth\/login/);
    expect(p).toMatch(
      /Clients\s*\n\s*\*\s*branch on `mfa_required` \(presence \+ literal true\) to decide/,
    );
  });

  // ─── TS SDK consumes the union ───────────────────────────────

  it('CRITICAL packages/sdk-typescript/src/index.ts re-exports LoginMfaRequiredResponse + LoginResponseUnion. The re-exports make the union types available to TS customers without deep-import.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/index.ts'));
    expect(p).toMatch(/LoginMfaRequiredResponse,/);
    expect(p).toMatch(/LoginResponseUnion,/);
  });

  it("CRITICAL packages/sdk-typescript/src/resources/auth.ts login() returns Promise<LoginResponseUnion> + JSDoc shows the 'if (\\'mfa_required\\' in out && out.mfa_required) {' branch-on-discriminator pattern. The example teaches customers how to call login() safely.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/auth.ts'));
    expect(p).toMatch(/login\(body: LoginRequest\): Promise<LoginResponseUnion>/);
    expect(p).toMatch(/if \('mfa_required' in out && out\.mfa_required\) \{/);
  });

  // ─── Customer-dashboard login.astro branches ─────────────────

  it('CRITICAL apps/customer-dashboard/src/pages/login.astro branches on body.mfa_required === true. The dashboard handler must distinguish the MFA-challenge case from the session-mint case — drift would silently let MFA-enrolled customers be stuck at login.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/login.astro'));
    expect(p).toMatch(/if \(body && body\.mfa_required === true\)/);
  });

  it("CRITICAL apps/customer-dashboard/src/pages/login.astro inline comment pins the response-shape framing — '{ mfa_required: true, challenge_token, ... }'. The comment doubles as documentation of the schema.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/login.astro'));
    expect(p).toMatch(/`\{ mfa_required: true, challenge_token, \.\.\. \}`/);
  });

  // ─── 2-branch cardinality ────────────────────────────────────

  it('CRITICAL LoginResponseUnion = EXACTLY 2 branches (LoginResponse + LoginMfaRequiredResponse). The 2-branch model intentionally avoids per-method splits (totp-only vs recovery-only). Drift to 3+ branches would force coordinated SDK + dashboard updates.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    const m = p.match(/LoginResponseUnionSchema = z\.union\(\[([\s\S]+?)\]\)/);
    expect(m).not.toBeNull();
    const body = m![1];
    const schemas = body.split(',').filter((s) => s.trim() && /Schema$/.test(s.trim()));
    expect(schemas.length).toBe(2);
  });

  // ─── mfa_required is a LITERAL true (discriminator) ──────────

  it('CRITICAL LoginMfaRequiredResponse mfa_required uses z.literal(true) — NOT z.boolean(). The literal discriminator is what lets z.union narrow + Zod parse without ambiguity. Drift to z.boolean() would weaken the discriminator.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(/mfa_required: z\.literal\(true\)/);
    // Sanity: there's no looser declaration like 'mfa_required: z.boolean()'.
    expect(p, 'mfa_required must be z.literal(true), not z.boolean()').not.toMatch(
      /mfa_required: z\.boolean\(\)/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/login-response-union-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
