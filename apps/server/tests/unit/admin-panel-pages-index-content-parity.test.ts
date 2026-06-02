// W487.C — drift guard for apps/admin-panel/src/pages/index.astro.
// V-190 admin overview page — progressive-enhancement against
// /v1/admin/overview + /v1/admin/audit-log?limit=5. Drift here
// either drops the D-025 audit-before-response framing (operators
// lose the contract that audit-log writes precede the action's
// HTTP response) or breaks the 4-tile layout (active / suspended
// / leads / DLQ depth — the at-a-glance fleet-health surface).
//
//   • V-190 framing pinned + 'Open-leads tile remains on mock'
//     comment.
//   • 4-tile grid: active-accounts / suspended-accounts /
//     open-leads (mock) / dlq-depth.
//   • Recent admin activity → /audit-log full-log link.
//   • D-025 'audit-before-response contract' framing.
//   • 403 forbidden branch: 'Access denied — admin scope required.'
//   • Token key: 'ds_web_session_token'.
//   • authedFetch: apiBaseUrl + path + Bearer + credentials:'include'.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/index.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W487.C apps/admin-panel/src/pages/index.astro content parity', () => {
  const body = read(LIB);

  it("V-190 framing pinned: 'progressive-enhancement against /v1/admin/overview + /v1/admin/audit-log?limit=5. SSG renders mock counts; an inline <script> fetches both endpoints and replaces the tile values + the recent-activity list. Banner surfaces no-token / 403 forbidden / fetch-error states.' — pinned so the progressive-enhancement strategy + 3-state banner taxonomy stays documented", () => {
    expect(body).toMatch(
      /\/\/ V-190 — progressive-enhancement against \/v1\/admin\/overview \+\s*\n?\s*\/\/ \/v1\/admin\/audit-log\?limit=5\. SSG renders mock counts; an inline\s*\n?\s*\/\/ <script> fetches both endpoints and replaces the tile values \+ the\s*\n?\s*\/\/ recent-activity list\. Banner surfaces no-token \/ 403 forbidden \/\s*\n?\s*\/\/ fetch-error states\./,
    );
    expect(body).toMatch(
      /\/\/ Open-leads tile remains on mock \(MOCK_LEADS\.length\) — leads\s*\n?\s*\/\/ tracking has no Postgres surface yet\./,
    );
  });

  it("4-tile grid layout: Active accounts (data-field='active-accounts') / Suspended (data-field='suspended-accounts') / Open leads (mock — leads endpoint TBD) / DLQ depth (data-field='dlq-depth' default '0') — pinned so the at-a-glance health surface keeps the 4 canonical metrics + the 'mock' indicator on the leads tile (drift would either hide the mock-data caveat or shift which metric is mocked)", () => {
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-slate-500">Active accounts<\/p>/,
    );
    expect(body).toMatch(/data-field="active-accounts"/);
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-slate-500">Suspended<\/p>/,
    );
    expect(body).toMatch(/data-field="suspended-accounts"/);
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-slate-500">Open leads<\/p>/,
    );
    expect(body).toMatch(
      /<p class="mt-1 text-\[11px\] text-slate-400">mock — leads endpoint TBD<\/p>/,
    );
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-slate-500">DLQ depth<\/p>/,
    );
    expect(body).toMatch(/data-field="dlq-depth">0<\/p>/);
  });

  it("Recent admin activity card: 'See full log →' link to /audit-log (canonical audit-log page route — drift to /admin-audit or /logs would 404) + 'No admin actions recorded yet.' empty-state — pinned so the see-more link points to the real subpage. 2026-05-21 — 2c24750f wrapped the link in a text-xs flex row alongside the live-indicator + Refresh-now button; size class inherits from the row so text-sm dropped off the link itself.", () => {
    expect(body).toMatch(
      /<a href="\/audit-log" class="text-oxblood-700 hover:underline">\s*\n?\s*See full log →\s*\n?\s*<\/a>/,
    );
    expect(body).toMatch(
      /<li class="py-3 text-sm text-slate-500">No admin actions recorded yet\.<\/li>/,
    );
  });

  it("D-025 audit-before-response framing pinned: 'All actions on this panel are audit-logged with admin id + target id + input payload + ip address. Audit trail is append-only and cannot be mutated by admins (D-025 audit-before-response contract).' — pinned so the audit-trail integrity guarantee survives (drift to a softer phrasing weakens the immutability contract that operators rely on for compliance review)", () => {
    expect(body).toMatch(
      /All actions on this panel are audit-logged with admin id \+ target id \+\s*\n?\s*input payload \+ ip address\. Audit trail is append-only and cannot be\s*\n?\s*mutated by admins \(D-025 audit-before-response contract\)\./,
    );
  });

  it("403-forbidden + no-token banner branches: 'Sign in with a staff admin account to see live data. Showing preview below.' (no-token) + 'Access denied — admin scope required. You are signed in as a customer account.' (403) + 'Couldn't load overview (msg). Showing preview data below.' (fetch-error) — pinned so the 3-state banner taxonomy stays in sync with the V-190 framing comment", () => {
    expect(body).toMatch(
      /showBanner\('Sign in with a staff admin account to see live data\. Showing preview below\.'\);/,
    );
    expect(body).toMatch(
      /showBanner\(\s*\n?\s*'Access denied — admin scope required\. You are signed in as a customer account\.',\s*\n?\s*\);/,
    );
    expect(body).toMatch(
      /showBanner\("Couldn't load overview \(" \+ msg \+ '\)\. Showing preview data below\.'\);/,
    );
  });

  it("Token storage key 'ds_web_session_token' + authedFetch helper: apiBaseUrl + path + 'authorization: Bearer ' + credentials:'include' — pinned so the customer-dashboard ↔ admin-panel token-storage key stays in sync and the credentials-include flag carries the session cookie (required for V-269 dual-cookie session model on cross-origin admin requests)", () => {
    expect(body).toMatch(/const token = localStorage\.getItem\('ds_web_session_token'\);/);
    expect(body).toMatch(
      /function authedFetch\(path\) \{\s*\n?\s*return fetch\(apiBaseUrl \+ path, \{\s*\n?\s*headers: \{ authorization: 'Bearer ' \+ token \},\s*\n?\s*credentials: 'include',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it("Endpoint contract: GET /v1/admin/overview reads body.accounts.{active,suspended,total} + body.webhooks.dlq_depth into the live tiles + GET /v1/admin/audit-log?limit=5 reads body.data[] into the recent-activity list — pinned so the field names match the server response shape (drift to body.active_accounts or body.dlq would silently zero out the tile). Slice 136 added a 'of N total' annotation under the Active-accounts tile, surfacing the V-515 server-returned `body.accounts.total` field (with a defensive a+s+d fallback if total is missing)", () => {
    expect(body).toMatch(/authedFetch\('\/v1\/admin\/overview'\)/);
    expect(body).toMatch(/authedFetch\('\/v1\/admin\/audit-log\?limit=5'\)/);
    expect(body).toMatch(/setText\('active-accounts', String\(body\.accounts\.active\)\);/);
    expect(body).toMatch(/setText\('suspended-accounts', String\(body\.accounts\.suspended\)\);/);
    expect(body).toMatch(/setText\('dlq-depth', String\(body\.webhooks\.dlq_depth\)\);/);
    // Slice 136 — total-accounts annotation reads body.accounts.total
    // with a defensive a+s+d fallback so missing-field doesn't NaN.
    expect(body).toMatch(/body\.accounts\.total/);
    expect(body).toMatch(/setText\('total-accounts-annotation'/);
    expect(body).toMatch(/data-field="total-accounts-annotation"/);
  });

  it("Audit-log render: per-entry timestamp via fmtIso → 'YYYY-MM-DD HH:MM:SS UTC' (slice(0, 19) — not 16 like the leads page, because audit-log needs second-level precision) + entry.admin_account_id mono + → arrow + entry.action code + entry.result success/error badge — pinned so the admin-action row template renders the structured action vocabulary consistently", () => {
    expect(body).toMatch(/\.slice\(0, 19\) \+ ' UTC';/);
    expect(body).toMatch(
      /entry\.result === 'success'\s*\n?\s*\? 'bg-emerald-50 text-emerald-700'\s*\n?\s*: 'bg-red-50 text-red-700';/,
    );
    expect(body).toMatch(/escapeHtml\(entry\.admin_account_id\)/);
    expect(body).toMatch(/escapeHtml\(entry\.action\)/);
  });

  it("apiBaseUrl injection: resolveApiBaseUrl() call + define:vars (apiBaseUrl + tier order/labels) on the inline script tag — pinned so the API base URL + tier metadata are injected at SSG time (not at runtime via env-var lookup that wouldn't exist in the browser) and the inline script can prefix every authedFetch with the right host", () => {
    expect(body).toMatch(/import \{ resolveApiBaseUrl \} from '\.\.\/lib\/api-base-url';/);
    expect(body).toMatch(/const apiBaseUrl = resolveApiBaseUrl\(\);/);
    expect(body).toMatch(
      /<script is:inline define:vars=\{\{ apiBaseUrl, tierOrder: TIER_ORDER, tierLabels: TIER_LABELS \}\}>/,
    );
  });

  it("accounts-by-tier section: SSR mock-preview bars (data-list='tier-distribution') + live hydration via renderTiers from overview.accounts.by_tier — pinned so the tier-distribution stat keeps a real-data wiring (drift would silently revert the dashboard to mock-only tier counts)", () => {
    // Canonical tier order + friendly labels are the single source shared by
    // SSR and hydration (passed via define:vars).
    expect(body).toMatch(/const TIER_ORDER = \[/);
    expect(body).toMatch(/'free',/);
    expect(body).toMatch(/'enterprise',/);
    expect(body).toMatch(/const TIER_LABELS: Record<string, string> = \{/);
    // SSR section + per-tier bar list.
    expect(body).toMatch(/Accounts by tier/);
    expect(body).toMatch(/data-list="tier-distribution"/);
    expect(body).toMatch(/data-field="tier-total"/);
    // Live hydration reads the server field + replaces the SSR bars.
    expect(body).toMatch(/if \(body\.accounts\.by_tier\) \{/);
    expect(body).toMatch(/renderTiers\(body\.accounts\.by_tier, total\);/);
    expect(body).toMatch(/function renderTiers\(byTier, total\) \{/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
