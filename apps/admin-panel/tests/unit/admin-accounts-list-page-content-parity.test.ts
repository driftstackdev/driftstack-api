// W359.C — drift guard for admin-panel /accounts list page
// content. V-187 progressive-enhancement against
// /v1/admin/accounts with tier + status + email_contains filters
// and cursor pagination. Pinned:
//
//   • Tier dropdown options exactly cover AccountTierSchema
//     (any new tier on the server side must be added here too,
//     otherwise it stays unfilterable from the admin GUI).
//   • Status dropdown covers the three valid account statuses
//     (active / suspended / deleted) — same set as STATUS_BADGE.
//   • The single live STATUS_BADGE map covers every valid account
//     status; neutral SSR contains no fabricated account rows.
//   • Filter wiring: search → email_contains, status → status,
//     tier → tier query params; limit hard-coded to 50.
//   • Cursor pagination is strict, request-owned, cycle-safe, and pauses
//     polling while an older expanded window is visible.
//   • GET /v1/admin/accounts registered server-side + accepts
//     these filters.
//   • localStorage key ds_web_session_token.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountTierSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/accounts.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function extractStatusBadge(src: string): string {
  const m = /const\s+STATUS_BADGE\s*=\s*\{([\s\S]*?)\};/.exec(src);
  if (!m || !m[1]) throw new Error('STATUS_BADGE not found');
  return m[1].replace(/\s+/g, ' ').trim();
}

