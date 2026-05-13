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
//   • 3-tile metric grid: Concurrent now / Profiles / API keys.
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
      /\/\/ V-316 — wires the dashboard home page to live data\. Replaces the\s*\n?\s*\/\/ V-099 mock-data scaffolding\. Reads:\s*\n?\s*\/\/ {3}- GET \/v1\/account\/me \(account \+ concurrent caps \+ profile count\)\s*\n?\s*\/\/ {3}- GET \/v1\/api-keys\s*\n?\s*\/\/ {3}- GET \/v1\/sessions\s*\n?\s*\/\/ {3}- GET \/v1\/billing/,
    );
    expect(body).toMatch(
      /\/\/ Each call is independent; failures in one section don't blank the\s*\n?\s*\/\/ rest\. Render is client-side so the dashboard server stays static\s*\n?\s*\/\/ \(Astro's hybrid mode is intentionally avoided here\)\./,
    );
  });

  it("V-331 act-as header propagation: 'pick up the X-Driftstack-Account header from the shared helper installed by DashboardLayout. Self-scope returns {} so the request behaves identically when not acting as.' + headers spread with ...actAs — pinned so the team-scoped 'act as another account' flow propagates to every dashboard fetch (drift would silently show the operator's own account data when they're trying to view a team-mate's)", () => {
    expect(body).toMatch(
      /\/\/ V-331 — pick up the X-Driftstack-Account header from the\s*\n?\s*\/\/ shared helper installed by DashboardLayout\. Self-scope returns\s*\n?\s*\/\/ \{\} so the request behaves identically when not "acting as"\./,
    );
    expect(body).toMatch(
      /const actAs =\s*\n?\s*typeof window\.driftstackActAsHeaders === 'function'\s*\n?\s*\? window\.driftstackActAsHeaders\(\)\s*\n?\s*: \{\};\s*\n?\s*const headers = \{\s*\n?\s*Authorization: 'Bearer ' \+ token,\s*\n?\s*accept: 'application\/json',\s*\n?\s*\.\.\.actAs,\s*\n?\s*\};/,
    );
  });

  it("3-tile metric grid: 'Concurrent now' (active / cap) + 'Profiles' (count / cap) + 'API keys' (active count) — pinned so the at-a-glance dashboard metrics stay 3-tile (drift to dropping a tile would force customers to navigate to detail pages for the most-common questions: am I at concurrent cap? am I at profile cap?)", () => {
    expect(body).toMatch(
      /<p class="text-xs font-mono uppercase tracking-widest text-slate-500">Concurrent now<\/p>/,
    );
    expect(body).toMatch(
      /<p class="text-xs font-mono uppercase tracking-widest text-slate-500">Profiles<\/p>/,
    );
    expect(body).toMatch(
      /<p class="text-xs font-mono uppercase tracking-widest text-slate-500">API keys<\/p>/,
    );
    expect(body).toMatch(/data-stat-concurrent>—<\/span>/);
    expect(body).toMatch(/data-stat-concurrent-cap>—<\/span>/);
    expect(body).toMatch(/data-stat-profiles>—<\/span>/);
    expect(body).toMatch(/data-stat-api-keys>—<\/span>/);
  });

  it("Active sessions filter: status !== 'destroyed' && status !== 'errored' + slice(0, 5) — pinned so the dashboard shows only currently-running sessions (drift to including destroyed/errored would clutter the home view with terminal-state rows) and the 5-row limit prevents the section from dominating the page for high-volume accounts", () => {
    expect(body).toMatch(
      /const active = all\.filter\(function \(s\) \{\s*\n?\s*return s\.status !== 'destroyed' && s\.status !== 'errored';\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(/active\s*\n?\s*\.slice\(0, 5\)/);
  });

  it("Subscription 3-state render: sub present → card.remove('hidden') + 'tier · status' line + 'Period ends {date}' / sub absent → empty.remove('hidden') / trial_pack present + active → trial card with '$N.NN credit remaining. Expires {date}.' — pinned so the 3 states stay mutually-exclusive in display (drift to showing both subscription + no-sub would surface contradictory UI; drift to dropping trial-pack would hide active credit balance from the dashboard)", () => {
    expect(body).toMatch(/if \(sub\) \{\s*\n?\s*if \(card\) card\.classList\.remove\('hidden'\);/);
    expect(body).toMatch(
      /if \(line\) line\.textContent = String\(sub\.tier\) \+ ' · ' \+ String\(sub\.status\);/,
    );
    expect(body).toMatch(
      /if \(trial && trial\.active\) \{\s*\n?\s*const tEl = root\.querySelector\('\[data-trial-pack\]'\);\s*\n?\s*const tLine = root\.querySelector\('\[data-trial-pack-line\]'\);\s*\n?\s*if \(tEl\) tEl\.classList\.remove\('hidden'\);/,
    );
    expect(body).toMatch(
      /if \(tLine\) tLine\.textContent = '\$' \+ dollars \+ ' credit remaining\.' \+ exp;/,
    );
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
      /const active = keys\.filter\(function \(k\) \{\s*\n?\s*return !k\.revoked_at;\s*\n?\s*\}\)\.length;/,
    );
  });

  it("Independent-error handling: /v1/api-keys catch leaves dash unchanged (silent fallback) + /v1/sessions catch surfaces 'Could not load sessions.' in the empty slot + /v1/billing catch surfaces 'Could not load billing.' in the empty subscription slot — pinned so each section's failure stays localized (drift to a global error banner would hide which specific endpoint failed)", () => {
    expect(body).toMatch(/\/\* leave dash \*\//);
    expect(body).toMatch(
      /empty\.textContent = 'Could not load sessions\.';\s*\n?\s*empty\.classList\.remove\('hidden'\);/,
    );
    expect(body).toMatch(
      /empty\.textContent = 'Could not load billing\.';\s*\n?\s*empty\.classList\.remove\('hidden'\);/,
    );
  });

  it("Trial-pack credit dollars formatting: Number(trial.credit_cents_remaining || 0) / 100 + .toFixed(2) — pinned so the cents → dollars conversion stays consistent (drift to bare division would show '4.9' instead of '4.90'; drift to dropping the || 0 fallback would render 'NaN' on missing field)", () => {
    expect(body).toMatch(
      /const cents = Number\(trial\.credit_cents_remaining \|\| 0\);\s*\n?\s*const dollars = \(cents \/ 100\)\.toFixed\(2\);/,
    );
  });

  it("No-token guard: 'Sign in to see live account data.' banner + early-bail — pinned so customers who land on / without a token see a clear sign-in prompt rather than empty placeholders or broken fetches (drift to silent bail would leave the dashboard at the SSG '—' placeholder state with no explanation)", () => {
    expect(body).toMatch(
      /if \(!token\) \{\s*\n?\s*showBanner\('Sign in to see live account data\.'\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
