// W494.B — drift guard for apps/customer-dashboard/src/pages/index.astro.
// V-316 dashboard home page (replaces V-099 mock scaffolding).
// Drift here either drops the independent-section-fetch pattern
// (one failed endpoint would blank the entire dashboard) or
// breaks the V-331 act-as header propagation (team-scoped reads
// would silently revert to the operator's own account).
//
//   • V-316 framing pinned + 4-endpoint independent-fetch pattern.
//   • 4 endpoints: /v1/account/me + /v1/api-keys + /v1/sessions +
//     /v1/billing.
//   • 4-tile metric grid: Concurrent now / Profiles / Usage / Billing.
//   • V-331 driftstackActAsHeaders propagation for team-scoped
//     reads.
//   • Subscription card: active subscription vs no-subscription
//     vs trial-pack credit.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/index.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W494.B apps/customer-dashboard/src/pages/index.astro content parity', () => {
  const body = read(LIB);

  it("V-316 framing pinned: 'wires the dashboard home page to live data. Replaces the V-099 mock-data scaffolding. Reads: GET /v1/account/me (account + concurrent caps + profile count) + GET /v1/api-keys + GET /v1/sessions + GET /v1/billing. Each call is independent; failures in one section don't blank the rest. Render is client-side so the dashboard server stays static (Astro's hybrid mode is intentionally avoided here).' — pinned so the independent-fetch + static-server framing survives (drift to a unified Promise.all would couple failures across sections)", () => {
    expect(body).toMatch(
      /\/\/ V-316 — wires the dashboard home page to live data\. Replaces the\s*\/\/ V-099 mock-data scaffolding\. Reads:\s*\/\/ {3}- GET \/v1\/account\/me \(account \+ concurrent caps \+ profile count\)\s*\/\/ {3}- GET \/v1\/api-keys\s*\/\/ {3}- GET \/v1\/sessions\s*\/\/ {3}- GET \/v1\/billing/,
    );
    expect(body).toMatch(
      /\/\/ Each call is independent; failures in one section don't blank the\s*\/\/ rest\. Render is client-side so the dashboard server stays static\s*\/\/ \(Astro's hybrid mode is intentionally avoided here\)\./,
    );
  });

  it("V-331 act-as header propagation: 'pick up the X-Driftstack-Account header from the shared helper installed by DashboardLayout. Self-scope returns {} so the request behaves identically when not acting as.' + headers spread with ...actAs — pinned so the team-scoped 'act as another account' flow propagates to every dashboard fetch (drift would silently show the operator's own account data when they're trying to view a team-mate's)", () => {
    expect(body).toMatch(
      /\/\/ V-331 — pick up the X-Driftstack-Account header from the\s*\/\/ shared helper installed by DashboardLayout\. Self-scope returns\s*\/\/ \{\} so the request behaves identically when not "acting as"\./,
    );
    expect(body).toMatch(
      /const actAs =\s*typeof window\.driftstackActAsHeaders === 'function'\s*\? window\.driftstackActAsHeaders\(\)\s*: \{\};\s*const headers = \{\s*Authorization: 'Bearer ' \+ token,\s*accept: 'application\/json',\s*\.\.\.actAs,\s*\};/,
    );
  });

  it("4-tile metric grid (Fleet v2, founder-locked 2026-07-02): 'Active sessions' (active / cap + meter — per ADR-004 the concurrent cap is the ONLY meter) + 'Profiles' (count / cap + meter) + 'Session hours' (cycle total, NO cap) + 'Plan' (tier + status). The API-keys count moved into the Mint-API-key quick action. Pinned so the at-a-glance metrics answer: am I at concurrent cap? am I at profile cap? how much have I used? what am I on?", () => {
    expect(body).toMatch(/Active sessions\s*<\/p>/);
    expect(body).toMatch(/Profiles\s*<\/p>/);
    expect(body).toMatch(/Session hours\s*<\/p>/);
    expect(body).toMatch(/Plan\s*<\/p>/);
    expect(body).toMatch(/data-stat-concurrent>—<\/span>/);
    expect(body).toMatch(/data-stat-concurrent-cap>—<\/span>/);
    expect(body).toMatch(/data-stat-concurrent-meter/);
    expect(body).toMatch(/data-stat-profiles>—<\/span>/);
    expect(body).toMatch(/data-stat-profiles-meter/);
    expect(body).toMatch(/data-stat-hours>—<\/span>/);
    expect(body).toMatch(/data-stat-plan>—<\/span>/);
    // API-keys count lives in the quick-action card now.
    expect(body).toMatch(/<span data-stat-api-keys>—<\/span> active\./);
    // ADR-004 honesty: session hours carry NO cap (concurrent is the only meter).
    expect(body).toMatch(/concurrent cap is the only meter/);
  });

  it("Active sessions filter: status !== 'destroyed' && status !== 'errored' + slice(0, 5) — pinned so the dashboard shows only currently-running sessions (drift to including destroyed/errored would clutter the home view with terminal-state rows) and the 5-row limit prevents the section from dominating the page for high-volume accounts", () => {
    expect(body).toMatch(
      /const active = all\.filter\(function \(s\) \{\s*return s\.status !== 'destroyed' && s\.status !== 'errored';\s*\}\);/,
    );
    expect(body).toMatch(/active\s*\.slice\(0, 5\)/);
  });

  it("Subscription 2-state render: sub present → card.remove('hidden') + 'tier · status' line + 'Period ends {date}' / sub absent → empty.remove('hidden') — pinned so the two states stay mutually-exclusive in display (drift to showing both subscription + no-sub would surface contradictory UI). The retired trial-pack credit card was removed alongside the trial tier.", () => {
    expect(body).toMatch(/if \(sub\) \{\s*if \(card\) card\.classList\.remove\('hidden'\);/);
    expect(body).toMatch(
      /if \(line\) line\.textContent = tierLabel\(sub\.tier\) \+ ' · ' \+ String\(sub\.status\);/,
    );
    expect(body).toMatch(
      /if \(period\) period\.textContent = 'Period ends ' \+ fmtIsoDay\(sub\.current_period_end\) \+ '\.';/,
    );
    // No trial-pack credit branch anymore.
    expect(body).not.toMatch(/data-trial-pack/);
  });

  it("Concurrent + profile cap rendering: me.concurrent_session_active ?? 0 + me.concurrent_session_cap ?? '—' + me.profile_cap != null → ' / ' + cap — pinned so a null cap (enterprise / unlimited) renders as '—' instead of the literal 'null' and active counts default to 0 (drift to dropping the ?? would crash on undefined or surface 'undefined' as text)", () => {
    expect(body).toMatch(/String\(me\.concurrent_session_active \?\? 0\)/);
    expect(body).toMatch(/String\(me\.concurrent_session_cap \?\? '—'\)/);
    expect(body).toMatch(
      /if \(profilesCap && me\.profile_cap != null\) profilesCap\.textContent = ' \/ ' \+ me\.profile_cap;/,
    );
  });

  it("API-keys filter: keys.filter(k => !k.revoked_at).length — pinned so the dashboard counts only ACTIVE keys (drift to total-count would mislead customers who've revoked old keys into thinking they have more keys than they actually do)", () => {
    expect(body).toMatch(
      /const active = keys\.filter\(function \(k\) \{\s*return !k\.revoked_at;\s*\}\)\.length;/,
    );
  });

  it("Independent-error handling: /v1/api-keys catch leaves dash unchanged (silent fallback) + /v1/sessions catch surfaces 'Could not load sessions.' in the empty slot + /v1/billing catch surfaces 'Could not load billing.' in the empty subscription slot — pinned so each section's failure stays localized (drift to a global error banner would hide which specific endpoint failed)", () => {
    expect(body).toMatch(/\/\* leave dash \*\//);
    expect(body).toMatch(
      /empty\.textContent = 'Could not load sessions\.';\s*empty\.classList\.remove\('hidden'\);/,
    );
    expect(body).toMatch(
      /empty\.textContent = 'Could not load billing\.';\s*empty\.classList\.remove\('hidden'\);/,
    );
  });

  it('No-token guard: canonical /login/?next=<encoded current path> preserves the deep link through login and keeps unauthed visitors away from the SSG placeholder UI', () => {
    expect(body).toMatch(
      /if \(!token\) \{\s*\/\/ 2026-05-19 — dashboard hard-redirects to \/login when there's\s*\/\/ no session token,[\s\S]*?const next = encodeURIComponent\(window\.location\.pathname \+ window\.location\.search\);\s*window\.location\.replace\('\/login\/\?next=' \+ next\);\s*return;\s*\}/,
    );
    expect(body).not.toContain('/login?return_to=');
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('Data-protection trust surface pins context-bound wrapping and recorded-event audit truth', () => {
    expect(body).toMatch(/Your data is protected/);
    expect(body).toMatch(/AES-256-GCM at rest/);
    expect(body).toMatch(/Context-bound encryption/);
    expect(body).toMatch(/platform-held keys/);
    expect(body).toMatch(
      /owning account and, for record-scoped stores, the exact record and value slot/,
    );
    expect(body).toMatch(/Recorded management events/);
    expect(body).toMatch(/credential-management events that were recorded/);
    expect(body).toMatch(/routine runtime use is not logged as a credential-read event/i);
    expect(body).toMatch(/href="\/audit-log\/"/);
    expect(body).toMatch(/driftstack\.io\/trust\/security-overview\//);
    expect(body).not.toMatch(/Profiles are client-encrypted/);
    expect(body).not.toMatch(/Every credential read lands/);
    expect(body).not.toMatch(/Always audited/);
    expect(body).not.toMatch(/Management changes audited/);
    expect(body).not.toMatch(/Account \+ record bound/);
    expect(body).toMatch(/export and deletion are request-based today/);
    expect(body).toMatch(/href="\/security\/#danger-zone"/);
    expect(body).not.toMatch(/export or delete anytime from/);
  });
});
