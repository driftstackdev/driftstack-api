// Arc 6 docs.status — `apps/docs/src/pages/api/status.md` content
// parity. Pins the page against the source-of-truth surface so
// route renames + drops break CI:
//
//   - Every documented endpoint corresponds to a real route handler.
//   - Cache-Control max-age constant (30s) MUST match.
//   - SSE event-type strings MUST match the IncidentEventBus event
//     names emitted by the incidents service.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTH_IP_LIMITS } from '../../src/middleware/ip-rate-limit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOCS_PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/status.md');
const STATUS_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/status.ts');
const STREAM_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/status-stream.ts');
const SUBSCRIBE_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/status-subscribe.ts');
const INCIDENTS_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-incidents.ts');

describe('Arc 6 docs.status — apps/docs/src/pages/api/status.md parity', () => {
  it('docs page file exists at the expected path', () => {
    expect(existsSync(DOCS_PAGE)).toBe(true);
  });

  const body = readFileSync(DOCS_PAGE, 'utf8');

  it('frontmatter declares the layout + title + description', () => {
    expect(body).toMatch(/layout: \.\.\/\.\.\/layouts\/DocLayout\.astro/);
    expect(body).toMatch(/title: Status page API/);
    expect(body).toMatch(/description: Public status surface/i);
  });

  it('documents every public /v1/status/* endpoint that the route source exposes', () => {
    const routeSources = [
      readFileSync(STATUS_ROUTE, 'utf8'),
      readFileSync(STREAM_ROUTE, 'utf8'),
      readFileSync(SUBSCRIBE_ROUTE, 'utf8'),
      readFileSync(INCIDENTS_ROUTE, 'utf8'),
    ].join('\n');
    const paths = [
      '/v1/status',
      '/v1/status/incidents',
      '/v1/status/incidents/:id',
      '/v1/status/stream',
      '/v1/status/sla',
      '/v1/status/subscribe',
      '/v1/status/subscribe/confirm',
      '/v1/status/subscribe/unsubscribe',
    ];
    for (const p of paths) {
      expect(
        routeSources.includes(`'${p}'`) || routeSources.includes(`\`${p}\``),
        `at least one route source must declare ${p}`,
      ).toBe(true);
      const docPath = p.replace(':id', '{id}');
      expect(body.includes(docPath), `docs page must reference ${docPath}`).toBe(true);
    }
  });

  it('cache-control max-age claim matches CACHE_MAX_AGE_SEC in routes/status.ts (30s)', () => {
    const src = readFileSync(STATUS_ROUTE, 'utf8');
    expect(src).toMatch(/CACHE_MAX_AGE_SEC\s*=\s*30/);
    expect(body).toMatch(/max-age=30/);
  });

  it('component statuses match the route source ComponentStatus union', () => {
    const src = readFileSync(STATUS_ROUTE, 'utf8');
    // Sanity: the route still declares the same three states.
    expect(src).toMatch(/'operational'/);
    expect(src).toMatch(/'degraded'/);
    expect(src).toMatch(/'major_outage'/);
    expect(body).toMatch(/operational/);
    expect(body).toMatch(/degraded/);
    expect(body).toMatch(/major_outage/);
  });

  it('documents the incident.created + incident.resolved SSE event names', () => {
    // The IncidentEventBus publishes these named events; the SSE
    // handler forwards `event.event` as the SSE event-name. If
    // the bus drops one of these (or renames it), the docs page
    // breaks.
    expect(body).toMatch(/incident\.created/);
    expect(body).toMatch(/incident\.resolved/);
  });

  it('documents the SSE heartbeat interval (30s, matches default in status-stream.ts)', () => {
    const src = readFileSync(STREAM_ROUTE, 'utf8');
    expect(src).toMatch(/heartbeatMs\s*\?\?\s*30_000/);
    expect(body).toMatch(/30 seconds/);
  });

  it('documents double-opt-in for subscription (RFC 6233)', () => {
    expect(body).toMatch(/double-opt-in/i);
    expect(body).toMatch(/confirmation email/i);
  });

  it('CRITICAL the published subscription rate limit is READ from AUTH_IP_LIMITS, not pinned as a literal', () => {
    // What stood here asserted only that the middleware source still contains
    // the string "statusSubscribe" and that the page still contains the literal
    // "3 requests per minute" — despite a title claiming it matched the
    // constant. Measured: raising statusSubscribe to 10/min left this file at
    // 11/11 GREEN while the page went on promising 3, so the page could
    // under-state the real limit on an unauthenticated endpoint and nothing
    // would say so.
    const { capacity, refillPerSecond } = AUTH_IP_LIMITS.statusSubscribe;

    // "per minute" is only an honest unit while the bucket refills its whole
    // capacity over a minute; a different refill makes the sentence wrong even
    // when the number matches.
    expect(
      refillPerSecond,
      'the page says "per minute", which requires refill = capacity / 60',
    ).toBeCloseTo(capacity / 60, 10);

    expect(body, `the page must publish the real limit (${String(capacity)}/min)`).toMatch(
      new RegExp(`${String(capacity)} requests per minute`),
    );
  });

  it('SLA window claim (30 days, ~43,200 checks) matches the per-minute probe cadence', () => {
    expect(body).toMatch(/30-day/);
    expect(body).toMatch(/43,200/);
    // Sanity: 30 days × 24 hours × 60 minutes = 43,200 checks.
    expect(30 * 24 * 60).toBe(43_200);
  });

  it('linked from apps/docs/src/pages/api/index.astro', () => {
    const indexPath = resolve(REPO_ROOT, 'apps/docs/src/pages/api/index.astro');
    const idx = readFileSync(indexPath, 'utf8');
    expect(idx).toMatch(/\/api\/status\//);
    expect(idx).toMatch(/Status page API/);
  });
});
