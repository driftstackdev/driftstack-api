// W874 — V-298a AccountSlug 3-32-char policy cross-source
// invariant. Two-hundredth in the drift-guard series. Pins the
// V-298a slug shape (mirrors GitHub usernames / Stripe account
// ids):
//
//   - 3-32 chars total (min(3).max(32)).
//   - Lowercase a-z + 0-9 + hyphen.
//   - No leading or trailing hyphen.
//   - No consecutive hyphens (refine).
//   - Strict normalisation: mixed case REJECTED (not silently
//     lowercased) so customers know what they typed vs stored.
//
// stays in lockstep across:
//   - packages/api-types/src/accounts.ts AccountSlugSchema
//     (Zod canonical source).
//   - apps/customer-dashboard/src/pages/settings.astro
//     (slug input + helper text describing the policy).
//
// Drift would silently break:
//   * Customer entering a slug the server rejects.
//   * Server accepting a slug the dashboard wouldn't render
//     cleanly.
//   * URL-routing assumptions if slug shape changes.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const SLUG_MIN = 3;
const SLUG_MAX = 32;
const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

describe('W874 AccountSlug policy cross-source invariant', () => {
  // ─── api-types canonical: AccountSlugSchema ──────────────────

  it('CRITICAL packages/api-types/src/accounts.ts AccountSlugSchema = z.string().min(3).max(32).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, ...). The 3-32 length bounds + regex enforce GitHub-username-style handles.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/export const AccountSlugSchema = z\s*\n?\s*\.string\(\)/);
    expect(p).toMatch(/\.min\(3\)/);
    expect(p).toMatch(/\.max\(32\)/);
    expect(p).toMatch(/\.regex\(\s*\n?\s*\/\^\[a-z0-9\]\(\?:\[a-z0-9-\]\*\[a-z0-9\]\)\?\$\//);
  });

  it("CRITICAL AccountSlugSchema regex error message is 'Must be 3-32 chars, lowercase a-z + 0-9 + hyphen, with no leading/trailing hyphen.'. The customer-facing error string is what the dashboard renders on rejection.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /'Must be 3-32 chars, lowercase a-z \+ 0-9 \+ hyphen, with no leading\/trailing hyphen\.',/,
    );
  });

  it("CRITICAL AccountSlugSchema has refine((s) => !s.includes('--')) with 'Slug cannot contain consecutive hyphens.' message. The double-hyphen ban is defense against IDN-confusable strings.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/\.refine\(\(s\) => !s\.includes\('--'\), \{/);
    expect(p).toMatch(/message: 'Slug cannot contain consecutive hyphens\.',/);
  });

  it('CRITICAL AccountSlug type re-exports from z.infer (drift-proof).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/export type AccountSlug = z\.infer<typeof AccountSlugSchema>;/);
  });

  // ─── V-298a anchor + design rationale ─────────────────────────

  it("CRITICAL V-298a anchor pinned for AccountSlugSchema. The 'URL-safe handle' framing + 'GitHub usernames, Stripe account ids' design-rationale pin the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/V-298a — slug shape: lowercase a-z \+ 0-9 \+ hyphen/);
    // The 'URL-safe handle' framing wraps across two JSDoc lines.
    expect(p).toMatch(/standard "URL-safe handle" pattern/);
    expect(p).toMatch(/GitHub usernames, Stripe/);
  });

  it("CRITICAL AccountSlug comment pins the 'reject mixed case rather than silently lowercase' strict-normalisation policy. The rationale is 'customers don't get surprised by what they typed vs what's stored'.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /Server-side normalisation is deliberately strict: we\s*\n?\s* \* reject mixed case rather than silently lowercase/,
    );
    expect(p).toMatch(
      /customers\s*\n?\s* \* don't get surprised by what they typed vs what's stored/,
    );
  });

  // ─── Customer-dashboard helper text ──────────────────────────

  it("CRITICAL apps/customer-dashboard/src/pages/settings.astro slug-input helper text pins the policy — 'Lowercase a-z, 0-9, and hyphen. 3-32 chars.' + the corrected 'unique handle ... saved and returned by the API' wording + 'Leave blank to keep using the account UUID'. The 3-sentence framing covers shape + use + opt-out.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/settings.astro'));
    expect(p).toMatch(/Lowercase a-z, 0-9, and hyphen\. 3-32 chars\./);
    // ⛔ This used to pin "stable handle on support tickets, billing references,
    // and audit entries". That sentence was never true: no audit serialization
    // references the slug, no billing or Stripe path sends it, and there is no
    // support-ticket system in this repository. The pin recorded what the text
    // SAID, not whether it was true, and kept it in place. Now pins the corrected
    // wording, and `a-timezone-claim-needs-a-timezone-implementation` pairs the
    // surface claims against the code that would have to carry them.
    expect(p).toMatch(/A unique handle for\s*\n?\s*your account, saved and returned by the API/);
    expect(p).toMatch(/Leave blank to keep using the account UUID/);
  });

  it("CRITICAL apps/customer-dashboard/src/pages/settings.astro slug input has font-mono class. The mono font signals 'identifier' visually + makes confusable characters (l/1, O/0) easier to distinguish.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/settings.astro'));
    expect(p).toMatch(/id="profile-slug"[\s\S]+?class="[^"]*font-mono[^"]*"/);
  });

  // ─── Cardinality + regex shape ───────────────────────────────

  it('CRITICAL slug length bounds = EXACTLY 3 minimum + 32 maximum. The 3-min prevents single/double-char squatting (a, b, ab); the 32-max bounds storage + URL-readability. Matches GitHub username 1-39 (Driftstack uses 3-32 — tighter min to discourage single-letter handles).', () => {
    expect(SLUG_MIN).toBe(3);
    expect(SLUG_MAX).toBe(32);
  });

  it('CRITICAL regex shape ^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$ — start with alphanumeric, optional middle of alphanumeric+hyphen, end with alphanumeric. Defense pattern: leading/trailing hyphens REJECTED.', () => {
    // Sanity: valid slugs pass.
    for (const valid of ['acme', 'acme-corp', 'a1b2c3', 'abc']) {
      expect(SLUG_REGEX.test(valid), `valid slug '${valid}' should match`).toBe(true);
    }
    // Sanity: invalid slugs fail (the regex alone — min(3) is separate).
    for (const invalid of ['-acme', 'acme-', 'ACME', 'has space', 'acme_corp']) {
      expect(SLUG_REGEX.test(invalid), `invalid slug '${invalid}' must NOT match`).toBe(false);
    }
  });

  // ─── No forbidden / legacy slug shapes ───────────────────────

  it("CRITICAL the slug-shape regex intentionally REJECTS underscores. Drift to allowing underscores would create slugs that confuse URL parsers (some treat `_` as a word boundary, some don't).", () => {
    expect(SLUG_REGEX.test('acme_corp')).toBe(false);
    expect(SLUG_REGEX.test('foo_bar')).toBe(false);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/account-slug-policy-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
