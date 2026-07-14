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

  it('V-171 framing pinned: \'page progressively enhances from a neutral-placeholder SSG shell to real /v1/usage + /v1/usage/series fetches via inline <script>. Token absent → small banner: "Sign in to see live usage." Placeholders stay (no fabricated numbers).\' — pinned so the SSG-shell + live-replace pattern survives. 2026-06-24 — SSG no longer paints fabricated MOCK numbers; the no-token path keeps neutral placeholders, never a fabricated preview.', () => {
    expect(body).toMatch(
      /\/\/ V-171 — page progressively enhances from a neutral-placeholder SSG\s*\n?\s*\/\/ shell to real \/v1\/usage \+ \/v1\/usage\/series fetches via inline/,
    );
    expect(body).toMatch(
      /\/\/ {3}4\. Token absent → small banner: "Sign in to see live usage\."\s*\n?\s*\/\/ {6}Placeholders stay \(no fabricated numbers\)\./,
    );
  });

  it('Neutral-placeholder SSG: the fabricated deterministic mockSeries generator + series config were removed (they shipped invented sparkline magnitudes); the SSG renders PLACEHOLDER_STAT "—" tiles + a FLAT_PATH baseline until live data lands', () => {
    expect(body).not.toMatch(/function mockSeries/);
    expect(body).not.toMatch(/const SERIES_LENGTH/);
    expect(body).toMatch(/const PLACEHOLDER_STAT = '—';/);
    expect(body).toMatch(/const FLAT_PATH = /);
  });

  it('SPARK_W = 200 and SPARK_H = 48 sparkline viewBox constants — pinned so the sparkline aspect ratio (200×48, ~4:1) stays consistent across all 4 tiles (drift to different dimensions would break the visual grid alignment)', () => {
    expect(body).toMatch(/const SPARK_W = 200;\s*\n?\s*const SPARK_H = 48;/);
  });

  it("4-tile metric grid: data-stat='session_minute' / 'navigate' / 'interact' / 'captures_total' — pinned so the at-a-glance usage view stays 4-tile (drift to dropping a tile would force customers to interpret raw numbers in a deeper view; drift to renaming would break the inline script's [data-stat=…] selectors)", () => {
    expect(body).toMatch(/data-stat="session_minute"/);
    expect(body).toMatch(/data-stat="navigate"/);
    expect(body).toMatch(/data-stat="interact"/);
    expect(body).toMatch(/data-stat="captures_total"/);
  });

  it("Captures combined tile sums state_capture + screenshot_capture in live JS (totals.state_capture + totals.screenshot_capture) — pinned so the 'Captures' tile combines DOM snapshots + screenshots (drift to showing only one would hide the other from the at-a-glance view). The SSG shell renders a neutral placeholder, not fabricated MOCK totals.", () => {
    expect(body).toMatch(
      /capturesTotalEl\.textContent = \(\s*\n?\s*\(totals\.state_capture \|\| 0\) \+ \(totals\.screenshot_capture \|\| 0\)\s*\n?\s*\)\.toLocaleString\('en-US'\);/,
    );
  });

  it("V-331b act-as header propagation in usage fetches: '...(typeof window.driftstackActAsHeaders === 'function' ? window.driftstackActAsHeaders() : {})' — pinned so the team-scoped 'view as another account' flow propagates to usage reads (drift would silently show the operator's own usage when they're trying to debug a team-mate's pipeline)", () => {
    expect(body).toMatch(
      /\/\/ V-331b — act-as header for team-scoped reads\.\s*\n?\s*\.\.\.\(typeof window\.driftstackActAsHeaders === 'function'\s*\n?\s*\? window\.driftstackActAsHeaders\(\)\s*\n?\s*: \{\}\),/,
    );
  });

  it('GET /v1/usage + GET /v1/usage/series?days=30 contract: bounded Promise.all parallel reads with credentials and typed fixed-copy response classification', () => {
    expect(body).toMatch(/function readJsonResponse\(response\) \{/);
    expect(body).toMatch(/window\.driftstackResponseError\(response, body\)/);
    expect(body).toMatch(
      /const summaryPromise = boundedFetch\(apiBaseUrl \+ '\/v1\/usage', \{\s*\n?\s*headers,\s*\n?\s*credentials: 'include',\s*\n?\s*\}\)\.then\(readJsonResponse\);/,
    );
    expect(body).toMatch(
      /const initialSeriesPromise = boundedFetch\(apiBaseUrl \+ '\/v1\/usage\/series\?days=30', \{\s*\n?\s*headers,\s*\n?\s*credentials: 'include',\s*\n?\s*\}\)\.then\(readJsonResponse\);/,
    );
    expect(body).toMatch(/Promise\.all\(\[summaryPromise, initialSeriesPromise\]\)/);
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

  it("No-token state: !token → 'Sign in to see live usage.' + early bail (neutral placeholders painted via SSG — no fabricated numbers) — pinned so unauthenticated visitors see a clean shell + a clear sign-in prompt", () => {
    expect(body).toMatch(
      /if \(!token\) \{\s*\n?\s*showBanner\('Sign in to see live usage\.'\);\s*\n?\s*if \(typeof window\.dashboardHydrated === 'function'\) window\.dashboardHydrated\(\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
  });

  it('Fetch-failure banner uses the shared fixed request mapper while neutral placeholders stay — remote diagnostics and raw HTTP jargon are never reflected', () => {
    expect(body).toMatch(
      /"Couldn't load live usage \(" \+\s*\n?\s*window\.driftstackRequestErrorMessage\(err, "Couldn't load live usage\. Try again\."\) \+\s*\n?\s*'\)\.',/,
    );
    expect(body).not.toMatch(/summary HTTP|series HTTP/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
