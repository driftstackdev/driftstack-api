// W754 — customer-dashboard /usage.astro V-171 (live-fetch) +
// V-014/V-015 (usage_records writer status) parity. Eightieth in the
// cross-SDK drift-guard series.
//
// /usage is the dashboard read-only view of the "we count everything,
// charge for nothing-but-concurrent" ADR-004 framing. Drift to the
// "None of these counters drive billing. Concurrent caps are the only
// meter" framing would let pricing-page copy diverge from dashboard
// copy.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/usage.astro');

describe('W754 dashboard /usage page V-171 + V-014/V-015 + ADR-004 parity', () => {
  it('usage.astro file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL V-171 anchor framing pinned. The "page progressively enhances from a neutral-placeholder SSG shell to real /v1/usage + /v1/usage/series fetches via inline <script>" wording is the canonical V-171 explanation. (2026-06-24 — SSG no longer paints fabricated MOCK_USAGE_SUMMARY numbers.)', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-171 — page progressively enhances from a neutral-placeholder SSG/);
    expect(p).toMatch(/real \/v1\/usage \+ \/v1\/usage\/series fetches via inline/);
  });

  it('CRITICAL 5-step render-path framing pinned. The numbered (1) Astro neutral-placeholder shell → (2) DOMContentLoaded → (3) token-present fetch → (4) token-absent banner → (5) fetch-fails banner sequence is the load-bearing progressive-enhancement explanation.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/1\. Astro emits the static HTML with neutral placeholders/);
    expect(p).toMatch(/2\. <script is:inline> runs on DOMContentLoaded, reads/);
    expect(p).toMatch(/3\. Token present → fetch totals \(\/v1\/usage\) \+ series/);
    expect(p).toMatch(/4\. Token absent → small banner: "Sign in to see live usage\."/);
    expect(p).toMatch(/5\. Fetch fails \(network \/ 401 \/ 5xx\) → small banner/);
  });

  it("CRITICAL ADR-004 concurrent-only-meter framing pinned. The 'None of these are billed individually — concurrent cap is the only meter' header copy + 'None of these counters drive billing. Concurrent caps are the only meter per ADR-004' footer copy is the load-bearing customer-pricing communication.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /None of these\s*\n\s+are billed individually — concurrent cap is the only meter\./,
    );
    expect(p).toMatch(
      /None of these counters drive billing\. Concurrent caps are the only meter\s*\n\s+per ADR-004\./,
    );
  });

  it("CRITICAL pipeline-regression-detection framing pinned — 'We surface counts so you can spot pipeline regressions — e.g. a sudden 10× spike in navigates may indicate a runaway script.' Drift would lose the 'why surface these' framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /We surface counts so you can spot pipeline regressions —\s*\n\s+e\.g\. a sudden 10× spike in navigates may indicate a runaway script\./,
    );
  });

  it("CRITICAL V-014/V-015 usage_records-not-yet-wired framing pinned. The 'Today usage_records writers aren\\'t wired (V-014/V-015 amendment), so /v1/usage + /v1/usage/series return zeros for everyone. The fetch path is real; the data is empty until writers land.' framing is what tells engineers WHY this page shows zeros — and that the fetch path is production-ready.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Today usage_records writers aren't wired \(V-014\/V-015 amendment\),/);
    expect(p).toMatch(/so \/v1\/usage \+ \/v1\/usage\/series return zeros for everyone\. The/);
    expect(p).toMatch(/fetch path is real; the data is empty until writers land\./);
  });

  it('CRITICAL W192 helper cross-reference pinned. The "Config: PUBLIC_API_BASE_URL (Astro public env). See `src/lib/api-base-url.ts` — dev falls back to localhost:3000; prod builds fail fast when the env var is unset (W192)" wording threads the cross-page helper anchor.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Config: PUBLIC_API_BASE_URL \(Astro public env\)\. See/);
    expect(p).toMatch(/`src\/lib\/api-base-url\.ts` — dev falls back to localhost:3000;/);
    expect(p).toMatch(/prod builds fail fast when the env var is unset \(W192\)/);
  });

  it('CRITICAL deadline-bound parallel Promise.all([/v1/usage, /v1/usage/series?days=30]) with stale-chart refusal pinned', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /const summaryPromise = boundedFetch\(apiBaseUrl \+ '\/v1\/usage', \{\s*\n\s+headers,\s*\n\s+credentials: 'include',\s*\n\s+\}\)\.then\(readJsonResponse\);/,
    );
    expect(p).toMatch(
      /const initialSeriesPromise = boundedFetch\(apiBaseUrl \+ '\/v1\/usage\/series\?days=30', \{\s*\n\s+headers,\s*\n\s+credentials: 'include',\s*\n\s+\}\)\.then\(readJsonResponse\);/,
    );
    expect(p).toMatch(/const USAGE_TIMEOUT_MS = 15_000;/);
    expect(p).toMatch(
      /return window\.driftstackFetchWithDeadline\(url, init, USAGE_TIMEOUT_MS, controller\);/,
    );
    expect(p).toMatch(/Promise\.all\(\[summaryPromise, initialSeriesPromise\]\)/);
    expect(p).toMatch(/if \(chartRequestController\) chartRequestController\.abort\(\);/);
    expect(p).toMatch(/const version = \+\+chartRequestVersion;/);
    expect(p).toMatch(/if \(version === chartRequestVersion\) renderDailyChart\(series\);/);
    expect(p).not.toMatch(/fetch\(apiBaseUrl \+ '\/v1\/usage/);
  });

  it('CRITICAL 4-tile metric set pinned — session_minute / navigate / interact / captures_total. The data-stat attributes are how the inline script targets each tile.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/data-stat="session_minute"/);
    expect(p).toMatch(/data-stat="navigate"/);
    expect(p).toMatch(/data-stat="interact"/);
    expect(p).toMatch(/data-stat="captures_total"/);
  });

  it('CRITICAL Captures-combined-tile sums state_capture + screenshot_capture in the live handler. Drift to splitting into 2 tiles would force a 5-tile grid that overflows the responsive breakpoint. (The SSG shell renders a neutral placeholder — no fabricated MOCK totals.)', () => {
    const p = read(PAGE);

    // Inline-script (live) version.
    expect(p).toMatch(
      /capturesTotalEl\.textContent = \(\s*\n\s+\(totals\.state_capture \|\| 0\) \+ \(totals\.screenshot_capture \|\| 0\)\s*\n\s+\)\.toLocaleString\('en-US'\)/,
    );
  });

  it('CRITICAL Capture breakdown by-kind section pinned — Screenshots + DOM snapshots. The 2-row dl threads the same totals as the combined tile.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/<dt class="text-sm text-tk-ink-3">Screenshots<\/dt>/);
    expect(p).toMatch(/<dt class="text-sm text-tk-ink-3">DOM snapshots<\/dt>/);
  });

  it('CRITICAL neutral-placeholder SSG framing pinned. 2026-06-24 — the fabricated deterministic sin()+seed mockSeries generator was removed (it shipped invented numbers to every customer); the SSG sparklines paint a flat baseline (FLAT_PATH) until the live series replaces them, and tiles render an em-dash placeholder.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/A flat\s*\n\/\/ baseline path keeps the sparkline SVGs from collapsing/);
    expect(p).toMatch(/const PLACEHOLDER_STAT = '—';/);
    expect(p).toMatch(/const FLAT_PATH = /);
    expect(p).not.toMatch(/function mockSeries/);
  });

  it('CRITICAL sparkline SVG dimensions pinned — SPARK_W = 200 + SPARK_H = 48. Drift to different dimensions would shift the tile layout breakpoints.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/const SPARK_W = 200;/);
    expect(p).toMatch(/const SPARK_H = 48;/);
  });

  it('CRITICAL live sparkline path generator — `M x.toFixed(1) y.toFixed(1)` then `L x y` for subsequent points. Decimal-1 precision keeps the SVG path string small + visually identical to integer. (The SSG frontmatter generator was removed; only the live-handler version remains.)', () => {
    const p = read(PAGE);

    // Inline-script (live) version.
    expect(p).toMatch(
      /return \(i === 0 \? 'M' : 'L'\) \+ ' ' \+ x\.toFixed\(1\) \+ ' ' \+ y\.toFixed\(1\)/,
    );
  });

  it("CRITICAL V-331b act-as header passthrough pinned. The 'V-331b — act-as header for team-scoped reads' anchor threads team-RBAC into the usage fetch.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\/\/ V-331b — act-as header for team-scoped reads\./);
    expect(p).toMatch(
      /\.\.\.\(typeof window\.driftstackActAsHeaders === 'function'\s*\n\s+\? window\.driftstackActAsHeaders\(\)\s*\n\s+: \{\}\),/,
    );
  });

  it("CRITICAL all-zero state framing pinned. The 'Empty-data state — let the user know real data is loaded but everything is zero (writers not yet wired)' inline comment + 'Live usage loaded. No activity in the current period yet — counts will populate as you run sessions.' banner is what differentiates 'fetch worked but empty' from 'fetch failed'.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\/\/ Empty-data state — let the user know real data is loaded/);
    expect(p).toMatch(/\/\/ but everything is zero \(writers not yet wired\)\./);
    expect(p).toMatch(
      /'Live usage loaded\. No activity in the current period yet — counts will populate as you run sessions\.'/,
    );
  });

  it("CRITICAL no-token banner pinned — 'Sign in to see live usage.' (No 'preview data below' claim: the SSG shell shows neutral placeholders, not fabricated numbers.)", () => {
    const p = read(PAGE);
    expect(p).toMatch(/showBanner\('Sign in to see live usage\.'\);/);
    expect(p).toMatch(
      /if \(typeof window\.dashboardHydrated === 'function'\) window\.dashboardHydrated\(\);\s*\n\s+return;/,
    );
    expect(p).not.toMatch(/Showing preview data below/);
  });

  it("CRITICAL fetch-error banner uses the shared stable request classifier with actionable fallback. Drift to silent-fail would lose debugging visibility. (No 'preview data below' claim — placeholders, not fabricated numbers.)", () => {
    const p = read(PAGE);

    expect(p).toMatch(/"Couldn't load live usage \(" \+/);
    expect(p).toMatch(
      /window\.driftstackRequestErrorMessage\(err, "Couldn't load live usage\. Try again\."\)/,
    );
    expect(p).toMatch(/'\)\.',/);
  });

  it('CRITICAL non-OK summary/series responses become shared structured errors, while chart failures retain their own user-facing path.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Promise\.reject\(window\.driftstackResponseError\(response, body\)\)/);
    expect(p).toMatch(
      /if \(initialChartVersion === chartRequestVersion\) showChartLoadFailure\(\);/,
    );
    expect(p).toMatch(/showBanner\("Couldn't load daily activity\. Try again\."\);/);
    expect(p).not.toMatch(/new Error\('(?:summary|series) HTTP /);
  });

  it('CRITICAL series buckets default to [] when undefined — `series.buckets || []`. Drift to bare access would NPE on missing buckets.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/const buckets = series\.buckets \|\| \[\];/);
  });

  it('CRITICAL series-by-metric extraction handles missing b.totals — `(b.totals && b.totals.<key>) || 0`. Drift to bare access would NPE on a partial bucket.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/buckets\.map\(\(b\) => \(b\.totals && b\.totals\.session_minute\) \|\| 0\)/);
    expect(p).toMatch(/buckets\.map\(\(b\) => \(b\.totals && b\.totals\.navigate\) \|\| 0\)/);
    expect(p).toMatch(/buckets\.map\(\(b\) => \(b\.totals && b\.totals\.interact\) \|\| 0\)/);
  });

  it('CRITICAL toLocaleString("en-US") number formatting pinned in the live handler. Drift to bare toString() would lose thousands-separator commas; drift to a different locale would change comma-vs-period. (SSG tiles render neutral placeholders, so the localizers now live only in the live-replace path + the rate-limit card.)', () => {
    const p = read(PAGE);

    const localizers = (p.match(/\.toLocaleString\('en-US'\)/g) ?? []).length;
    expect(localizers).toBeGreaterThanOrEqual(3);
  });

  it('CRITICAL live period + tier display pinned — `<start> → <end> · <tier> tier`. Drift to a different separator would clash with the rest of the dashboard pages. (The SSG shell renders a neutral "<placeholder> tier · current billing period" line until live data replaces it.)', () => {
    const p = read(PAGE);

    // Inline-script (live) version. The tier segment now renders the human
    // plan name via tierLabel(summary.tier) — TIER_DISPLAY_NAMES maps the
    // backend id (e.g. "api_builder") to "API Builder", matching index/billing
    // — instead of the raw id. The `<start> → <end> · <tier> tier` shape +
    // ` · ` separator + ` tier` suffix are unchanged.
    expect(p).toMatch(/const tierName = tierLabel\(summary\.tier\);/);
    expect(p).toMatch(
      /periodEl\.textContent = start \+ ' → ' \+ end \+ ' · ' \+ tierName \+ ' tier';/,
    );
  });

  it('CRITICAL resolveApiBaseUrl + DashboardLayout used. /usage IS sidebar-enabled.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/import \{ resolveApiBaseUrl \} from '\.\.\/lib\/api-base-url'/);
    expect(p).toMatch(/const apiBaseUrl = resolveApiBaseUrl\(\)/);
    expect(p).toMatch(/<DashboardLayout title="Usage">/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/dashboard-usage-page-v171-v014-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
