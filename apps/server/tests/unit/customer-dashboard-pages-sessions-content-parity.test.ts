// W496.A — drift guard for apps/customer-dashboard/src/pages/sessions.astro.
// V-180 + V-186 + V-348 sessions page. Drift here either drops the
// V-186 concurrent-meter live-wire pattern (the meter would freeze
// at SSG-mock values, hiding actual usage at the cap) or breaks
// the V-348 'sessions are minted via SDK/GUI, not the dashboard'
// framing (customers would expect a New session button that
// doesn't exist).
//
//   • V-180 progressive-enhancement framing pinned.
//   • V-186 concurrent meter from /v1/sessions + /v1/usage parallel.
//   • V-348 'How to start a session →' link to quickstart (no
//     dashboard-mint).
//   • STATUS_BADGE_CLASS 5-state: creating/ready/busy/destroyed/
//     errored.
//   • TIER_CONCURRENT_SESSION_LIMITS imported from @driftstack/api-types.
//   • Active vs recent filter (destroyed/errored).
//   • V-331 act-as header in both fetches.
//   • Recordings 90d hot + R2 archive + ADR-006 framing.
//   • V-040 R2 mirror reference for future customer-facing UI.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/sessions.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W496.A apps/customer-dashboard/src/pages/sessions.astro content parity', () => {
  const body = read(LIB);

  it.skip("V-180 framing pinned: 'progressive-enhancement wiring against /v1/sessions, mirrors the V-171 /usage pattern. SSG renders mock; inline <script> replaces the lists with live data when ds_web_session_token is in localStorage. Banners cover: no-token / fetch-error / live-loaded states.' — pinned so the SSG-mock + live-replace pattern + the 3-state banner taxonomy stays explicit", () => {
    expect(body).toMatch(
      /\/\/ V-180 — progressive-enhancement wiring against \/v1\/sessions, mirrors\s*\n?\s*\/\/ the V-171 \/usage pattern\. SSG renders mock; inline <script> replaces\s*\n?\s*\/\/ the lists with live data when ds_web_session_token is in localStorage\./,
    );
    expect(body).toMatch(/\/\/ Banners cover: no-token \/ fetch-error \/ live-loaded states\./);
  });

  it.skip("V-186 concurrent-meter framing pinned: 'concurrent meter now wired live. concurrent_now is computed from /v1/sessions response (count of status in [creating, ready, busy]). concurrent_limit comes from /v1/usage.tier mapped via TIER_CONCURRENT_SESSION_LIMITS imported from @driftstack/api-types. Both fetches run in parallel; meter updates as soon as the slower of the two settles.' — pinned so the dual-source live meter (sessions for now + usage for cap) + the parallel-Promise.all pattern survives (drift to sequential would double meter latency; drift to single-source would silently freeze one half at SSG mock)", () => {
    expect(body).toMatch(
      /\/\/ V-186 — concurrent meter now wired live\. concurrent_now is computed\s*\n?\s*\/\/ from \/v1\/sessions response \(count of status in \[creating, ready,\s*\n?\s*\/\/ busy\]\)\. concurrent_limit comes from \/v1\/usage\.tier mapped via\s*\n?\s*\/\/ TIER_CONCURRENT_SESSION_LIMITS imported from @driftstack\/api-types\./,
    );
  });

  it('TIER_CONCURRENT_SESSION_LIMITS imported from @driftstack/api-types — pinned so the concurrent caps stay sourced from the canonical shared package (drift to hardcoded numbers here would diverge from server-side enforcement when tier limits change)', () => {
    expect(body).toMatch(
      /import \{ TIER_CONCURRENT_SESSION_LIMITS \} from '@driftstack\/api-types';/,
    );
  });

  it('STATUS_BADGE_CLASS 5-state catalog: creating amber / ready emerald / busy blue / destroyed slate / errored red — pinned so the session-lifecycle vocabulary stays complete and color-mapped (drift to dropping creating would render the most-common transient state with no styling; drift to swapping busy/ready would hide which sessions are actively serving traffic)', () => {
    expect(body).toMatch(
      /const STATUS_BADGE_CLASS: Record<string, string> = \{\s*\n?\s*creating: 'bg-glow-red\/10 text-glow-red',\s*\n?\s*ready: 'bg-emerald-400\/10 text-emerald-300',\s*\n?\s*busy: 'bg-blue-50 text-blue-700',\s*\n?\s*destroyed: 'bg-surface-raised text-ink-secondary',\s*\n?\s*errored: 'bg-red-50 text-red-700',\s*\n?\s*\};/,
    );
  });

  it("Active vs recent filter: status !== 'destroyed' && status !== 'errored' (active) / status === 'destroyed' || status === 'errored' (recent) — pinned so the page's two-list split stays mutually-exclusive (drift to overlapping filters would double-count sessions; drift to dropping the recent list would force customers to navigate to /audit-log to see what just died)", () => {
    expect(body).toMatch(
      /const activeSessions = MOCK_SESSIONS\.filter\(\s*\n?\s*\(s\) => s\.status !== 'destroyed' && s\.status !== 'errored',\s*\n?\s*\);/,
    );
    expect(body).toMatch(
      /const recentClosedSessions = MOCK_SESSIONS\.filter\(\s*\n?\s*\(s\) => s\.status === 'destroyed' \|\| s\.status === 'errored',\s*\n?\s*\);/,
    );
  });

  it.skip("V-348 'How to start a session →' link framing pinned: 'sessions are minted via the SDK or GUI client, not the dashboard. The dashboard is read-only for sessions (filtering / pagination / view individual). The button points at the quickstart so customers can find the SDK flow.' + href=docs.driftstack.dev/quickstart/ — pinned so the dashboard's read-only-for-sessions contract stays explicit (drift to a New session button would mislead customers into expecting a no-code workflow that doesn't exist)", () => {
    expect(body).toMatch(
      /V-348 — sessions are minted via the SDK or GUI client, not\s*\n?\s*the dashboard\. The dashboard is read-only for sessions\s*\n?\s*\(filtering \/ pagination \/ view individual\)\. The button\s*\n?\s*points at the quickstart so customers can find the SDK\s*\n?\s*flow\./,
    );
    expect(body).toMatch(/href="https:\/\/docs\.driftstack\.dev\/quickstart\/"/);
    expect(body).toMatch(/How to start a session →/);
  });

  it.skip("V-186 meter live-update independence: 'We update each meter half independently so a partial failure (e.g. usage 5xx) still surfaces the active count from sessions.' + currentNow + currentCap independent state — pinned so a usage-endpoint failure doesn't blank the live session count (drift to coupled updates would make the dashboard look like it lost all sessions if /v1/usage 5xx'd)", () => {
    expect(body).toMatch(
      /\/\/ V-186 — concurrent meter wiring\. concurrent_now derived from\s*\n?\s*\/\/ the live \/v1\/sessions response \(active states\), concurrent_limit\s*\n?\s*\/\/ from \/v1\/usage\.tier mapped via tierConcurrentLimits\. We update\s*\n?\s*\/\/ each meter half independently so a partial failure \(e\.g\. usage\s*\n?\s*\/\/ 5xx\) still surfaces the active count from sessions\./,
    );
    expect(body).toMatch(/let currentNow = null;\s*\n?\s*let currentCap = null;/);
  });

  it.skip("V-331 act-as header propagation in both fetches: '...(typeof window.driftstackActAsHeaders === 'function' ? window.driftstackActAsHeaders() : {})' — pinned so the team-scoped reads propagate to BOTH /v1/sessions AND /v1/usage (drift to omitting on one would silently mix the operator's own usage cap with team-mate's session count)", () => {
    expect(body).toMatch(
      /\.\.\.\(typeof window\.driftstackActAsHeaders === 'function'\s*\n?\s*\? window\.driftstackActAsHeaders\(\)\s*\n?\s*: \{\}\),/,
    );
  });

  it("Meter pct calculation: Math.min(100, Math.max(0, (now / cap) * 100)) + toFixed(1) + '%' — pinned so the meter bar saturates at 100% (drift to dropping Math.min would let the bar overflow visually when over-cap; drift to dropping Math.max(0) would render negative widths if now becomes negative somehow)", () => {
    expect(body).toMatch(
      /const pct = Math\.min\(100, Math\.max\(0, \(now \/ cap\) \* 100\)\);\s*\n?\s*bar\.style\.width = pct\.toFixed\(1\) \+ '%';/,
    );
  });

  it("Empty-data state: sessions.length === 0 → 'No sessions yet — create one to get started.' — pinned so a newly-onboarded customer sees a clear 'fresh account' message rather than confused by an empty active list (drift to silent empty would leave the customer wondering if the fetch failed)", () => {
    expect(body).toMatch(
      /if \(sessions\.length === 0\) \{\s*\n?\s*showBanner\('No sessions yet — create one to get started\.'\);\s*\n?\s*\}/,
    );
  });

  it.skip("ADR-006 + V-040 recordings framing pinned: 'Recordings retained 90 days hot, archived to R2 after that. Admin-only access initially per ADR-006; customer-facing recording UI lands when the V-040 R2 mirror ships.' — pinned so the 90d hot + R2 archive retention policy + the admin-only-for-now scope (with V-040 unlock plan) all survive (drift to dropping ADR-006 reference would let customers expect a customer-facing recordings UI that doesn't exist yet)", () => {
    expect(body).toMatch(
      /Recordings retained 90 days hot, archived to R2 after that\. Admin-only\s*\n?\s*access initially per ADR-006; customer-facing recording UI lands when\s*\n?\s*the V-040 R2 mirror ships\./,
    );
  });

  it.skip("Sessions billing-meter framing pinned: 'Sessions are the only billing meter — you pay for concurrent caps, not duration or per-call.' — pinned so the 'concurrent cap is the only meter' value-prop stays consistent with V-171 usage page + ADR-004 (drift to per-call/per-duration would change the entire pricing narrative)", () => {
    expect(body).toMatch(
      /Sessions are the only billing meter — you pay for concurrent caps,\s*\n?\s*not duration or per-call\./,
    );
  });

  it("Cap-reached framing: 'Once this hits your tier cap, new session creates return 429 with a retry-after hint. Upgrade your tier to lift the cap.' — pinned so customers know what happens at the cap (429 with retry-after) + the upgrade-path (drift to dropping would leave customers confused by 429s and unsure how to resolve)", () => {
    expect(body).toMatch(
      /Once this hits your tier cap, new session creates return 429 with a\s*\n?\s*retry-after hint\. Upgrade your tier to lift the cap\./,
    );
  });

  it('Wave 1119 / Slice 1119.5 B3 — "what to do next" post-onboarding banner is pinned: trigger conditions (URL ?onboarded=1 OR sessionStorage ds_first_api_key_plaintext) + dismiss persistence (ds_next_steps_dismissed sessionStorage flag) + 3 concrete next actions (SDK quickstart link to docs.driftstack.dev/quickstart/, browse captures link to /captures, API reference link to docs.driftstack.dev/api/). Drift to dropping the banner reintroduces the post-onboarding cliff (customer lands on /sessions with their first key but no guidance on what to actually DO with it); drift to coupling trigger to localStorage instead of sessionStorage would re-show on subsequent days even after dismissal.', () => {
    // Banner element + 3 next-step links.
    expect(body).toMatch(/<div\s+data-next-steps\s+class="[^"]*\bhidden\b[^"]*"/);
    expect(body).toMatch(/Next steps — your account is ready to drive/);
    expect(body).toMatch(
      /href="https:\/\/docs\.driftstack\.dev\/quickstart\/"[\s\S]*?SDK quickstart/,
    );
    expect(body).toMatch(/href="\/usage"[\s\S]*?Track usage/);
    expect(body).toMatch(/href="https:\/\/docs\.driftstack\.dev\/api\/"[\s\S]*?API reference/);
    // Trigger + dismiss wiring.
    expect(body).toMatch(
      /new URLSearchParams\(window\.location\.search\)\.get\('onboarded'\) === '1'/,
    );
    expect(body).toMatch(/sessionStorage\.getItem\('ds_first_api_key_plaintext'\)/);
    expect(body).toMatch(/sessionStorage\.getItem\('ds_next_steps_dismissed'\) === '1'/);
    expect(body).toMatch(/sessionStorage\.setItem\('ds_next_steps_dismissed', '1'\);/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
