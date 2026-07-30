// W357.C — drift guard for status-site /index page (the public
// /status root). The page is the customer-facing read of incident
// data; its claims need to keep matching:
//   • IncidentSeveritySchema (minor / major / outage)
//   • IncidentStatusSchema (investigating / identified / monitoring
//     / resolved)
//   • Source-of-truth endpoint (GET /v1/status/incidents) + SSE
//     stream (GET /v1/status/stream)
//   • The 90-day history cross-link + the subscribe cross-link
//     (V-657).
//   • Privacy claim (no cookies, no visitor logging) — load-bearing
//     copy for compliance posture.
//   • SEVERITY_BADGE + STATUS_BADGE maps stay byte-identical with
//     status-site/history.astro (W354.B pattern) so the two views
//     can't drift into different colours per state.
//   • R2 fallback semantics (≤60s stale snapshot when API
//     unreachable).
//   • 60s SSE-safety-net refetch interval.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IncidentSeveritySchema, IncidentStatusSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/status-site/src/pages/index.astro');
const HISTORY_PAGE = resolve(REPO_ROOT, 'apps/status-site/src/pages/history.astro');
// /v1/status/incidents is registered alongside the admin incidents
// surface (it's the public read of the same data source).
const STATUS_INCIDENTS_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-incidents.ts');
const STATUS_STREAM_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/status-stream.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function extractBadge(name: 'SEVERITY_BADGE' | 'STATUS_BADGE', src: string): string {
  // Pull the literal { ... } body of the named const so we can do a
  // byte-identical comparison between index and history.
  const re = new RegExp(`const\\s+${name}\\s*=\\s*\\{([\\s\\S]*?)\\};`);
  const m = re.exec(src);
  if (!m || !m[1]) throw new Error(`${name} not found`);
  return m[1].replace(/\s+/g, ' ').trim();
}

