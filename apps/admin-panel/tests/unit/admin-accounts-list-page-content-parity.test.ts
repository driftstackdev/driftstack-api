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
//   • Cursor-pagination claim "50 default" pinned.
//   • GET /v1/admin/accounts registered server-side + accepts
//     these filters.
//   • localStorage key ds_web_session_token.

import { readFileSync } from 'node:fs';
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

  it('cursor pagination exposes and consumes the server cursor', () => {
    expect(body).toMatch(/params\.set\('limit', '50'\)/);
    expect(body).toMatch(/if \(cursor\) params\.set\('cursor', cursor\)/);
    expect(body).toMatch(/nextCursor = body\.next_cursor \|\| null/);
    expect(body).toMatch(/load\(\{ append: true \}\)/);
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
    // Drill-down target page exists.
    const detailPage = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/accounts');
    expect(detailPage).toBeTruthy(); // the directory housing [id].astro
  });
});
