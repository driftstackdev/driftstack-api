// W495.A — drift guard for apps/customer-dashboard/src/pages/usage.astro.
// V-171 usage page with progressive-enhancement against /v1/usage +
// /v1/usage/series. Drift here either drops the 'concurrent cap is
// the only meter' framing (customers would think they're being
// billed per-event by the dashboard) or breaks the deterministic
// mockSeries pattern (sparklines would flicker between page loads,
// hiding real-data regressions during scaffolding).
//
//   • V-171 progressive-enhancement framing pinned.
//   • mockSeries deterministic sin-based generator (no Math.random).
//   • SPARK_W=200 / SPARK_H=48 sparkline viewBox constants.
//   • 4-tile metric grid: session_minute / navigate / interact /
//     captures_total.
//   • V-331b act-as header propagation in fetches.
//   • Empty-data state: 'No activity in the current period yet'
//     banner.
//   • Tax/billing framing: 'None of these counters drive billing.
//     Concurrent caps are the only meter per ADR-004.'

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/usage.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W495.A apps/customer-dashboard/src/pages/usage.astro content parity', () => {
  const body = read(LIB);

  it('V-171 framing pinned: \'page progressively enhances from mock-rendered SSG to real /v1/usage + /v1/usage/series fetches via inline <script>. Token absent → small banner: "Sign in to see live usage." Mock data stays visible as preview.\' — pinned so the dual SSG-mock + live-replace pattern + the no-token-keeps-preview behavior survive (drift to blank-on-no-token would lose the preview value-prop)', () => {
    expect(body).toMatch(
      /\/\/ V-171 — page progressively enhances from mock-rendered SSG to\s*\n?\s*\/\/ real \/v1\/usage \+ \/v1\/usage\/series fetches via inline <script>\./,
    );
    expect(body).toMatch(
      /\/\/ {3}4\. Token absent → small banner: "Sign in to see live usage\."\s*\n?\s*\/\/ {6}Mock data stays visible as preview\./,
    );
  });

  it('Deterministic mockSeries generator: Math.round(seedBase + Math.sin(i * 0.6) * (seedBase * 0.4) + i * (seedBase * 0.02)) + Math.max(0, v) — pinned so the sparkline render stays stable across page loads (drift to Math.random would flicker, hiding real-data integration regressions; drift to dropping Math.max(0) would render negative values on the y-axis)', () => {
    expect(body).toMatch(
      /function mockSeries\(seedBase: number, length: number\): number\[\] \{\s*\n?\s*const out: number\[\] = \[\];\s*\n?\s*for \(let i = 0; i < length; i \+= 1\) \{\s*\n?\s*const v = Math\.round\(seedBase \+ Math\.sin\(i \* 0\.6\) \* \(seedBase \* 0\.4\) \+ i \* \(seedBase \* 0\.02\)\);\s*\n?\s*out\.push\(Math\.max\(0, v\)\);/,
    );
  });

  it('SPARK_W = 200 and SPARK_H = 48 sparkline viewBox constants — pinned so the sparkline aspect ratio (200×48, ~4:1) stays consistent across all 4 tiles (drift to different dimensions would break the visual grid alignment)', () => {
    expect(body).toMatch(/const SPARK_W = 200;\s*\n?\s*const SPARK_H = 48;/);
  });

  it('SERIES_LENGTH = 30 mock series buckets + 4-metric seed config: navigates 40 / interacts 180 / captures 12 / session_minutes 15 — pinned so the magnitudes match expected real-world ratios (interacts >> navigates >> captures for a typical session) — drift to equal seeds would create unrealistic uniform-looking sparklines', () => {
    expect(body).toMatch(
      /const SERIES_LENGTH = 30;\s*\n?\s*const series = \{\s*\n?\s*navigates: mockSeries\(40, SERIES_LENGTH\),\s*\n?\s*interacts: mockSeries\(180, SERIES_LENGTH\),\s*\n?\s*captures: mockSeries\(12, SERIES_LENGTH\),\s*\n?\s*session_minutes: mockSeries\(15, SERIES_LENGTH\),\s*\n?\s*\};/,
    );
  });

  it("4-tile metric grid: data-stat='session_minute' / 'navigate' / 'interact' / 'captures_total' — pinned so the at-a-glance usage view stays 4-tile (drift to dropping a tile would force customers to interpret raw numbers in a deeper view; drift to renaming would break the inline script's [data-stat=…] selectors)", () => {
    expect(body).toMatch(/data-stat="session_minute"/);
    expect(body).toMatch(/data-stat="navigate"/);
    expect(body).toMatch(/data-stat="interact"/);
    expect(body).toMatch(/data-stat="captures_total"/);
  });

  it("Captures combined tile sums state_capture + screenshot_capture both in SSG (MOCK + ' + ' for tile) AND in live JS (totals.state_capture + totals.screenshot_capture) — pinned so the 'Captures' tile combines DOM snapshots + screenshots (drift to showing only one would hide the other from the at-a-glance view)", () => {
    expect(body).toMatch(
      /MOCK_USAGE_SUMMARY\.totals\.state_capture \+\s*\n?\s*MOCK_USAGE_SUMMARY\.totals\.screenshot_capture/,
    );
    expect(body).toMatch(
      /capturesTotalEl\.textContent = \(\s*\n?\s*\(totals\.state_capture \|\| 0\) \+ \(totals\.screenshot_capture \|\| 0\)\s*\n?\s*\)\.toLocaleString\('en-US'\);/,
    );
  });

  it("V-331b act-as header propagation in usage fetches: '...(typeof window.driftstackActAsHeaders === 'function' ? window.driftstackActAsHeaders() : {})' — pinned so the team-scoped 'view as another account' flow propagates to usage reads (drift would silently show the operator's own usage when they're trying to debug a team-mate's pipeline)", () => {
    expect(body).toMatch(
      /\/\/ V-331b — act-as header for team-scoped reads\.\s*\n?\s*\.\.\.\(typeof window\.driftstackActAsHeaders === 'function'\s*\n?\s*\? window\.driftstackActAsHeaders\(\)\s*\n?\s*: \{\}\),/,
    );
  });

  it("GET /v1/usage + GET /v1/usage/series?days=30 contract: Promise.all parallel fetch with credentials:'include' + r.ok-or-reject pattern — pinned so the summary + series fetches stay parallel (drift to sequential would double the latency on cold loads) and the credentials-include enables the dual-cookie session pattern", () => {
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/usage', \{ headers, credentials: 'include' \}\)\.then\(\(r\) =>\s*\n?\s*r\.ok \? r\.json\(\) : Promise\.reject\(new Error\('summary HTTP ' \+ r\.status\)\),\s*\n?\s*\),/,
    );
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/usage\/series\?days=30', \{ headers, credentials: 'include' \}\)\.then\(\s*\n?\s*\(r\) => \(r\.ok \? r\.json\(\) : Promise\.reject\(new Error\('series HTTP ' \+ r\.status\)\)\),\s*\n?\s*\),/,
    );
  });

  it("Empty-data state: allZero → 'Live usage loaded. No activity in the current period yet — counts will populate as you run sessions.' — pinned so customers with newly-onboarded accounts (zero usage) see a positive 'data is loaded' message rather than confused by all-zero tiles (drift to silent zero would leave customers uncertain whether the fetch failed or they really have no activity)", () => {
    expect(body).toMatch(
      /const allZero = Object\.values\(totals\)\.every\(\(v\) => !v \|\| v === 0\);\s*\n?\s*if \(allZero\) \{\s*\n?\s*showBanner\(\s*\n?\s*'Live usage loaded\. No activity in the current period yet — counts will populate as you run sessions\.',\s*\n?\s*\);/,
    );
  });

  it("ADR-004 framing pinned: 'None of these counters drive billing. Concurrent caps are the only meter per ADR-004. We surface counts so you can spot pipeline regressions — e.g. a sudden 10× spike in navigates may indicate a runaway script.' — pinned so the 'no per-event billing' contract stays explicit (drift to dropping ADR-004 reference would let customers assume they're being charged per navigate/capture; drift to dropping the regression-spotting framing would lose the 'why' for surfacing these counters at all)", () => {
    expect(body).toMatch(
      /None of these counters drive billing\. Concurrent caps are the only meter\s*\n?\s*per ADR-004\. We surface counts so you can spot pipeline regressions —\s*\n?\s*e\.g\. a sudden 10× spike in navigates may indicate a runaway script\./,
    );
  });

  it("No-token preview: !token → 'Sign in to see live usage. Showing preview data below.' + early bail (mock data already painted via SSG) — pinned so unauthenticated visitors still see meaningful UI (the mock-data preview) rather than blank cards, with a clear sign-in prompt (matches the V-183 billing-page pattern)", () => {
    expect(body).toMatch(
      /if \(!token\) \{\s*\n?\s*showBanner\('Sign in to see live usage\. Showing preview data below\.'\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
  });

  it("Fetch-failure banner: \"Couldn't load live usage (\" + msg + '). Showing preview data below.' — pinned so a network/401/5xx error keeps the SSG-mock visible underneath while surfacing the failure reason (drift to hiding mock would leave the page empty on transient errors)", () => {
    expect(body).toMatch(
      /showBanner\(\s*\n?\s*"Couldn't load live usage \(" \+\s*\n?\s*\(err && err\.message \? err\.message : 'network error'\) \+\s*\n?\s*'\)\. Showing preview data below\.',\s*\n?\s*\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
