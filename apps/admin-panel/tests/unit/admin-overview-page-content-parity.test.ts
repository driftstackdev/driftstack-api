// W358.C — drift guard for admin-panel /index (Overview) page
// content. V-190 progressive-enhancement against the admin overview
// + audit-log endpoints. Pinned:
//
//   • GET /v1/admin/overview + GET /v1/admin/audit-log?limit=5
//     both registered server-side.
//   • Tile data-fields (active-accounts / suspended-accounts /
//     dlq-depth) map to overview-response keys
//     (accounts.active / accounts.suspended / webhooks.dlq_depth).
//   • Open-leads tile is intentionally on mock (leads endpoint
//     deferred) — pinned so a future fake "live" wire-up doesn't
//     ship before the endpoint lands.
//   • "All actions on this panel are audit-logged" promise stays
//     pinned (D-025 audit-before-response contract) — this is the
//     staff-facing transparency commitment.
//   • 403 → "admin scope required" handling pinned (no silent
//     redirect; the message names the cause).
//   • localStorage key ds_web_session_token (admin-panel reads
//     from the same key as customer-dashboard; mismatch silently
//     locks staff out).
//   • Cross-link to /audit-log resolves.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/index.astro');
const OVERVIEW_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-overview.ts');
const AUDIT_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-audit-log.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W358.C admin-panel /index overview page content parity', () => {
  const body = read(PAGE);

  it('GET /v1/admin/overview + GET /v1/admin/audit-log both registered server-side', () => {
    expect(body).toContain("authedFetch('/v1/admin/overview')");
    expect(body).toContain("authedFetch('/v1/admin/audit-log?limit=5')");
    expect(existsSync(OVERVIEW_ROUTE)).toBe(true);
    expect(read(OVERVIEW_ROUTE)).toContain("'/v1/admin/overview'");
    expect(existsSync(AUDIT_ROUTE)).toBe(true);
    expect(read(AUDIT_ROUTE)).toContain("'/v1/admin/audit-log'");
  });

  it('tile data-fields map to overview-response keys', () => {
    // The progressive-enhancement script setText()s these three
    // fields from the body.accounts / body.webhooks payload —
    // renaming on either side without coordination silently
    // shows stale mock data forever.
    expect(body).toMatch(/data-field="active-accounts"/);
    expect(body).toMatch(/data-field="suspended-accounts"/);
    expect(body).toMatch(/data-field="dlq-depth"/);
    expect(body).toMatch(/setText\('active-accounts',\s*String\(body\.accounts\.active\)\)/);
    expect(body).toMatch(/setText\('suspended-accounts',\s*String\(body\.accounts\.suspended\)\)/);
    expect(body).toMatch(/setText\('dlq-depth',\s*String\(body\.webhooks\.dlq_depth\)\)/);
  });

  it('open-leads tile is intentionally still on mock (leads endpoint deferred)', () => {
    // V-666 "Prod wire-up deferred slices" — the leads tile is
    // load-bearing for the deferred-slice tracking. A future
    // "live" wire-up that lands before the endpoint exists would
    // silently show 0 instead of the mock count.
    expect(body).toContain('MOCK_LEADS.length');
    expect(body).toMatch(/mock — leads endpoint TBD/);
  });

  it('D-025 audit-before-response contract pinned (staff-transparency commitment)', () => {
    expect(body).toMatch(
      /All actions on this panel are audit-logged with admin id \+ target id \+\s+input payload \+ ip address/,
    );
    expect(body).toMatch(
      /Audit trail is append-only and cannot be\s+mutated by admins \(D-025 audit-before-response contract\)/,
    );
  });

  it('403 → "admin scope required" copy pinned (no silent redirect)', () => {
    expect(body).toMatch(/r\.status === 403/);
    expect(body).toMatch(/forbidden/);
    expect(body).toMatch(
      /Access denied — admin scope required\. You are signed in as a customer account\./,
    );
  });

  it('audit-row payload-shape (timestamp / admin_account_id / target_account_id / action / result) pinned', () => {
    // The renderAudits() function destructures these specific keys
    // off each row — a server-side field rename would silently
    // render blanks.
    for (const key of [
      'entry.timestamp',
      'entry.admin_account_id',
      'entry.target_account_id',
      'entry.action',
      'entry.result',
    ]) {
      expect(body).toContain(key);
    }
  });

  it('localStorage key ds_web_session_token (admin-panel shares the customer-dashboard convention)', () => {
    expect(body).toContain("'ds_web_session_token'");
  });

  it('"recent admin activity" → /audit-log full-log cross-link resolves', () => {
    expect(body).toMatch(/<a href="\/audit-log"/);
    expect(body).toMatch(/See full log →/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/admin-panel/src/pages/audit-log.astro'))).toBe(true);
  });

  it('no-token state: shows "preview" banner instead of redirecting away', () => {
    // V-190 / V-191 — page renders SSR-served mock counts when the
    // staff visitor has no token; surfaces a "sign-in to see live
    // data" banner. A future refactor that hard-redirects would
    // break the offline-preview affordance.
    expect(body).toMatch(/if \(!token\)/);
    expect(body).toMatch(
      /Sign in with a staff admin account to see live data\. Showing preview below\./,
    );
  });
});
