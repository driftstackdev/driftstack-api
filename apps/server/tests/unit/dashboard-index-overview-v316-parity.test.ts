// W748 — customer-dashboard index.astro V-316 live-data parity.
// Seventy-fourth in the cross-SDK drift-guard series.
//
// The dashboard home is the canonical entry-point for every authed
// customer. The V-316 4-call live-data wire drives every stat the
// customer sees on first load.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const INDEX = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/index.astro');

describe('W748 dashboard index/overview V-316 live-data parity', () => {
  it('index.astro file exists', () => {
    expect(existsSync(INDEX)).toBe(true);
  });

  it('CRITICAL V-316 anchor + V-099 replacement framing pinned. The "wires the dashboard home page to live data. Replaces the V-099 mock-data scaffolding" framing tells engineers V-316 is what makes the dashboard actually-functional (NOT a mock).', () => {
    const i = read(INDEX);

    expect(i).toMatch(/V-316 — wires the dashboard home page to live data\. Replaces the/);
    expect(i).toMatch(/V-099 mock-data scaffolding/);
  });

  it("CRITICAL 4-call live-data wire pinned — /v1/account/me + /v1/api-keys + /v1/sessions + /v1/billing. Each call independent; failures in one section don't blank the rest. Drift to coupling them would let a single failed endpoint blank the whole page.", () => {
    const i = read(INDEX);

    // 4 routes documented.
    expect(i).toMatch(/- GET \/v1\/account\/me \(account \+ concurrent caps \+ profile count\)/);
    expect(i).toMatch(/- GET \/v1\/api-keys/);
    expect(i).toMatch(/- GET \/v1\/sessions/);
    expect(i).toMatch(/- GET \/v1\/billing/);
    expect(i).toMatch(
      /Each call is independent; failures in one section don't blank the\s*\n\/\/\s+rest/,
    );

    // 4 getJson() calls in implementation.
    expect(i).toMatch(/getJson\('\/v1\/account\/me'\)/);
    expect(i).toMatch(/getJson\('\/v1\/api-keys'\)/);
    expect(i).toMatch(/getJson\('\/v1\/sessions'\)/);
    expect(i).toMatch(/getJson\('\/v1\/billing'\)/);
  });

  it('CRITICAL client-side render framing pinned — "Render is client-side so the dashboard server stays static (Astro\'s hybrid mode is intentionally avoided here)". Drift to hybrid mode would couple dashboard auth to server-side rendering.', () => {
    const i = read(INDEX);

    expect(i).toMatch(
      /Render is client-side so the dashboard server stays static\s*\n\/\/\s+\(Astro's hybrid mode is intentionally avoided here\)/,
    );
  });

  it('CRITICAL V-331 actAs header passthrough pinned. window.driftstackActAsHeaders helper from W743 DashboardLayout is consumed; self-scope returns {} so the request behaves identically when not "acting as".', () => {
    const i = read(INDEX);

    expect(i).toMatch(/V-331 — pick up the X-Driftstack-Account header from the/);
    expect(i).toMatch(/shared helper installed by DashboardLayout\. Self-scope returns/);
    expect(i).toMatch(/\{\} so the request behaves identically when not "acting as"/);

    expect(i).toMatch(
      /const actAs =\s*\n\s+typeof window\.driftstackActAsHeaders === 'function'\s*\n\s+\? window\.driftstackActAsHeaders\(\)\s*\n\s+: \{\};/,
    );
  });

  it('CRITICAL headers shape pinned — Authorization Bearer + accept: application/json + ...actAs spread. The 3-field shape is what every dashboard fetch should use.', () => {
    const i = read(INDEX);

    expect(i).toMatch(
      /const headers = \{\s*\n\s+Authorization: 'Bearer ' \+ token,\s*\n\s+accept: 'application\/json',\s*\n\s+\.\.\.actAs,\s*\n\s+\};/,
    );
  });

  it('CRITICAL no-token banner-with-recovery framing pinned. Drift to bare 401 would not tell customers what to do; the banner tells them "Sign in to see live account data".', () => {
    const i = read(INDEX);

    expect(i).toMatch(
      /if \(!token\) \{\s*\n\s+showBanner\('Sign in to see live account data\.'\);\s*\n\s+return;/,
    );
  });

  it('CRITICAL escapeHtml() XSS guard pinned for session row interpolation. Drift to dropping would let a malicious session id (e.g. via API-key compromise) inject HTML into the dashboard.', () => {
    const i = read(INDEX);

    // 4 escapeHtml() usages on the session-row HTML build.
    const escapeUsages = (i.match(/escapeHtml\(/g) ?? []).length;
    expect(escapeUsages, 'escapeHtml() guards on session-row build').toBeGreaterThanOrEqual(4);

    // 5-char map: & < > " '
    expect(i).toMatch(/if \(c === '<'\) return '&lt;'/);
    expect(i).toMatch(/if \(c === '>'\) return '&gt;'/);
    expect(i).toMatch(/if \(c === '"'\) return '&quot;'/);
  });

  it('CRITICAL fmtIsoDay() helper pinned — `new Date(iso).toISOString().slice(0, 10)` with em-dash fallback. The slice(0, 10) gives YYYY-MM-DD format; drift would change the customer-visible date format on billing-period-end + trial-pack-expires.', () => {
    const i = read(INDEX);

    expect(i).toMatch(
      /function fmtIsoDay\(iso\) \{\s*\n\s+if \(!iso\) return '—';\s*\n\s+return new Date\(iso\)\.toISOString\(\)\.slice\(0, 10\);\s*\n\s+\}/,
    );
  });

  it('CRITICAL me.concurrent_session_active + concurrent_session_cap + profile_count + profile_cap field reads pinned. Matches W704 AccountSelfProfile shape.', () => {
    const i = read(INDEX);

    expect(i).toMatch(/me\.concurrent_session_active \?\? 0/);
    expect(i).toMatch(/me\.concurrent_session_cap \?\? '—'/);
    expect(i).toMatch(/me\.profile_count \?\? 0/);
    expect(i).toMatch(/me\.profile_cap/);
  });

  it("CRITICAL api-keys revoked_at filter pinned — only non-revoked keys count toward 'active'. Drift to including revoked would inflate the API-keys stat (would force customers to wonder why a deleted key still counts).", () => {
    const i = read(INDEX);

    expect(i).toMatch(
      /const active = keys\.filter\(function \(k\) \{\s*\n\s+return !k\.revoked_at;\s*\n\s+\}\)\.length/,
    );
  });

  it("CRITICAL sessions status filter — exclude 'destroyed' AND 'errored'. The 2-state exclusion matches the Active sessions UX (customer wants to see running, not historical). Matches W705 sessions lifecycle.", () => {
    const i = read(INDEX);

    expect(i).toMatch(
      /const active = all\.filter\(function \(s\) \{\s*\n\s+return s\.status !== 'destroyed' && s\.status !== 'errored';/,
    );
  });

  it('CRITICAL sessions top-5 cap pinned — `active.slice(0, 5)`. Drift to showing all would blow up the home page on accounts with 100+ active sessions (api_scale tier).', () => {
    const i = read(INDEX);
    expect(i).toMatch(/active\s*\n\s+\.slice\(0, 5\)/);
  });

  it('CRITICAL billing subscription card render pinned. Reads sub.tier + sub.status + sub.current_period_end; falls back to subscription-empty when sub is absent. Drift to dropping the subscription-empty branch would leave new accounts with a blank section.', () => {
    const i = read(INDEX);

    expect(i).toMatch(/const sub = b\.subscription;/);
    expect(i).toMatch(
      /if \(line\) line\.textContent = String\(sub\.tier\) \+ ' · ' \+ String\(sub\.status\)/,
    );
    expect(i).toMatch(/'Period ends ' \+ fmtIsoDay\(sub\.current_period_end\) \+ '\.'/);
    expect(i).toMatch(/\} else if \(empty\) \{\s*\n\s+empty\.classList\.remove\('hidden'\);/);
  });

  it("CRITICAL trial-pack credit display pinned — cents/100 to 2 decimal + 'Expires <day>' suffix when expires_at present. Matches W729 TRIAL_PACK 14-day window + credit_cents_remaining contract.", () => {
    const i = read(INDEX);

    expect(i).toMatch(/const trial = b\.trial_pack;/);
    expect(i).toMatch(/if \(trial && trial\.active\) \{/);
    expect(i).toMatch(
      /const cents = Number\(trial\.credit_cents_remaining \|\| 0\);\s*\n\s+const dollars = \(cents \/ 100\)\.toFixed\(2\)/,
    );
    expect(i).toMatch(
      /const exp = trial\.expires_at \? ' Expires ' \+ fmtIsoDay\(trial\.expires_at\) \+ '\.' : ''/,
    );
    expect(i).toMatch(/tLine\.textContent = '\$' \+ dollars \+ ' credit remaining\.' \+ exp/);
  });

  it('CRITICAL graceful-failure pattern across all 4 endpoints. .catch() handlers either show a banner (account/me) or silently leave dash (api-keys) or show a section-specific empty (sessions/billing). Drift to throwing globally would blank the whole page on partial failure.', () => {
    const i = read(INDEX);

    // 4 .catch() blocks for the 4 getJson() calls.
    const catchBlocks = (i.match(/\.catch\(function \(/g) ?? []).length;
    expect(catchBlocks, '.catch() per endpoint').toBeGreaterThanOrEqual(4);

    // sessions failure → empty.textContent = 'Could not load sessions.'
    expect(i).toMatch(/empty\.textContent = 'Could not load sessions\.'/);

    // billing failure → empty.textContent = 'Could not load billing.'
    expect(i).toMatch(/empty\.textContent = 'Could not load billing\.'/);
  });

  it('CRITICAL escapeHtml uses [&<>"\'] regex + replace callback. Drift to using innerHTML+textContent dance would slow render; drift to dropping the regex would let strings without special chars still allocate.', () => {
    const i = read(INDEX);

    expect(i).toMatch(
      /return String\(s == null \? '' : s\)\.replace\(\/\[&<>"'\]\/g, function \(c\) \{/,
    );
    expect(i).toMatch(/if \(c === '&'\) return '&amp;'/);
  });

  it('CRITICAL DashboardLayout used WITHOUT withSidebar={false} (default true). The overview IS sidebar-enabled — customers navigate from here to other surfaces.', () => {
    const i = read(INDEX);

    // Just `<DashboardLayout title="Overview">` — no withSidebar override.
    expect(i).toMatch(/<DashboardLayout title="Overview">/);
    expect(i).not.toMatch(/<DashboardLayout title="Overview" withSidebar=\{false\}/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/dashboard-index-overview-v316-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
