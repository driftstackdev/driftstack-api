// W749 — customer-dashboard /sessions.astro V-180 (live-fetch) +
// V-186 (concurrent meter) parity. Seventy-fifth in the cross-SDK
// drift-guard series.
//
// The /sessions page is the only customer-facing surface where the
// concurrent meter (THE billing meter) is visualised in real time.
// Drift to the V-186 wiring would silently undercount or overcount
// the concurrent-cap fraction.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/sessions.astro');

describe('W749 dashboard /sessions page V-180 + V-186 parity', () => {
  it('sessions.astro file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL V-180 anchor + V-171 /usage parallel framing pinned. The "progressive-enhancement wiring against /v1/sessions, mirrors the V-171 /usage pattern" wording threads the cross-page convention.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-180 — progressive-enhancement wiring against \/v1\/sessions, mirrors/);
    expect(p).toMatch(/the V-171 \/usage pattern\./);
    expect(p).toMatch(/SSG renders mock; inline <script> replaces/);
    expect(p).toMatch(/the lists with live data when ds_web_session_token is in localStorage\./);
  });

  it('CRITICAL V-186 concurrent meter framing pinned. The "concurrent_now is computed from /v1/sessions response (count of status in [creating, ready, busy]). concurrent_limit comes from /v1/usage.tier mapped via TIER_CONCURRENT_SESSION_LIMITS" formula is the load-bearing billing-meter contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-186 — concurrent meter now wired live\. concurrent_now is computed/);
    expect(p).toMatch(/from \/v1\/sessions response \(count of status in \[creating, ready,/);
    expect(p).toMatch(/busy\]\)\. concurrent_limit comes from \/v1\/usage\.tier mapped via/);
    expect(p).toMatch(/TIER_CONCURRENT_SESSION_LIMITS imported from @driftstack\/api-types\./);
  });

  it('CRITICAL TIER_CONCURRENT_SESSION_LIMITS imported from @driftstack/api-types. Drift to inlining or duplicating the tier→cap map would let dashboard drift from server billing.', () => {
    const p = read(PAGE);
    expect(p).toMatch(/import \{ TIER_CONCURRENT_SESSION_LIMITS \} from '@driftstack\/api-types'/);
    expect(p).toMatch(/const tierConcurrentLimits = TIER_CONCURRENT_SESSION_LIMITS/);
  });

  it('CRITICAL 5-status STATUS_BADGE_CLASS map pinned — creating/ready/busy/destroyed/errored. Matches V-105 session-lifecycle 5-state machine. Drift to dropping a state would leave that status badge-less in the UI.', () => {
    const p = read(PAGE);

    // The map is declared twice: once in TS frontmatter, once in inline script.
    expect((p.match(/creating: 'bg-glow-red\/10 text-glow-red'/g) ?? []).length).toBe(2);
    expect((p.match(/ready: 'bg-emerald-400\/10 text-emerald-300'/g) ?? []).length).toBe(2);
    expect((p.match(/busy: 'bg-blue-50 text-blue-700'/g) ?? []).length).toBe(2);
    expect((p.match(/destroyed: 'bg-surface-raised text-ink-secondary'/g) ?? []).length).toBe(2);
    expect((p.match(/errored: 'bg-red-50 text-red-700'/g) ?? []).length).toBe(2);
  });

  it("CRITICAL Active vs Recent partition rule pinned — 'destroyed' AND 'errored' are recent; everything else is active. Drift to a different split would either hide running sessions from the Active list or include them in Recent.", () => {
    const p = read(PAGE);

    // TS frontmatter partition.
    expect(p).toMatch(
      /const activeSessions = MOCK_SESSIONS\.filter\(\s*\n\s+\(s\) => s\.status !== 'destroyed' && s\.status !== 'errored',\s*\n\s*\)/,
    );
    expect(p).toMatch(
      /const recentClosedSessions = MOCK_SESSIONS\.filter\(\s*\n\s+\(s\) => s\.status === 'destroyed' \|\| s\.status === 'errored',\s*\n\s*\)/,
    );

    // Inline-script partition mirrors.
    expect(p).toMatch(
      /const active = sessions\.filter\(\s*\n\s+\(s\) => s\.status !== 'destroyed' && s\.status !== 'errored',\s*\n\s*\)/,
    );
    expect(p).toMatch(
      /const recent = sessions\.filter\(\s*\n\s+\(s\) => s\.status === 'destroyed' \|\| s\.status === 'errored',\s*\n\s*\)/,
    );
  });

  it('CRITICAL fmtIso() helper pinned in BOTH frontmatter + inline script — yyyy-MM-dd HH:mm UTC. Drift to a different format would create dashboard/server disagreement on session timestamps.', () => {
    const p = read(PAGE);

    // Frontmatter (TS).
    expect(p).toMatch(
      /function fmtIso\(iso: string \| null\): string \{\s*\n\s+if \(iso === null\) return '—';\s*\n\s+return new Date\(iso\)\.toISOString\(\)\.replace\('T', ' '\)\.slice\(0, 16\) \+ ' UTC';\s*\n\}/,
    );

    // Inline-script (JS).
    expect(p).toMatch(
      /function fmtIso\(iso\) \{\s*\n\s+if \(!iso\) return '—';\s*\n\s+return new Date\(iso\)\.toISOString\(\)\.replace\('T', ' '\)\.slice\(0, 16\) \+ ' UTC';\s*\n\s+\}/,
    );
  });

  it('CRITICAL fmtDuration() helper pinned — hours-minutes-seconds (h/m/s) with hourly-overflow + minutely-overflow fall-throughs. Drift to a different format would change the recent-sessions duration display.', () => {
    const p = read(PAGE);

    // TS variant.
    expect(p).toMatch(
      /if \(hr > 0\) return `\$\{hr\.toString\(\)\}h \$\{\(min % 60\)\.toString\(\)\}m`/,
    );
    expect(p).toMatch(
      /if \(min > 0\) return `\$\{min\.toString\(\)\}m \$\{\(sec % 60\)\.toString\(\)\}s`/,
    );

    // JS variant.
    expect(p).toMatch(/if \(hr > 0\) return hr \+ 'h ' \+ \(min % 60\) \+ 'm'/);
    expect(p).toMatch(/if \(min > 0\) return min \+ 'm ' \+ \(sec % 60\) \+ 's'/);
  });

  it('CRITICAL escapeHtml() XSS guard with 5-char map pinned. Every dynamically-rendered session field (id, status, archetype, profile_id, fmtIso/fmtDuration results) goes through it. Drift to dropping would let a malicious session id (post API-key compromise) inject HTML.', () => {
    const p = read(PAGE);

    // 5-char map.
    expect(p).toMatch(/'&': '&amp;'/);
    expect(p).toMatch(/'<': '&lt;'/);
    expect(p).toMatch(/'>': '&gt;'/);
    expect(p).toMatch(/'"': '&quot;'/);
    expect(p).toMatch(/"'": '&#39;'/);

    // Sufficient usages in DOM-building helpers.
    const escapeUsages = (p.match(/escapeHtml\(/g) ?? []).length;
    expect(escapeUsages).toBeGreaterThanOrEqual(10);
  });

  it("CRITICAL no-token preview-fallback framing pinned — 'Sign in to see live sessions. Showing preview data below.' Drift to a 401 redirect would lose the marketing-y preview-of-real-product affordance.", () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /showBanner\('Sign in to see live sessions\. Showing preview data below\.'\);\s*\n\s+return;/,
    );
  });

  it('CRITICAL parallel-fetch framing pinned — sessionsP + usageP run via Promise.all. The "Both fetches run in parallel; meter updates as soon as the slower of the two settles" wording is the load-bearing perf framing.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Both fetches run in parallel; meter updates as soon as the slower/);
    expect(p).toMatch(/of the two settles\./);

    expect(p).toMatch(/const sessionsP = fetch\(apiBaseUrl \+ '\/v1\/sessions'/);
    expect(p).toMatch(/const usageP = fetch\(apiBaseUrl \+ '\/v1\/usage'/);
    expect(p).toMatch(/void Promise\.all\(\[sessionsP, usageP\]\)/);
  });

  it('CRITICAL V-331 actAs header passthrough on BOTH fetches. window.driftstackActAsHeaders() spread into both /v1/sessions + /v1/usage. Drift to dropping on one side would create cross-fetch tier mismatch.', () => {
    const p = read(PAGE);

    const actAsPattern =
      /\.\.\.\(typeof window\.driftstackActAsHeaders === 'function'\s*\n\s+\? window\.driftstackActAsHeaders\(\)\s*\n\s+: \{\}\),/;

    const matches = p.match(new RegExp(actAsPattern, 'g'));
    expect(matches?.length, 'actAs spread on both fetches').toBe(2);
  });

  it("CRITICAL usage failure is NON-FATAL pinned. The wording — 'Usage failure is non-fatal — leave the cap as the SSG mock value rather than hiding it' — is the load-bearing partial-degradation contract. Drift to throwing would blank the meter on /v1/usage 5xx.", () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /\/\/ Usage failure is non-fatal — leave the cap as the SSG\s*\n\s+\/\/ mock value rather than hiding it/,
    );
  });

  it('CRITICAL meter-bar percentage uses Math.min(100, Math.max(0, ...)) clamp + .toFixed(1) precision. Drift to dropping the clamp would let a session bug (now > cap) overflow the bar element.', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /const pct = Math\.min\(100, Math\.max\(0, \(now \/ cap\) \* 100\)\);\s*\n\s+bar\.style\.width = pct\.toFixed\(1\) \+ '%'/,
    );
  });

  it('CRITICAL r.ok ? r.json() : Promise.reject pattern pinned on both fetches. The HTTP status surfaced in the rejection message lets the banner say "HTTP 503" instead of generic "network error". Drift to silent-fail would lose debugging visibility.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /\.then\(\(r\) => \(r\.ok \? r\.json\(\) : Promise\.reject\(new Error\('HTTP ' \+ r\.status\)\)\)\)/,
    );

    const okBranches = (p.match(/\.then\(\(r\) => \(r\.ok \? r\.json\(\)/g) ?? []).length;
    expect(okBranches, 'r.ok branches on both fetches').toBe(2);
  });

  it("CRITICAL Active list view-action set — 'Open' + 'Destroy' (2 actions). Drift to adding 3+ actions would crowd the row; drift to dropping 'Destroy' would force customers to the SDK for what should be a 1-click admin action.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /#detail-' \+\s*\n\s+escapeHtml\(s\.id\) \+\s*\n\s+'" class="text-sm text-glow-red hover:underline">Open<\/a>'/,
    );
    expect(p).toMatch(
      /#destroy-' \+\s*\n\s+escapeHtml\(s\.id\) \+\s*\n\s+'" class="text-sm text-red-700 hover:underline">Destroy<\/a>'/,
    );
  });

  it("CRITICAL Recent list view-action — single 'View recording' link. Matches /sessions read-only-recordings-on-dashboard convention.", () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /#replay-' \+\s*\n\s+escapeHtml\(s\.id\) \+\s*\n\s+'" class="text-sm text-glow-red hover:underline">View recording<\/a>'/,
    );
  });

  it("CRITICAL profile_id 16-char preview pinned — `profile_id.slice(0, 16)` + '…' ellipsis. Drift to longer would crowd the row; drift to shorter would lose discrimination value across multi-profile accounts. 2026-05-21 — SSR no longer renders profile_id (skeleton-only pre-hydration; c5a50f56); only the JS-side render is pinned now.", () => {
    const p = read(PAGE);

    // Inline script — JS-side render still uses the 16-char preview.
    expect(p).toMatch(/escapeHtml\(s\.profile_id\.slice\(0, 16\)\) \+ '…<\/code>'/);
  });

  it('CRITICAL recent-list-recompute uses `new Date(destroyed_at).getTime() - new Date(created_at).getTime()` formula. Drift to relying on a server-side duration_ms field would force the server to compute + ship a duration the client could recompute itself.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /const durationMs =\s*\n\s+s\.created_at && s\.destroyed_at\s*\n\s+\? new Date\(s\.destroyed_at\)\.getTime\(\) - new Date\(s\.created_at\)\.getTime\(\)\s*\n\s+: null;/,
    );
  });

  it('CRITICAL renderList() helper hides EITHER list OR empty-state but never both. The toggle-pair pattern is what makes the empty-state banner visible only when sessions.length === 0.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /if \(sessions\.length === 0\) \{\s*\n\s+ul\.classList\.add\('hidden'\);\s*\n\s+empty\.classList\.remove\('hidden'\);\s*\n\s+return;\s*\n\s+\}\s*\n\s+empty\.classList\.add\('hidden'\);\s*\n\s+ul\.classList\.remove\('hidden'\);/,
    );
  });

  it("CRITICAL zero-sessions banner pinned — 'No sessions yet — create one to get started.' Drift to dropping would leave new users staring at an empty page wondering what to do.", () => {
    const p = read(PAGE);
    expect(p).toMatch(/showBanner\('No sessions yet — create one to get started\.'\);/);
  });

  it("CRITICAL fetch-error banner pinned with HTTP-status interpolation — `Couldn't load live sessions (<status>). Showing preview data below.` Drift to silent error would lose recovery framing.", () => {
    const p = read(PAGE);
    expect(p).toMatch(/"Couldn't load live sessions \(" \+/);
    expect(p).toMatch(/\(err && err\.message \? err\.message : 'network error'\)/);
    expect(p).toMatch(/'\)\. Showing preview data below\.'/);
  });

  it('CRITICAL session billing-meter framing pinned — "Sessions are the only billing meter — you pay for concurrent caps, not duration or per-call." This is the load-bearing customer-comms framing.', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /Sessions are the only billing meter — you pay for concurrent caps,\s*\n\s+not duration or per-call\./,
    );
  });

  it('CRITICAL 429-on-cap framing pinned — "Once this hits your tier cap, new session creates return 429 with a retry-after hint. Upgrade your tier to lift the cap." Drift would leave customers unaware of the failure mode.', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /Once this hits your tier cap, new session creates return 429 with a\s*\n\s+retry-after hint\. Upgrade your tier to lift the cap\./,
    );
  });

  it("CRITICAL ADR-006 90-day retention framing pinned. The 'Recordings retained 90 days hot, archived to R2 after that' wording is the customer-facing privacy/retention contract.", () => {
    const p = read(PAGE);
    expect(p).toMatch(/Recordings retained 90 days hot, archived to R2 after that\. Admin-only/);
    expect(p).toMatch(/access initially per ADR-006/);
  });

  it('CRITICAL resolveApiBaseUrl + DashboardLayout used (no withSidebar={false}). Sessions IS sidebar-enabled — customers navigate from here to API keys + billing.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/import \{ resolveApiBaseUrl \} from '\.\.\/lib\/api-base-url'/);
    expect(p).toMatch(/const apiBaseUrl = resolveApiBaseUrl\(\)/);
    expect(p).toMatch(/<DashboardLayout title="Sessions">/);
    expect(p).not.toMatch(/<DashboardLayout title="Sessions" withSidebar=\{false\}/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/dashboard-sessions-page-v180-v186-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
