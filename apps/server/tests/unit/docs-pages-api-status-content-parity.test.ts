// Drift guard for apps/docs/src/pages/api/status.md. Pins the
// public-unauthenticated status API — 3-status-state machine
// (operational/degraded/major_outage) + aggregation rules + 30s CDN
// cache + 30-day incident feed + distinct-from-/health-/healthz-/ready.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/docs/src/pages/api/status.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs/pages/api/status content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Public-unauthenticated framing pinned: 'The /v1/status/* surface backs the public Driftstack status site. It is intentionally unauthenticated — visitors don't have accounts — and IP-rate-limited at the edge. Cache-Control headers are set so a CDN (Cloudflare Pages in front of status.driftstack.io) can coalesce concurrent viewers onto one origin call.' — pinned so the public-unauthenticated + IP-rate-limited-at-edge + Cloudflare-Pages-CDN-coalesce contract all stay documented", () => {
    expect(body).toMatch(
      /The `\/v1\/status\/\*` surface backs the public Driftstack status site\. It\s*is intentionally \*\*unauthenticated\*\* — visitors don't have accounts —\s*and IP-rate-limited at the edge\./,
    );
    expect(body).toMatch(
      /Cache-Control headers are set so a\s*CDN \(Cloudflare Pages in front of `status\.driftstack\.io`\) can coalesce\s*concurrent viewers onto one origin call\./,
    );
  });

  it("Distinct-from-health-probes framing pinned: 'Distinct from /health, /healthz, and /ready, which are infrastructure-facing liveness / readiness probes consumed by the orchestrator. /v1/status is what HUMANS see.' — pinned so the 3-infra-probe-roster + humans-vs-infra split contract stays documented (drift to merging the surfaces would expose infra liveness signals to public visitors)", () => {
    expect(body).toMatch(
      /Distinct from `\/health`, `\/healthz`, and `\/ready`, which are\s*infrastructure-facing liveness \/ readiness probes consumed by the\s*orchestrator\. `\/v1\/status` is what HUMANS see\./,
    );
  });

  it("3-status-state machine pinned: operational (probe succeeded within timeout) + degraded (probe failed transient/timeout) + major_outage (service-wide outage affecting multiple components). + aggregation rules: 'any major_outage → overall major_outage; otherwise any degraded → overall degraded; otherwise operational.' — pinned so the 3-state machine + per-component aggregation contract all stay documented", () => {
    expect(body).toMatch(/- `operational` — probe succeeded within timeout/);
    expect(body).toMatch(/- `degraded` — probe failed \(transient error or timeout\)/);
    expect(body).toMatch(/- `major_outage` — a service-wide outage affecting multiple components/);
    expect(body).toMatch(
      /Aggregation: any `major_outage` → overall `major_outage`; otherwise\s*any `degraded` → overall `degraded`; otherwise `operational`\./,
    );
  });

  it("30s-CDN-cache framing pinned: 'Cache-Control: public, max-age=30 — the snapshot is recomputed on every request, but the CDN coalesces requests within the 30s window.' — pinned so the public-max-age=30 + CDN-coalesce-within-window contract stays documented (drift to a longer max-age would delay outage detection by customers)", () => {
    expect(body).toMatch(
      /`Cache-Control: public, max-age=30` — the snapshot is recomputed\s*on every request, but the CDN coalesces requests within the 30s\s*window\./,
    );
  });

  it("Snapshot 3-section response shape pinned: overall_status + components[]{name, status, last_checked_at} + recent_incidents[]{id, title, severity, status, started_at, resolved_at}. + 3-component-roster (postgres + redis + r2) + 'last 5 public incidents from the past 30 days'. — pinned so the snapshot shape + 3-component roster + 5-incidents-30-days contract all stay documented", () => {
    expect(body).toMatch(
      /\{ "name": "postgres", "status": "operational", "last_checked_at": "<ISO-8601>" \},\s*\{ "name": "redis", "status": "operational", "last_checked_at": "<ISO-8601>" \},\s*\{ "name": "r2", "status": "operational", "last_checked_at": "<ISO-8601>" \}/,
    );
    expect(body).toMatch(
      /Returns the current health snapshot — overall status, per-component\s*breakdown, and the last 5 public incidents from the past 30 days\./,
    );
  });

  it("Incident feed query parameters pinned: since (ISO-8601 cutoff; defaults to 30 days ago) + limit (1-100; defaults to 50). + 'Lists public incidents from the last 30 days (default), most-recent first.' — pinned so the since/limit defaults + most-recent-first ordering contract all stay documented", () => {
    expect(body).toMatch(
      /\|\s*`since`\s+\|\s+optional \|\s+ISO-8601 cutoff; defaults to 30 days ago\s*\|/,
    );
    expect(body).toMatch(/\|\s*`limit`\s+\|\s+optional \|\s+1–100; defaults to 50/);
    expect(body).toMatch(
      /Lists public incidents from the last 30 days \(default\), most-recent\s*first\./,
    );
  });

  it('V-1078 CRITICAL the published stream caps are the ones the route enforces, derived from its source rather than restated. The per-IP figure is the one customers hit: browsers open a connection per tab and an office NAT shares one address, and EventSource retries into the refusal on its own.', () => {
    const route = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/routes/status-stream.ts'),
      'utf8',
    );
    const capOf = (name: string): string => {
      const m = new RegExp(`const ${name} = (\\d+);`).exec(route);
      expect(m, `${name} is no longer declared in status-stream.ts`).not.toBeNull();
      return m?.[1] ?? '';
    };
    const perIp = capOf('MAX_CONNECTIONS_PER_IP');
    const total = capOf('MAX_TOTAL_CONNECTIONS');

    expect(body, `the page must publish the per-IP cap the route enforces (${perIp})`).toMatch(
      new RegExp(`\\*\\*${perIp} concurrent connections per IP\\*\\*`),
    );
    expect(body, `the page must publish the total cap (${total})`).toMatch(
      new RegExp(`\\*\\*${total} in total\\*\\*`),
    );

    // The refusal shape a client branches on, and the header it should honour.
    expect(body, 'the 503 refusal is no longer documented').toMatch(/`503 feature-unavailable`/);
    expect(body, 'the Retry-After hint is no longer documented').toMatch(/`Retry-After: 30`/);
    expect(body, 'the EventSource-retries-into-it warning is gone').toMatch(
      /`EventSource` reconnects on its own/,
    );

    // …and the route still refuses that way, or the page is next to go stale.
    expect(route, 'the route no longer sets a retry-after on the refusal').toMatch(
      /reply\.header\('retry-after', '30'\)/,
    );
    expect(route, 'the capacity gate no longer throws FeatureUnavailable').toMatch(
      /throw new FeatureUnavailableError\('Status stream at capacity/,
    );
  });
});
