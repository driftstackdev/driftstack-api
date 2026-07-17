// W368.C — drift guard for status-site /history page content.
// V-657. Existing status-site-history-page-parity test covers
// route + endpoint wiring; this guard pins the content claims a
// customer reads when evaluating reliability post-incident:
//
//   • 90-day window framing pinned (vs the home page's 30-day
//     active/resolved split).
//   • SEVERITY_BADGE in inline-script byte-identical to the
//     /index page (home + history must never show different
//     colours for the same severity).
//   • STATUS_BADGE byte-identical to the /index page.
//   • Source-URL claim pinned: GET /v1/status/incidents?window=90d
//     against PUBLIC_API_BASE_URL.
//   • R2-snapshot fallback URL pinned (incidents-public.json).
//   • "No cookies, no visitor tracking" claim pinned — load-
//     bearing privacy claim for the public status surface.
//   • Cross-link to / (home) for "what's happening RIGHT NOW".

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/status-site/src/pages/history.astro');
const INDEX = resolve(REPO_ROOT, 'apps/status-site/src/pages/index.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// Normalise whitespace for byte-identical comparison.
function extractBadge(src: string, name: string): string {
  const m = src.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\};`));
  if (m === null) throw new Error(`${name} literal not found`);
  return m[1]!.replace(/\s+/g, ' ').trim();
}

describe('W368.C status-site /history page content parity', () => {
  const body = read(PAGE);
  const index = read(INDEX);

  it('90-day window framing pinned (vs home page 30-day active/resolved split)', () => {
    expect(body).toMatch(/Incident history — 90-day resolved window/);
    expect(body).toMatch(
      /Resolved incidents started in the last 90 days, plus every incident that\s+is still open regardless of age/,
    );
    expect(body).toMatch(
      /<a href="\/" class="text-oxblood-700 underline">live status page<\/a> shows\s+every active incident plus the last 30 days of resolved history/,
    );
  });

  it('SEVERITY_BADGE byte-identical to /index (no divergent colour maps between home + history)', () => {
    expect(extractBadge(body, 'SEVERITY_BADGE')).toEqual(extractBadge(index, 'SEVERITY_BADGE'));
  });

  it('STATUS_BADGE byte-identical to /index', () => {
    expect(extractBadge(body, 'STATUS_BADGE')).toEqual(extractBadge(index, 'STATUS_BADGE'));
  });

  it('source-URL claim pinned: GET /v1/status/incidents?window=90d against PUBLIC_API_BASE_URL', () => {
    expect(body).toMatch(/\/v1\/status\/incidents\?window=90d/);
    expect(body).toMatch(/import\.meta\.env\.PUBLIC_API_BASE_URL/);
  });

  it('R2-snapshot fallback URL pinned (incidents-public.json public bucket)', () => {
    expect(body).toMatch(/PUBLIC_STATUS_R2_URL/);
    expect(body).toMatch(/r2-public\.driftstack\.dev\/status\/incidents-public\.json/);
    expect(body).toMatch(/Falls back to the R2 snapshot at/);
  });

  it('"No cookies, no visitor tracking" privacy claim pinned (public status surface)', () => {
    expect(body).toMatch(/No cookies, no visitor tracking/);
  });

  it('cross-link to / (live status home) pinned', () => {
    expect(body).toMatch(/<a href="\/" class="text-oxblood-700 underline">live status page<\/a>/);
    expect(existsSync(INDEX)).toBe(true);
  });

  it('bounded-history truth and explicit truncation are pinned', () => {
    expect(body).toMatch(/the page\s+says explicitly when the bounded public feed is truncated/);
    expect(body).toContain('if (feed.truncated)');
    expect(body).toContain('Showing ${incidents.length} of ${feed.total} incidents.');
    expect(body).not.toMatch(/listed indefinitely|complete record/);
  });

  it('V-657 intent comment pinned (historical record for trust-evaluation use)', () => {
    expect(body).toMatch(/V-657 — incident history view/);
    expect(body).toMatch(/historical record for trust-evaluation use/);
  });

  it('fetch failure offers an in-place retry with immediate busy feedback', () => {
    expect(body).toMatch(/data-history-retry/);
    expect(body).toMatch(/retry\.disabled = true/);
    expect(body).toMatch(/retry\.textContent = 'Retrying…'/);
    expect(body).toMatch(/render\(\);/);
  });
});
