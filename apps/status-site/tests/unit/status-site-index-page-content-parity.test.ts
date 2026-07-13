// W371.C — drift guard for status-site /index page content.
// V-295c2 + V-295e + V-657. Existing status-site-index-page-
// parity test covers shape + endpoint wiring; this guard pins
// the runtime behaviour claims a customer evaluating reliability
// can verify by reading the page source:
//
//   • V-295c2 R2 fallback URL pinned + "≤60s stale" framing
//     (PUBLIC_STATUS_R2_URL → incidents-public.json).
//   • V-295e real-time SSE: EventSource against
//     /v1/status/stream with incident.created + incident.resolved
//     listeners.
//   • 60s safety-net polling interval pinned (covers extended
//     SSE outages).
//   • DOT_BG + STATE_TITLE 4-state taxonomy (operational /
//     degraded / outage / unknown).
//   • SEVERITY_BADGE + STATUS_BADGE present (companion guard
//     to W368.C which pins byte-identity with /history).
//   • "page itself stores no cookies and does not log visitors"
//     privacy claim pinned.
//   • 30-day health-probe retention claim pinned.
//   • Quick-nav: /subscribe + /history (90 days) cross-links.
//   • cache:'no-store' on both fetch + R2 fallback (always
//     fresh).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/status-site/src/pages/index.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W371.C status-site /index page content parity', () => {
  const body = read(PAGE);

  it('V-295c2 R2 fallback URL pinned (incidents-public.json + "≤60s old" framing)', () => {
    expect(body).toMatch(/PUBLIC_STATUS_R2_URL/);
    expect(body).toMatch(/r2-public\.driftstack\.dev\/status\/incidents-public\.json/);
    expect(body).toMatch(/V-295c2/);
    // The stale-snapshot user-facing copy.
    expect(body).toMatch(
      /API temporarily unreachable; showing the last cached snapshot \(≤60s old\)\./,
    );
  });

  it('V-295e real-time SSE: EventSource at /v1/status/stream with incident.created + incident.resolved listeners', () => {
    expect(body).toMatch(/V-295e — real-time SSE updates/);
    expect(body).toMatch(/new EventSource\(`\$\{API_BASE\}\/v1\/status\/stream`\)/);
    expect(body).toMatch(/sse\.addEventListener\('incident\.created'/);
    expect(body).toMatch(/sse\.addEventListener\('incident\.resolved'/);
  });

  it('60s safety-net polling interval pinned (covers extended SSE outages)', () => {
    expect(body).toMatch(/setInterval\(fetchAndRender, 60_000\)/);
    expect(body).toMatch(/safety\s*\n?\s*\/\/\s*net for clients that lose the SSE connection/);
  });

  it('DOT_BG + STATE_TITLE 4-state taxonomy pinned (operational / degraded / outage / unknown)', () => {
    for (const state of ['operational', 'degraded', 'outage', 'unknown']) {
      expect(body, `DOT_BG missing state: ${state}`).toMatch(new RegExp(`${state}:\\s*'bg-`));
      expect(body, `STATE_TITLE missing state: ${state}`).toMatch(
        new RegExp(`${state}:\\s*'[^']+',`),
      );
    }
    // The 4 user-facing titles.
    expect(body).toContain("'All systems operational'");
    expect(body).toContain("'Some systems degraded'");
    expect(body).toContain("'Major outage in progress'");
    expect(body).toContain("'Status currently unavailable'");
  });

  it('SEVERITY_BADGE (3 keys) + STATUS_BADGE (4 keys) inline-script declarations present', () => {
    for (const s of ['minor', 'major', 'outage']) {
      expect(body).toMatch(new RegExp(`${s}:\\s*\\[`));
    }
    for (const s of ['investigating', 'identified', 'monitoring', 'resolved']) {
      expect(body).toMatch(new RegExp(`${s}:\\s*\\[`));
    }
  });

  it('"page itself stores no cookies and does not log visitors" privacy claim pinned', () => {
    expect(body).toMatch(/The page itself stores\s+no cookies and does not log visitors/);
  });

  it('30-day health-probe retention claim pinned ("timestamp, success, latency")', () => {
    expect(body).toMatch(
      /Driftstack records its own\s+health-probe history \(timestamp, success, latency\) for 30 days/,
    );
    expect(body).toMatch(/this\s+data does not reference any Customer or visitor/);
  });

  it('quick-nav cross-links pinned: /subscribe + /history (90 days)', () => {
    expect(body).toMatch(/<a\s+href="\/subscribe"/);
    expect(body).toMatch(/<a\s+href="\/history"/);
    expect(body).toMatch(/Subscribe to incident emails/);
    expect(body).toMatch(/Full incident history \(90 days\)/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/status-site/src/pages/subscribe.astro'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'apps/status-site/src/pages/history.astro'))).toBe(true);
  });

  it("cache: 'no-store' on both fetch + R2 fallback (always-fresh read)", () => {
    // The fetch helper sets no-store on both branches — a future
    // "let the browser cache" optimization here would silently
    // stale the user's view post-incident.
    const occurrences = body.match(/cache: 'no-store'/g);
    expect(occurrences).not.toBeNull();
    expect(occurrences!.length).toBeGreaterThanOrEqual(2);
  });

  it('overall-state classification pinned: outage > degraded > operational (severity-first)', () => {
    expect(body).toMatch(
      /const overall = open\.some\(\(i\) => i\.severity === 'outage'\)\s*\n?\s*\?\s*'outage'\s*\n?\s*:\s*open\.length > 0\s*\n?\s*\?\s*'degraded'\s*\n?\s*:\s*'operational'/,
    );
  });

  it('"Incidents — last 30 days" window framing pinned (companion to /history 90d)', () => {
    expect(body).toMatch(/Incidents — last 30 days/);
    expect(body).toMatch(/No incidents in the last 30 days\./);
  });

  it('error state is honest, hides transport internals, and offers an in-place retry', () => {
    // The defensive-honesty claim — when the feed is unreachable
    // we don't assert outage, we assert uncertainty.
    expect(body).toMatch(/Could not load the incident feed/);
    expect(body).toMatch(/The Service may still be running normally/);
    expect(body).toMatch(/data-status-retry/);
    expect(body).toMatch(/retry\.textContent = 'Retrying…'/);
    expect(body).not.toMatch(/API \$\{apiMsg\}; R2 fallback \$\{r2Msg\}/);
  });
});
