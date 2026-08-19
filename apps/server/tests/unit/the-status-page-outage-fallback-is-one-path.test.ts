// V-902 — the status page's outage fallback depends on two files agreeing on
// one object key, and nothing tied them together.
//
// The server writes the public snapshot to `STATUS_SNAPSHOT_KEY` in
// `status-snapshot.ts`, on the same 60s poller as the health probe. The
// status-site frontend fetches `R2_FALLBACK_URL` when the live API call
// rejects. If those two paths disagree the fetch 404s, the page throws
// `status-feed-unavailable`, and the status page is down at exactly the moment
// it exists for.
//
// BOTH SIDES ARE ALREADY PINNED — and that is the problem this file addresses.
// `status-snapshot-r2-fallback-cross-source-invariant` pins the server constant;
// `status-site-layout-and-pages-content-parity` pins the frontend URL including
// its default. Two independent pins of the same literal. Change the server key
// and update its pin, and the frontend pin still passes against the old path:
// each half is internally consistent and the system is broken. That is the
// two-arrays-supposed-to-be-identical trap that `agent-decomposer-deterministic`
// solved by exporting one and importing it — which the frontend cannot do,
// because an Astro page in another workspace cannot import a server service.
//
// So the link is asserted here instead: the frontend's fallback URL must end in
// the key the server actually writes.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { STATUS_SNAPSHOT_KEY } from '../../src/services/status-snapshot.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const STATUS_PAGE = resolve(REPO_ROOT, 'apps/status-site/src/pages/index.astro');

/** The frontend's hard-coded fallback URL — the default when PUBLIC_STATUS_R2_URL is unset. */
function frontendFallbackUrl(): string {
  const src = readFileSync(STATUS_PAGE, 'utf8');
  const m =
    /const R2_FALLBACK_URL =\s*\n\s*import\.meta\.env\.PUBLIC_STATUS_R2_URL \?\?\s*\n\s*'([^']+)';/.exec(
      src,
    );
  return m === null ? '' : (m[1] as string);
}

describe('V-902 the status-page outage fallback is one path', () => {
  it('CRITICAL both ends are really read. The comparison below is a suffix match, and an empty string is a suffix of nothing useful — an unparsed frontend URL would make the assertion vacuous rather than failing, which is the shape this sweep kept finding in other guards.', () => {
    expect(STATUS_SNAPSHOT_KEY, 'the key the server writes').toMatch(/^status\/.+\.json$/);
    expect(frontendFallbackUrl(), 'the URL the frontend falls back to').toMatch(/^https:\/\/.+/);
  });

  it('CRITICAL the frontend fetches the object the server writes. Each side is separately pinned today, so changing the server key and its own pin leaves the frontend pin passing against the stale path — both halves internally consistent and the fallback dead. It fails silently: the live API is healthy in every environment where anyone would notice, and the broken path is only taken during the outage the page exists to report.', () => {
    expect(
      frontendFallbackUrl().endsWith(`/${STATUS_SNAPSHOT_KEY}`),
      `frontend falls back to ${frontendFallbackUrl()} but the server writes ${STATUS_SNAPSHOT_KEY}`,
    ).toBe(true);
  });

  it('CRITICAL the frontend still prefers the live API and only falls back on rejection. The order is the contract: reading the snapshot first would serve data up to 60s stale on every request, and the snapshot exists to cover an outage rather than to replace the API.', () => {
    const src = readFileSync(STATUS_PAGE, 'utf8');
    const liveIdx = src.indexOf("incidentResult.status === 'fulfilled'");
    const fallbackIdx = src.indexOf('load(R2_FALLBACK_URL');
    expect(liveIdx, 'the live-API branch').toBeGreaterThan(-1);
    expect(fallbackIdx, 'the R2 fallback call').toBeGreaterThan(-1);
    expect(liveIdx, 'live is checked before the fallback is loaded').toBeLessThan(fallbackIdx);
  });
});
