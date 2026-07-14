// W488.B — drift guard for apps/admin-panel/src/pages/accounts.astro.
// V-187 admin accounts list page. Drift here either drops the
// STATUS_BADGE 3-tone vocabulary (a new account-status variant
// would render with empty styling — invisible badge) or breaks
// the 8-tier filter catalogue (a new tier becomes unfilterable
// from this page).
//
//   • V-187 framing pinned + ds_web_session_token storage key.
//   • Inert first paint: no mock account rows, links, count, or false-live state.
//   • STATUS_BADGE 3-tone (active/suspended/deleted) in the live row renderer.
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

  it('V-187 framing pins an inert unavailable SSG shell that is replaced only with live rows', () => {
    expect(body).toMatch(
      /\/\/ V-187 — progressive-enhancement against \/v1\/admin\/accounts\. SSG\s*\n?\s*\/\/ renders an inert unavailable shell; an inline <script> reads\s*\n?\s*\/\/ ds_web_session_token from localStorage and replaces it with live rows/,
    );
  });

  it('STATUS_BADGE 3-tone remains in the authoritative live-row renderer only', () => {
    expect(body).toMatch(
      /const STATUS_BADGE = \{\s*\n?\s*active: 'bg-emerald-50 text-emerald-700',\s*\n?\s*suspended: 'bg-amber-50 text-amber-700',\s*\n?\s*deleted: 'bg-tk-hover text-tk-ink-2',\s*\n?\s*\};/,
    );
    expect(body).not.toContain('const STATUS_BADGE: Record<string, string>');
  });

  it('ships no sample customer identity, account link, count, or green live claim before a successful read', () => {
    expect(body).not.toContain('MOCK_ACCOUNTS');
    expect(body).toContain('Live accounts are unavailable until loaded.');
    expect(body).toMatch(/data-live-dot\s*\n?\s*class="[^"]*bg-amber-500"/);
    expect(body).toContain('<span data-live-status>Waiting for live data</span>');
    expect(body).toMatch(/data-live-refresh\s*\n?\s*disabled\s*\n?\s*aria-disabled="true"/);
    expect(body).not.toMatch(/href=\{`\/accounts\/\$\{account\.id\}`\}/);
    expect(body).not.toMatch(/Showing \{[^}]+\} of \{[^}]+\} accounts/);
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

  it("has_more pagination: real cursor pagination via a 'Load more' button (audit waefer6wu — the old footnote-only hint advertised pagination the UI never implemented, silently truncating at 50 rows) — pinned so operators see when there are more accounts AND can actually page through them, not just a passive hint", () => {
    // 2026-06-30 — was a footnote-only " (more available — refine filter or
    // paginate)" suffix with NO actual pagination. Now wires real cursor
    // pagination off the server's existing has_more/next_cursor (no server
    // change) with a visible Load-more button. The "more accounts exist"
    // signal is preserved (footnote text), strengthened by an action.
    expect(body).toContain('Load more');
    expect(body).toMatch(
      /const more = body\.has_more\s*\n?\s*\? ' — more available \(' \+ \(nextCursor \? 'click Load more' : 'refine filter'\) \+ '\)'\s*\n?\s*: '';/,
    );
    expect(body).toMatch(/nextCursor = body\.next_cursor \|\| null;/);
  });

  it("Empty-filter-result branch: 'No accounts match the current filter.' colspan=6 cell — pinned so the 6-column table's empty-after-filter state spans full width and the cell count matches the header (Account/Tier/Status/Created/Last updated/Open = 6 columns; drift to colspan=5 would visually misalign)", () => {
    expect(body).toMatch(
      /<tr><td colspan="6" class="px-4 py-8 text-center text-sm text-tk-ink-3">No accounts match the current filter\.<\/td><\/tr>/,
    );
  });

  it('Live account row structure keeps name-or-email primary, conditional email subtitle, escaped id, and encoded detail link', () => {
    expect(body).toMatch(
      /const nameLine = a\.name \? escapeHtml\(a\.name\) : escapeHtml\(a\.email\);/,
    );
    expect(body).toMatch(
      /const subEmail = a\.name\s*\n?\s*\? '<p class="mt-0\.5 text-xs text-tk-ink-3">' \+ escapeHtml\(a\.email\) \+ '<\/p>'\s*\n?\s*: '';/,
    );
    expect(body).toContain('escapeHtml(a.id)');
  });

  it('live fmtIso uses an empty-value fallback and date-only slice so absent activity does not crash the row', () => {
    expect(body).toMatch(
      /function fmtIso\(iso\) \{\s*\n?\s*if \(!iso\) return '—';\s*\n?\s*return new Date\(iso\)\.toISOString\(\)\.slice\(0, 10\);\s*\n?\s*\}/,
    );
  });

  it('failed/signed-out reads reapply unavailable rows and success alone turns the live indicator green', () => {
    expect(body).toContain('function renderAccountsUnavailable(message)');
    expect(body).toContain(
      "renderAccountsUnavailable('Sign in with a staff admin account to see accounts.')",
    );
    expect(body).toContain(
      "renderAccountsUnavailable('Could not load accounts. Resolve the error above and retry.')",
    );
    expect(body).toMatch(/return true;\s*\n?\s*\}\)\s*\n?\s*\.catch/);
    expect(body).toMatch(/return false;\s*\n?\s*\}\)\s*\n?\s*\.finally/);
    expect(body).toMatch(
      /if \(loaded\) \{\s*\n?\s*lastFetch = Date\.now\(\);\s*\n?\s*if \(liveAge\) liveAge\.textContent = 'just now';\s*\n?\s*setLiveState\('ready'\);/,
    );
    expect(body).toMatch(/if \(expectedReq !== inFlight\) return loaded;/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
