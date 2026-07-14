// W363.B — drift guard for customer-dashboard /usage page
// content. V-171 progressive-enhancement against /v1/usage +
// /v1/usage/series. Existing tests cover endpoints + sparkline
// keys; this guard pins:
//
//   • Live-replaceable data-stat keys cover UsageRecordTypeSchema
//     (the metric set the server returns).
//   • GET /v1/usage + GET /v1/usage/series?days=30 wired + both
//     registered server-side (admin.ts hosts the customer route
//     too — it's a quirk of the routing layout).
//   • ADR-004 framing pinned: "None of these counters drive
//     billing. Concurrent caps are the only meter." This is the
//     economic claim customers integrate against.
//   • Empty-data banner ("Live usage loaded. No activity in the
//     current period yet") pinned — load-bearing UX for the
//     usage_records-writer-deferred caveat in V-014/V-015.
//   • V-014/V-015 caveat ("usage_records writers aren't wired,
//     /v1/usage returns zeros") pinned — load-bearing breadcrumb
//     for the deferred-slice tracking (#72).
//   • V-331b act-as-headers integration (typeof
//     window.driftstackActAsHeaders === 'function') pinned for
//     team-scoped reads.
//   • localStorage key ds_web_session_token.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageRecordTypeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/usage.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W363.B customer-dashboard /usage page content parity', () => {
  const body = read(PAGE);
  const route = read(ROUTE);
  const metrics = new Set<string>(
    (UsageRecordTypeSchema._def as { values: readonly string[] }).values,
  );

  it('live-replaceable data-stat keys cover UsageRecordTypeSchema (5 of the 6 are surfaced)', () => {
    // The page exposes 5 stats: session_minute / navigate /
    // interact / screenshot_capture / state_capture. 'wait' is
    // recorded server-side but not displayed (low-information
    // metric per V-171 page-scope decision). Pin the surfaced
    // keys; the server-side enum can grow without breaking this.
    for (const key of [
      'session_minute',
      'navigate',
      'interact',
      'screenshot_capture',
      'state_capture',
    ]) {
      expect(metrics.has(key), `metric missing from UsageRecordTypeSchema: ${key}`).toBe(true);
      expect(body).toMatch(new RegExp(`data-stat="${key}"`));
    }
  });

  it('GET /v1/usage + GET /v1/usage/series?days=30 both wired client + server', () => {
    expect(body).toContain("'/v1/usage'");
    expect(body).toContain('/v1/usage/series?days=30');
    expect(route).toContain("'/v1/usage'");
    expect(route).toContain("'/v1/usage/series'");
  });

  it('ADR-004 framing pinned: concurrent caps are the only meter (counters non-billing)', () => {
    expect(body).toMatch(
      /None of these counters drive billing\. Concurrent caps are the only meter\s+per ADR-004/,
    );
    expect(body).toMatch(
      /None of these\s+are billed individually — concurrent cap is the only meter/,
    );
  });

  it('empty-data banner pinned ("Live usage loaded. No activity in the current period yet")', () => {
    expect(body).toMatch(
      /Live usage loaded\. No activity in the current period yet — counts will populate as you run sessions/,
    );
  });

  it("V-014/V-015 caveat pinned (usage_records writers aren't wired → zeros)", () => {
    expect(body).toMatch(/usage_records writers aren't wired \(V-014\/V-015 amendment\)/);
    expect(body).toMatch(/\/v1\/usage \+ \/v1\/usage\/series return zeros for everyone/);
    expect(body).toMatch(
      /The\s*\n?\s*\/\/\s*fetch path is real; the data is empty until writers land/,
    );
  });

  it('V-331b act-as-headers integration pinned (team-scoped reads)', () => {
    expect(body).toMatch(/V-331b — act-as header for team-scoped reads/);
    expect(body).toMatch(
      /typeof window\.driftstackActAsHeaders === 'function'\s*\?\s*window\.driftstackActAsHeaders\(\)/,
    );
  });

  it('localStorage key ds_web_session_token (customer-dashboard convention)', () => {
    expect(body).toContain('ds_web_session_token');
    expect(body).toMatch(/try \{\s*token = localStorage\.getItem\('ds_web_session_token'\)/);
    expect(body).toMatch(/catch \{\s*token = '';/);
  });

  it('keeps chart-window controls inert until auth and exposes symmetric per-read busy state', () => {
    expect(body.match(/title="Available after sign-in\."/g)).toHaveLength(3);
    expect(body).toMatch(/button\.disabled = active;/);
    expect(body).toMatch(/button\.setAttribute\('aria-disabled', active \? 'true' : 'false'\)/);
    expect(body).toMatch(/button\.disabled = false;/);
    expect(body).toContain("button.setAttribute('aria-disabled', 'false')");
    expect(body).toMatch(
      /if \(typeof window\.dashboardHydrated === 'function'\) window\.dashboardHydrated\(\);\s*return;/,
    );
  });

  it('combined captures tile sums state_capture + screenshot_capture in the live handler', () => {
    // The Captures tile is intentionally a derived sum, not a
    // schema metric. The derivation must keep matching the
    // schema's two capture-kind keys; if the schema renames
    // either, the tile renders NaN. (The SSG shell renders a
    // neutral placeholder — no fabricated MOCK totals — so only the
    // live-handler derivation is pinned now.)
    expect(body).toMatch(
      /\(totals\.state_capture \|\| 0\)\s*\+\s*\(totals\.screenshot_capture \|\| 0\)/,
    );
  });

  it('runaway-script framing pinned: 10× spike in navigates as the surface use-case', () => {
    // Customer-facing copy that explains why we surface the
    // counters at all (operational visibility, not billing).
    expect(body).toMatch(/a sudden 10× spike in navigates may indicate a runaway script/);
  });

  it('tier label renders the friendly plan name, not the raw tier id (TIER_DISPLAY_NAMES mapping mirrors index/billing)', () => {
    // Import + pass into the inline script.
    expect(body).toMatch(
      /import \{ TIER_DISPLAY_NAMES \} from '\.\.\/data\/tier-display-names\.ts';/,
    );
    expect(body).toMatch(/tierDisplayNames: TIER_DISPLAY_NAMES/);
    // Both the tier span + the period string use the mapped name, never
    // the raw summary.tier id (e.g. "Personal", not "solo_manual").
    expect(body).toMatch(/function tierLabel\(t\)/);
    expect(body).toMatch(/const tierName = tierLabel\(summary\.tier\)/);
    expect(body).toMatch(/tierEl\.textContent = tierName/);
    expect(body).toMatch(/' · ' \+ tierName \+ ' tier'/);
    // The raw verbatim render is gone.
    expect(body).not.toMatch(/tierEl\.textContent = summary\.tier;/);
    expect(body).not.toMatch(/' · ' \+ summary\.tier \+ ' tier'/);
  });
});
