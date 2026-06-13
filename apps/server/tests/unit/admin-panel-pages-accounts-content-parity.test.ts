// W488.B — drift guard for apps/admin-panel/src/pages/accounts.astro.
// V-187 admin accounts list page. Drift here either drops the
// STATUS_BADGE 3-tone vocabulary (a new account-status variant
// would render with empty styling — invisible badge) or breaks
// the 8-tier filter catalogue (a new tier becomes unfilterable
// from this page).
//
//   • V-187 framing pinned + ds_web_session_token storage key.
//   • STATUS_BADGE 3-tone (active/suspended/deleted) — pinned in
//     both the Astro frontmatter Record AND the inline-script
//     const (the inline script can't import from frontmatter).
//   • Tier filter 8-option catalogue (free / solo_manual /
//     team_manual / agency_manual / api_starter / api_builder /
//     api_scale / enterprise).
//   • email_contains server-side filter (substring match).
//   • encodeURIComponent on stripped id for /accounts/{id} href.
//   • has_more pagination indicator surfacing.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/accounts.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W488.B apps/admin-panel/src/pages/accounts.astro content parity', () => {
  const body = read(LIB);

  it("V-187 framing pinned: 'progressive-enhancement against /v1/admin/accounts. SSG renders the mock; an inline <script> reads ds_web_session_token from localStorage and replaces the table body with live rows (filtered server-side via the status / tier query params). Banners surface no-token / fetch-error / empty-result states. Filter bar inputs trigger a re-fetch on change.'", () => {
    expect(body).toMatch(
      /\/\/ V-187 — progressive-enhancement against \/v1\/admin\/accounts\. SSG\s*\n?\s*\/\/ renders the mock; an inline <script> reads ds_web_session_token\s*\n?\s*\/\/ from localStorage and replaces the table body with live rows\s*\n?\s*\/\/ \(filtered server-side via the status \/ tier query params\)\. Banners\s*\n?\s*\/\/ surface no-token \/ fetch-error \/ empty-result states\. Filter bar\s*\n?\s*\/\/ inputs trigger a re-fetch on change\./,
    );
  });

  it("STATUS_BADGE 3-tone duplicated across Astro frontmatter Record + inline-script const: active (emerald-50) / suspended (amber-50) / deleted (slate-100) — pinned so the SSG-rendered initial table + the inline-script's live-replacement use the same colour vocabulary (drift between the two would cause a flash-of-mismatched-badges when the script hydrates)", () => {
    expect(body).toMatch(
      /const STATUS_BADGE: Record<string, string> = \{\s*\n?\s*active: 'bg-emerald-50 text-emerald-700',\s*\n?\s*suspended: 'bg-amber-50 text-amber-700',\s*\n?\s*deleted: 'bg-tk-hover text-tk-ink-2',\s*\n?\s*\};/,
    );
    expect(body).toMatch(
      /const STATUS_BADGE = \{\s*\n?\s*active: 'bg-emerald-50 text-emerald-700',\s*\n?\s*suspended: 'bg-amber-50 text-amber-700',\s*\n?\s*deleted: 'bg-tk-hover text-tk-ink-2',\s*\n?\s*\};/,
    );
  });

  it('Tier filter 8-option catalogue: free / solo_manual / team_manual / agency_manual / api_starter / api_builder / api_scale / enterprise — pinned so the customer-tier vocabulary stays in sync with TierEnum in the schema (drift to 7 options would make the missing tier unfilterable from the admin panel, hiding accounts on that tier from operators)', () => {
    expect(body).toMatch(/<option value="free">Free<\/option>/);
    expect(body).toMatch(/<option value="solo_manual">Personal<\/option>/);
    expect(body).toMatch(/<option value="team_manual">Team<\/option>/);
    expect(body).toMatch(/<option value="agency_manual">Agency<\/option>/);
    expect(body).toMatch(/<option value="api_starter">API Starter<\/option>/);
    expect(body).toMatch(/<option value="api_builder">API Builder<\/option>/);
    expect(body).toMatch(/<option value="api_scale">API Scale<\/option>/);
    expect(body).toMatch(/<option value="enterprise">Enterprise<\/option>/);
  });

  it("Status filter 3-option (All / Active / Suspended / Deleted) + Email search (data-field='search' placeholder 'Search by email substring…') + server-side email_contains param — pinned so the substring email search hits the server endpoint as `email_contains` (drift to email_substring or q would silently disable the search)", () => {
    expect(body).toMatch(/<option value="">All statuses<\/option>/);
    expect(body).toMatch(/<option value="active">Active<\/option>/);
    expect(body).toMatch(/<option value="suspended">Suspended<\/option>/);
    expect(body).toMatch(/<option value="deleted">Deleted<\/option>/);
    expect(body).toMatch(
      /if \(searchEl && searchEl\.value\.trim\(\)\)\s*\n?\s*params\.set\('email_contains', searchEl\.value\.trim\(\)\);/,
    );
  });

  it("Account row /accounts/{id} link: encodeURIComponent on stripped (acc_ prefix removed via .replace(/^acc_/, '')) — pinned so the per-account-detail href doesn't break on UUIDs with reserved URL chars + the route stays consistent with the underlying admin-routes that expect the raw UUID without prefix", () => {
    expect(body).toMatch(/const stripped = a\.id\.replace\(\/\^acc_\/, ''\);/);
    expect(body).toMatch(
      /'<a href="\/accounts\/' \+\s*\n?\s*encodeURIComponent\(stripped\) \+\s*\n?\s*'" class="text-sm text-tk-accent hover:underline">Open<\/a>'/,
    );
  });

  it("has_more pagination indicator: body.has_more ? ' (more available — refine filter or paginate)' suffix on footnote — pinned so operators see when there are more accounts than the 50-page-size limit and know to refine filter or paginate (drift to dropping this hint would silently truncate result sets at 50 without warning)", () => {
    expect(body).toMatch(
      /const more = body\.has_more \? ' \(more available — refine filter or paginate\)' : '';/,
    );
    expect(body).toMatch(
      /footnote\.textContent =\s*\n?\s*'Showing ' \+\s*\n?\s*accounts\.length \+\s*\n?\s*' account' \+\s*\n?\s*\(accounts\.length === 1 \? '' : 's'\) \+\s*\n?\s*more \+\s*\n?\s*'\.';/,
    );
  });

  it("Empty-filter-result branch: 'No accounts match the current filter.' colspan=6 cell — pinned so the 6-column table's empty-after-filter state spans full width and the cell count matches the header (Account/Tier/Status/Created/Last updated/Open = 6 columns; drift to colspan=5 would visually misalign)", () => {
    expect(body).toMatch(
      /<tr><td colspan="6" class="px-4 py-8 text-center text-sm text-tk-ink-3">No accounts match the current filter\.<\/td><\/tr>/,
    );
  });

  it("Account row 'Account' column structure: name ?? email primary line + email subtitle (only when name exists) + account.id in mono small text — pinned so the per-account triple-line layout stays consistent and accounts without a name still surface their email as the primary identifier", () => {
    expect(body).toMatch(
      /<p class="font-medium text-tk-ink">\{account\.name \?\? account\.email\}<\/p>/,
    );
    expect(body).toMatch(
      /\{account\.name !== null && \(\s*\n?\s*<p class="mt-0\.5 text-xs text-tk-ink-3">\{account\.email\}<\/p>\s*\n?\s*\)\}/,
    );
    expect(body).toMatch(
      /<p class="mt-0\.5 font-mono text-\[11px\] text-tk-ink-3">\{account\.id\}<\/p>/,
    );
  });

  it("fmtIso variant: createdAt null → '—' fallback else slice(0, 10) — date-only (no time) since accounts pages show dates not seconds — pinned so a null lastSeenAt (account never logged in) doesn't crash the row + the date format stays consistent (drift to including hours would crowd the table)", () => {
    expect(body).toMatch(
      /function fmtIso\(iso: string \| null\): string \{\s*\n?\s*if \(iso === null\) return '—';\s*\n?\s*return new Date\(iso\)\.toISOString\(\)\.slice\(0, 10\);\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
