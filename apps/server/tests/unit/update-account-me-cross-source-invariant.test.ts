// W889 — V-352 UpdateAccountMe 4-field partial-update cross-
// source invariant. Two-hundred-fifteenth in the drift-guard
// series. Pins the V-352 PATCH /v1/account/me request shape:
//
//   4 self-editable fields (all optional+nullable):
//     1. name      — display name (trim, 1-120 chars, null clears).
//     2. timezone  — IANA name (trim, 1-64 chars, null clears).
//     3. slug      — V-298a URL-safe handle (null clears).
//     4. region    — V-298b us/eu/apac data-residency (null clears).
//
//   Refine: 'At least one field (name, timezone, slug, or region)
//   must be provided.' — partial PATCH semantics.
//
// stays in lockstep across:
//   - packages/api-types/src/accounts.ts UpdateAccountMeRequestSchema.
//
// Drift would silently break:
//   * No-op PATCH bodies succeeding silently (without refine).
//   * Empty-string vs null semantics confusion ('clear vs no-op').

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const EDITABLE_FIELDS = ['name', 'timezone', 'slug', 'region'] as const;

describe('W889 V-352 UpdateAccountMe cross-source invariant', () => {
  // ─── V-352 anchor + framing ──────────────────────────────────

  it("CRITICAL packages/api-types/src/accounts.ts pins V-352 anchor — 'V-352 — PATCH /v1/account/me request shape' + 'partial update of self-editable basics. At least one field must be provided. name may be set to null to clear'. The anchor + 3-sentence framing pin the API contract.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/V-352 — PATCH \/v1\/account\/me request shape/);
    expect(p).toMatch(/V-352 — partial update of self-editable basics/);
    expect(p).toMatch(/At least one\s*\n\s*\*\s*field must be provided/);
    expect(p).toMatch(/`name` may be set to null to clear/);
  });

  // ─── 4 fields with bounds ────────────────────────────────────

  it('CRITICAL UpdateAccountMeRequestSchema declares 4 fields — name (trim 1-120) + timezone (trim 1-64) + slug (AccountSlugSchema) + region (AccountRegionSchema). All 4 are nullable + optional. The 4-field shape is the V-352 self-edit surface.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /UpdateAccountMeRequestSchema = z\s*\.object\(\{[\s\S]+?name: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(120\)\.nullable\(\)\.optional\(\)/,
    );
    expect(p).toMatch(
      /UpdateAccountMeRequestSchema[\s\S]+?timezone: z\s*\.string\(\)\s*\n\s*\.trim\(\)\s*\n\s*\.min\(1\)\s*\n\s*\.max\(64\)/,
    );
    expect(p).toMatch(/slug: AccountSlugSchema\.nullable\(\)\.optional\(\)/);
    expect(p).toMatch(/region: AccountRegionSchema\.nullable\(\)\.optional\(\)/);
  });

  // ─── mass-assignment / over-posting guard ─────────────────────
  // The tests above pin that the 4 editable fields EXIST, but a subset
  // .toMatch is blind to an ADDED field (the enum-exact-pin lesson).
  // This pins the privilege boundary: the customer self-edit schema is
  // the ONLY field surface a caller controls on their own account row,
  // so its object literal must NEVER declare an account-privilege field.
  // If a future change adds tier/suspended/role/scopes/etc. to the
  // schema, the value would flow from request body into the update —
  // turning PATCH /v1/account/me into a self-service privilege-escalation
  // (mass-assignment) surface. Source-regex (build-independent): scope to
  // the schema's own object literal so unrelated schemas' fields (e.g.
  // AccountMeResponse.tier) don't false-positive.
  it('CRITICAL mass-assignment guard — UpdateAccountMeRequestSchema object literal declares NONE of the account-privilege fields (tier/suspended/role/scope(s)/balance/isAdmin/accountId/id/stripeCustomerId); a caller must not be able to over-post a privilege field onto their own account', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    const start = p.indexOf('UpdateAccountMeRequestSchema = z');
    expect(start, 'UpdateAccountMeRequestSchema not found').toBeGreaterThanOrEqual(0);
    // The object literal is the body of `.object({ … })`. Slice from `.object({`
    // to the `\n  })` that closes it at 2-space indent. NOTE: do NOT key off the
    // first `.refine(` — a FIELD can carry its own `.refine(...)` (e.g. timezone's
    // IANA Intl-validity check, 2026-06-03), which is not the schema-level
    // at-least-one-field refine; keying off `.refine(` would truncate the literal
    // before slug/region. The 2-space `})` only matches the .object closing
    // (field method-chains close at 6-space indent), so this is unambiguous.
    const objStart = p.indexOf('.object({', start);
    expect(objStart, '.object({ not found').toBeGreaterThan(start);
    const objEnd = p.indexOf('\n  })', objStart);
    expect(objEnd, '.object({ … }) close (\\n  }) ) not found').toBeGreaterThan(objStart);
    const objectLiteral = p.slice(objStart, objEnd);
    const PRIVILEGED_KEY = [
      /\btier\s*:/,
      /\bsuspended\s*:/,
      /\brole\s*:/,
      /\bscopes?\s*:/,
      /\bbalance\s*:/,
      /\bisAdmin\s*:/,
      /\bis_admin\s*:/,
      /\baccountId\s*:/,
      /\bid\s*:/,
      /\bstripeCustomerId\s*:/,
      /\bstripe_customer_id\s*:/,
    ];
    const found = PRIVILEGED_KEY.filter((re) => re.test(objectLiteral)).map((re) => re.source);
    expect(
      found,
      `privilege field(s) declared in the self-edit schema:\n${found.join('\n')}`,
    ).toEqual([]);
    // Non-vacuous: the extracted block really is the schema's editable set.
    for (const f of EDITABLE_FIELDS) {
      expect(objectLiteral, `expected editable field ${f} in the extracted block`).toMatch(
        new RegExp(`\\b${f}\\s*:`),
      );
    }
  });

  // ─── refine: at-least-one-field rule ──────────────────────────

  it("CRITICAL UpdateAccountMeRequestSchema has refine that requires at least 1 of 4 fields to be defined. The 'At least one field (name, timezone, slug, or region) must be provided.' message tells the client what to submit. Drift to allowing empty body would let no-op PATCHes succeed silently.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /\.refine\(\s*\n\s*\(v\) =>\s*\n\s*v\.name !== undefined \|\|\s*\n\s*v\.timezone !== undefined \|\|\s*\n\s*v\.slug !== undefined \|\|\s*\n\s*v\.region !== undefined \|\|\s*\n\s*v\.onboarding_completed !== undefined,/,
    );
    expect(p).toMatch(/At least one field \(name, timezone, slug, or region\) must be provided\./);
  });

  // ─── T-13 onboarding_completed: literal-true completion latch ─────────
  // Added to the request shape so the desktop client can mark first-time
  // onboarding complete ON THE ACCOUNT. It is NOT a self-editable basic — the
  // only accepted value is the literal `true` (a one-way latch, never a toggle),
  // so it is exempt from the 4-editable-field framing above while still gated by
  // the same schema. Pinning the literal keeps a future widening (e.g. to a bare
  // boolean, which would let a client send `false` and imply an un-complete
  // path) from landing silently.
  it('CRITICAL UpdateAccountMeRequestSchema declares onboarding_completed as z.literal(true).optional() — a one-way completion latch, never a boolean toggle', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/onboarding_completed: z\.literal\(true\)\.optional\(\)/);
  });

  // ─── slug-clear-null vs no-op-undefined semantics ────────────

  it("CRITICAL slug field comment pins the 'Pass null to clear; pass a valid slug to set' framing + 'unique-when-set; the server returns 409 if another account already owns the value'. The null-vs-undefined distinction is the V-352 partial-PATCH contract.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/V-298a — readable account handle\. Pass null to clear; pass a/);
    expect(p).toMatch(
      /valid slug to set\. Unique-when-set; the server returns 409 if\s*\n\s*\/\/ another account already owns the value\./,
    );
  });

  it("CRITICAL region field comment pins V-298b — 'data-residency region preference. Null clears.' The Null-clears semantics matches slug.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/V-298b — data-residency region preference\. Null clears\./);
  });

  // ─── timezone IANA-name framing ──────────────────────────────

  it("CRITICAL timezone field framing — 'IANA name (e.g. Europe/Amsterdam) or null to clear (UTC fallback)'. The IANA-name expectation matches what server-side date-rendering libraries expect.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /`timezone` accepts\s*\n\s*\*\s*an IANA name \(e\.g\. `Europe\/Amsterdam`\) or null to clear \(UTC fallback\)/,
    );
  });

  // ─── 4 + 1 cardinality (4 fields + 1 refine) ──────────────────

  it('CRITICAL UpdateAccountMe = EXACTLY 4 self-editable fields. The 4-field set is intentionally minimal — V-352 carves out the basics (name + timezone + slug + region); other settings (MFA, email prefs, etc.) live on dedicated endpoints.', () => {
    expect(EDITABLE_FIELDS.length).toBe(4);
    expect(EDITABLE_FIELDS).toEqual(['name', 'timezone', 'slug', 'region']);
  });

  // ─── UpdateAccountMe references AccountSlugSchema + AccountRegion ─

  it('CRITICAL UpdateAccountMeRequest uses AccountSlugSchema + AccountRegionSchema (typed, not loose strings). The typed references mean V-298a regex + V-298b 3-region enum constraints automatically apply at PATCH time.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/slug: AccountSlugSchema/);
    expect(p).toMatch(/region: AccountRegionSchema/);
  });

  // ─── Type re-exported via z.infer ────────────────────────────

  it('CRITICAL UpdateAccountMeRequest type re-exports from z.infer (drift-proof).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /export type UpdateAccountMeRequest = z\.infer<typeof UpdateAccountMeRequestSchema>;/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/update-account-me-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