describe('W359.C admin-panel /accounts list page content parity', () => {
  const body = read(PAGE);
  const route = read(ROUTE);
  const tiers = new Set<string>((AccountTierSchema._def as { values: readonly string[] }).values);

  it('tier dropdown options exactly cover AccountTierSchema', () => {
    const tierOptions = Array.from(body.matchAll(/<option value="([a-z_]+)">[^<]+<\/option>/g))
      .map((m) => m[1] as string)
      .filter((v) => v.length > 0); // strip the All-* placeholders
    const dropdownTiers = tierOptions.filter((v) => tiers.has(v));
    // Every schema tier should be in the dropdown.
    for (const t of tiers) {
      expect(dropdownTiers, `tier missing from dropdown: ${t}`).toContain(t);
    }
    // And the reverse: no tier option that isn't a schema value
    // (would 400 server-side).
    const accountStatuses = new Set(['active', 'suspended', 'deleted']);
    const unknownTier = tierOptions.find((v) => !tiers.has(v) && !accountStatuses.has(v));
    expect(unknownTier, `dropdown tier not in schema: ${unknownTier}`).toBeUndefined();
  });

  it('status dropdown covers active / suspended / deleted', () => {
    for (const s of ['active', 'suspended', 'deleted']) {
      expect(body).toMatch(new RegExp(`<option value="${s}">`));
    }
  });

  it('live STATUS_BADGE covers the schema statuses and neutral SSR has no fake row', () => {
    const liveMap = extractStatusBadge(body);
    expect(liveMap).toMatch(/active:\s*'bg-emerald-50 text-emerald-700'/);
    expect(liveMap).toMatch(/suspended:\s*'bg-amber-50 text-amber-700'/);
    expect(liveMap).toMatch(/deleted:\s*'bg-tk-hover text-tk-ink-2'/);
    expect(body).toContain('Live accounts are unavailable until loaded.');
    expect(body).not.toMatch(/const\s+MOCK_ACCOUNTS\b/);
  });

  it('filter wiring: search → email_contains, status → status, tier → tier (limit=50 hard-coded)', () => {
    expect(body).toMatch(/params\.set\('limit', '50'\)/);
    expect(body).toMatch(/params\.set\('status', statusEl\.value\)/);
    expect(body).toMatch(/params\.set\('tier', tierEl\.value\)/);
    expect(body).toMatch(/params\.set\('email_contains', searchEl\.value\.trim\(\)\)/);
  });

  it('cursor pagination forwards the exact server cursor and exposes an explicit newest reset', () => {
    expect(body).toMatch(/params\.set\('limit', '50'\)/);
    expect(body).toMatch(
      /if \(requestedCursor !== null\) params\.set\('cursor', requestedCursor\)/,
    );
    expect(body).toMatch(/load\(\{ append: true \}\)/);
    expect(body).toContain('data-action="back-to-newest"');
    expect(body).toContain('Back to newest / Refresh');
  });

  it('strictly parses the entire account envelope and every real row before state mutation', () => {
    expect(body).toContain('function isAccountListRow(value)');
    expect(body).toContain('function parseAccountListPage(value)');
    expect(body).toMatch(
      /!Array\.isArray\(value\.data\) \|\| !value\.data\.every\(isAccountListRow\)/,
    );
    expect(body).toMatch(/typeof value\.has_more !== 'boolean'/);
    expect(body).toMatch(/ACCOUNT_ID_RE\.test\(value\.next_cursor\)/);
    expect(body).toMatch(/value\.has_more !== \(value\.next_cursor !== null\)/);
    expect(body).not.toContain('body.data || []');
    expect(body).not.toContain('body.next_cursor || null');
  });

  it('binds append responses to the epoch and exact cursor, deduplicates ids, and refuses cursor cycles', () => {
    expect(body).toMatch(/const epoch = append \? listEpoch : \+\+listEpoch/);
    expect(body).toMatch(/myReq !== inFlight \|\| epoch !== listEpoch/);
    expect(body).toMatch(/append && nextCursor !== requestedCursor/);
    expect(body).toContain('function mergeUniqueAccounts(existing, incoming)');
    expect(body).toMatch(
      /returnedCursor === requestedCursor \|\| requestedCursors\.has\(returnedCursor\)/,
    );
    expect(body).toContain('Existing rows and the retry cursor are unchanged.');
  });

  it('invalidates pagination synchronously on filters and pauses polling while expanded', () => {
    expect(body).toMatch(
      /function scheduleLoad\(\) \{[\s\S]*?filterTransitionPending = true;[\s\S]*?listEpoch \+= 1;[\s\S]*?syncTransitionControls\(\);[\s\S]*?setTimeout/,
    );
    expect(body).toMatch(
      /setInterval\(\(\) => \{\s*if \(expandedView\) \{\s*showExpandedPause\(\);\s*return;/,
    );
    expect(body).toContain('Live refresh paused while viewing older accounts');
  });

  it('GET /v1/admin/accounts registered server-side', () => {
    expect(body).toContain('/v1/admin/accounts?');
    expect(route).toContain("'/v1/admin/accounts'");
  });

  it('localStorage key ds_web_session_token (admin-panel convention)', () => {
    expect(body).toContain("'ds_web_session_token'");
    expect(body).toMatch(
      /try\s*\{\s*token = localStorage\.getItem\('ds_web_session_token'\);\s*\} catch\s*\{\s*token = null;/,
    );
  });

  it('row-detail drill-down hrefs use /accounts/:id (V-187 per-account detail route)', () => {
    expect(body).toMatch(/const stripped = a\.id\.replace\(\/\^acc_\/, ''\)/);
    expect(body).toMatch(/'<a href="\/accounts\/'\s*\+\s*encodeURIComponent\(stripped\)/);
    // Drill-down target resolves. This asserted `resolve(...)` was truthy, which
    // it always is — resolve() returns a string and never touches the disk, so
    // the check could not fail and the comment named an `[id].astro` this app
    // does not use. /accounts/:id is served by a Cloudflare Pages 200-rewrite to
    // a static shell (astro.config.mjs: no Worker/SSR adapter), so the rewrite
    // rule IS the drill-down target and is what has to exist.
    const redirects = readFileSync(
      resolve(REPO_ROOT, 'apps/admin-panel/public/_redirects'),
      'utf8',
    );
    expect(
      redirects,
      'no 200-rewrite for /accounts/:id — every row href in this page 404s without it',
    ).toMatch(/^\/accounts\/:id\s+\/shells\/account-detail\/?\s+200\s*$/m);
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/admin-panel/src/pages/shells/account-detail.astro')),
    ).toBe(true);
  });
});
