// W347.C — drift guard for the admin /index overview page.
// Pins:
//
//   • GET /v1/admin/overview is registered server-side.
//   • Recent-activity list pulls /v1/admin/audit-log?limit=5.
//   • The Open-leads tile is honest about its mock-only status
//     (no leads endpoint yet) — pin the disclaimer copy so a
//     future "polish pass" can't quietly drop it.
//   • Four live tile data-fields exist: active-accounts /
//     suspended-accounts / open incidents / dlq-depth. Account
//     counts hydrate from the canonical overview response.
//   • Recent-audit list links to the full /audit-log page.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountStatusSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/index.astro');
const OVERVIEW_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-overview.ts');
const AUDIT_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-audit-log.ts');
const BILLING_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-billing.ts');
const OWNER_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-owner.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W347.C admin /index overview parity', () => {
  const page = read(PAGE);
  const overview = read(OVERVIEW_ROUTE);
  const auditLog = read(AUDIT_ROUTE);

  it('page hits GET /v1/admin/overview + server registers it', () => {
    expect(page).toMatch(/\/v1\/admin\/overview/);
    expect(overview).toContain("'/v1/admin/overview'");
  });

  it('recent-activity list hits /v1/admin/audit-log?limit=5', () => {
    // V-1117 — anchored. Without the boundary this matched `limit=50` and
    // `limit=500` too, so the page size it claims to pin was a prefix.
    expect(page).toMatch(/\/v1\/admin\/audit-log\?[^'"`]*limit=5\b/);
    expect(auditLog).toContain("'/v1/admin/audit-log'");
  });

  it('paying-subscriber card hits GET /v1/admin/billing/subscriptions/stats + server registers it', () => {
    expect(page).toMatch(/\/v1\/admin\/billing\/subscriptions\/stats/);
    expect(read(BILLING_ROUTE)).toContain("'/v1/admin/billing/subscriptions/stats'");
    expect(page).toMatch(/data-list="paying-tier-distribution"/);
    expect(page).toMatch(/data-field="paying-total"/);
  });

  it('owner-only platform-status card hits GET /v1/admin/owner/platform-status + server registers it (owner-gated)', () => {
    expect(page).toMatch(/\/v1\/admin\/owner\/platform-status/);
    expect(read(OWNER_ROUTE)).toContain("'/v1/admin/owner/platform-status'");
    // The server route is OWNER-gated (identity), not a staff scope.
    expect(read(OWNER_ROUTE)).toContain('app.requireOwner');
    // SSR-hidden card revealed only on a 200 (staff get 403 → stays hidden).
    expect(page).toMatch(/data-owner-only="platform-status"/);
    expect(page).toMatch(/class="mt-6 dashboard-card hidden"/);
  });

  it('owner-only pricing card hits GET /v1/admin/owner/pricing + the editable rows Save to the PATCH edit route (owner-gated, audited)', () => {
    expect(page).toMatch(/\/v1\/admin\/owner\/pricing/);
    expect(read(OWNER_ROUTE)).toContain("'/v1/admin/owner/pricing'");
    // SSR-hidden owner-only card + dynamic per-tier list.
    expect(page).toMatch(/data-owner-only="pricing"/);
    expect(page).toMatch(/data-list="owner-pricing"/);
    // 2026-06-05: editable — per-row input + Save → PATCH /v1/admin/owner/pricing/:tier.
    expect(page).toMatch(/data-edit-tier=/);
    expect(page).toMatch(/data-save-tier=/);
    expect(page).toMatch(/savePricing/);
    expect(page).toMatch(/'\/v1\/admin\/owner\/pricing\/'/);
    // The server registers the PATCH edit route.
    expect(read(OWNER_ROUTE)).toContain("'/v1/admin/owner/pricing/:tier'");
  });

  it('four overview tiles render (active / suspended / open incidents / DLQ depth)', () => {
    expect(page).toMatch(/data-field="active-accounts"/);
    expect(page).toMatch(/data-field="suspended-accounts"/);
    expect(page).toMatch(/data-field="dlq-depth"/);
    // 2026-06-03 — the 3rd tile is now a REAL "Open incidents" KPI
    // (data-field hook + live hydration), replacing the former mock leads tile.
    expect(page).toMatch(/Open incidents/);
    expect(page).toMatch(/data-field="incidents-open"/);
  });

  it('Open-incidents tile is real (no mock leads tile / disclaimer remains)', () => {
    // 2026-06-03 — the former mock "Open leads" tile + its
    // "mock — leads endpoint TBD" caveat were removed when the tile
    // became a real /v1/admin/incidents count. Guards against regression
    // back to a fabricated tile.
    expect(page).not.toMatch(/Open leads/);
    expect(page).not.toMatch(/mock — leads endpoint TBD/);
  });

  it('active/suspended tiles hydrate from live canonical account counts', () => {
    expect(page).toMatch(/setText\('active-accounts',\s*String\(body\.accounts\.active\)\)/);
    expect(page).toMatch(/setText\('suspended-accounts',\s*String\(body\.accounts\.suspended\)\)/);
    expect(page).not.toContain('MOCK_ACCOUNTS');
    const statuses = new Set<string>(
      (AccountStatusSchema._def as { values: readonly string[] }).values,
    );
    expect(statuses.has('active')).toBe(true);
    expect(statuses.has('suspended')).toBe(true);
  });

  it('"See full log" CTA targets /audit-log', () => {
    expect(page).toMatch(/href="\/audit-log\/"[^>]*>[\s\S]{0,80}See full log/);
  });

  it('staff-only framing is preserved in the page header', () => {
    expect(page).toMatch(/Driftstack admin · staff-only/);
  });

  it('result badge colour: emerald for success, red for non-success', () => {
    expect(page).toMatch(
      /entry\.result === 'success'\s*\?\s*'bg-emerald-50 text-emerald-700'\s*:\s*'bg-red-50 text-red-700'/,
    );
  });
});