describe('W357.C status-site /index page parity', () => {
  const body = read(PAGE);
  const history = read(HISTORY_PAGE);
  const severities = new Set<string>(
    (IncidentSeveritySchema._def as { values: readonly string[] }).values,
  );
  const statuses = new Set<string>(
    (IncidentStatusSchema._def as { values: readonly string[] }).values,
  );

  it('SEVERITY_BADGE keys are exactly IncidentSeveritySchema values', () => {
    for (const s of ['minor', 'major', 'outage']) {
      expect(severities.has(s)).toBe(true);
      expect(body).toMatch(new RegExp(`${s}:\\s*\\[`));
    }
  });

  it('STATUS_BADGE keys are exactly IncidentStatusSchema values', () => {
    for (const s of ['investigating', 'identified', 'monitoring', 'resolved']) {
      expect(statuses.has(s)).toBe(true);
      expect(body).toMatch(new RegExp(`${s}:\\s*\\[`));
    }
  });

  it('SEVERITY_BADGE map is byte-identical with status-site/history.astro', () => {
    expect(extractBadge('SEVERITY_BADGE', body)).toBe(extractBadge('SEVERITY_BADGE', history));
  });

  it('STATUS_BADGE map is byte-identical with status-site/history.astro', () => {
    expect(extractBadge('STATUS_BADGE', body)).toBe(extractBadge('STATUS_BADGE', history));
  });

  it('overall-state derivation has 4 slots (operational / degraded / outage / unknown)', () => {
    // V-295c2 derivation rule:
    //   - any open `outage`-severity incident → outage
    //   - any open incident → degraded
    //   - else → operational
    //   - fetch failure → unknown
    for (const state of ['operational', 'degraded', 'outage', 'unknown']) {
      expect(body).toMatch(new RegExp(`${state}:\\s*'`));
    }
    expect(body).toMatch(/'All systems operational'/);
    expect(body).toMatch(/'Some systems degraded'/);
    expect(body).toMatch(/'Major outage in progress'/);
    expect(body).toMatch(/'Status currently unavailable'/);
  });

  it('GET /v1/status/incidents is the public no-auth source-of-truth', () => {
    expect(body).toMatch(/\/v1\/status\/incidents/);
    expect(body).toMatch(/public no-auth endpoint/);
    expect(existsSync(STATUS_INCIDENTS_ROUTE)).toBe(true);
    expect(read(STATUS_INCIDENTS_ROUTE)).toContain("'/v1/status/incidents'");
    // No auth gate: route handler must not require any scope.
    const incidentsSrc = read(STATUS_INCIDENTS_ROUTE);
    const blockStart = incidentsSrc.indexOf("'/v1/status/incidents'");
    const blockEnd = incidentsSrc.indexOf('app.', blockStart + 1);
    const block = incidentsSrc.slice(blockStart, blockEnd === -1 ? undefined : blockEnd);
    expect(block).not.toMatch(/requireScope/);
  });

  it('GET /v1/status/stream SSE stream cited + listens for incident.created / incident.resolved', () => {
    expect(body).toContain('/v1/status/stream');
    expect(body).toContain("'incident.created'");
    expect(body).toContain("'incident.resolved'");
    expect(existsSync(STATUS_STREAM_ROUTE)).toBe(true);
    expect(read(STATUS_STREAM_ROUTE)).toContain("'/v1/status/stream'");
  });

  it('R2 fallback semantics: a cached snapshot is labelled as such, and an unconfirmable aggregate WITHHOLDS all-clear. `f66e8a02c` replaced the single "API temporarily unreachable" banner with composed per-condition truth notices; the load-bearing property is that a degraded read can never render as a confirmed green.', () => {
    expect(body).toMatch(/PUBLIC_STATUS_R2_URL/);
    expect(body).toMatch(/incidents-public\.json/);
    expect(body).toMatch(
      /Incident feed is a cached snapshot \(\$\{formatSnapshotAge\(generatedAt\)\}\)/,
    );
    expect(body).toMatch(/Current component health is unavailable; all-clear is withheld\./);
    expect(body).toMatch(/Live status could not confirm a coherent incident aggregate\./);
  });

  it('60s safety-net refetch interval pinned (covers SSE outages)', () => {
    expect(body).toMatch(/setInterval\(fetchAndRender,\s*60_000\)/);
  });

  it('W563: "last updated" stamp element + a stamp that reflects REAL data. `f66e8a02c` made it stamp the DATA timestamp (the snapshot\'s own generatedAt) rather than wall-clock now, so a cached snapshot can no longer look freshly fetched.', () => {
    // The element exists with an aria-live region for screen-reader refresh.
    expect(body).toMatch(/id="last-updated"[^>]*aria-live="polite"/);
    // The stamp accepts the data timestamp, defaulting to now.
    expect(body).toMatch(/function markUpdated\(at = new Date\(\)\.toISOString\(\)\)/);
    expect(body).toMatch(
      /'Data timestamp ' \+ new Date\(at\)\.toISOString\(\)\.replace\('T', ' '\)\.slice\(0, 19\) \+ ' UTC'/,
    );
    // ...and the render path passes the feed's own generatedAt when it has one.
    expect(body).toMatch(/markUpdated\(generatedAt \?\? new Date\(\)\.toISOString\(\)\);/);
  });

  it('incident-scope framing + V-657 quick-nav to /subscribe + /history', () => {
    // Heading widened by `f66e8a02c`: ALL active incidents are listed, not just
    // those opened inside the 30-day window, so an old-but-still-open incident
    // can no longer fall off the public page.
    expect(body).toMatch(/Incidents — all active \+ 30-day history/);
    expect(body).toMatch(/Subscribe to incident emails/);
    expect(body).toMatch(/Full incident history \(90 days\)/);
    // Both cross-links resolve.
    expect(existsSync(resolve(REPO_ROOT, 'apps/status-site/src/pages/subscribe.astro'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'apps/status-site/src/pages/history.astro'))).toBe(true);
  });

  it('fetchAndRender() guards against a stale in-flight response overwriting a newer render', () => {
    // fetchAndRender() is triggered from three independent places
    // (initial load, the SSE incident.created/incident.resolved
    // handlers, and the 60s safety-net poll) that can overlap. Without
    // a per-call token, an older call's response landing after a
    // newer call's response would clobber the fresher DOM state (e.g.
    // re-showing a since-resolved incident as still open). Pin the
    // token-guard so it can't be silently dropped in a future edit.
    expect(body).toMatch(/let\s+latestFetchToken\s*=\s*0;/);
    expect(body).toMatch(/const\s+fetchToken\s*=\s*\+\+latestFetchToken;/);
    // Guarded on both the success path and the catch path — a stale
    // failure must not clobber a newer successful render either.
    const guardOccurrences = body.match(/if \(fetchToken !== latestFetchToken\) return;/g) ?? [];
    expect(guardOccurrences.length).toBe(2);
  });

  it('privacy posture pinned: no cookies, no visitor logging, 30d probe history (no PII)', () => {
    // V-295 privacy stance — the page itself is anonymous; the 30d
    // probe history Driftstack keeps doesn't reference any Customer
    // or visitor. Compliance-relevant copy — must not water down.
    expect(body).toMatch(/page itself stores\s+no cookies and does not log visitors/);
    expect(body).toMatch(/Driftstack records its own\s+health-probe history.*for 30 days/s);
    expect(body).toMatch(/this\s+data does not reference any Customer or visitor/);
  });
});
