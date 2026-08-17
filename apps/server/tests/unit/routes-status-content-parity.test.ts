// W412.C — drift guard for apps/server/src/routes/status.ts.
// V-176 public-facing /v1/status endpoint. Distinct from /ready
// (k8s liveness) — this is the CUSTOMER-FACING status surface. Drift
// here either breaks the marketing-site status page wire shape or
// drops the 30s public-cache header (status page hammers the API).
//
//   • V-176 framing pinned: /v1/status customer-facing status surface
//     distinct from /ready (k8s/orchestration liveness).
//   • Response shape framing pinned: overall_status +
//     components[{name, status, last_checked_at}] + recent_incidents
//     placeholder; overall_status: 'operational' | 'degraded' |
//     'major_outage'.
//   • Aggregation rules pinned: any major_outage → major_outage;
//     any degraded → degraded; else operational; major_outage NOT
//     reachable from readiness probes today (reserved for future
//     incidents service to mark wide-blast-radius outages).
//   • Per-component derivation: ReadinessCheck.fn() ok → operational;
//     failed (throw or timeout) → degraded.
//   • Timeout: COMPONENT_TIMEOUT_MS = 1500 default; Promise.race
//     against per-check `timeoutMs` override.
//   • Auth posture: no auth (status pages public).
//   • Cache framing pinned: caller (Cloudflare Pages, future) caches
//     ~30s; CACHE_MAX_AGE_SEC = 30; Cache-Control: public, max-age=30
//     header set on every response.
//   • recent_incidents: readonly PublicIncidentSummary[]; populated
//     from optional incidentsService (last 5 public incidents from
//     30d window). Empty array when the service is undefined (fresh
//     fixtures) or publicFeed() throws.
//   • V-791 — that last line used to end "(fail-open posture)", which is
//     the exact inverse of the code. status.ts:138 says "Absence must fail
//     closed in the public response rather than fabricating an all-clear",
//     the catch at :149-153 sets incidentDataComplete=false under "never
//     convert an incident storage failure into an operational/all-clear
//     claim", :156-159 escalates operational → degraded, and :164 emits
//     open_incidents: null. An operator seeing `degraded` with an empty
//     incident list and reading "fail-open" concludes "empty means all
//     clear, false alarm" — when it means incident storage is unavailable.
//     Backwards, and precisely when it costs the most. The method name was
//     stale too: list() became publicFeed().

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/status.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W412.C apps/server/src/routes/status.ts content parity', () => {
  const body = read(LIB);

  it('V-176 framing pinned: customer-facing /v1/status distinct from /ready (k8s liveness orchestration probe)', () => {
    expect(body).toMatch(/V-176 — public-facing status endpoint\./);
    expect(body).toMatch(
      /Distinct from \/ready \(which is the k8s \/ liveness probe consumed by\s*\n?\s*\/\/\s*orchestration infrastructure\)\. \/v1\/status is the CUSTOMER-FACING\s*\n?\s*\/\/\s*status surface — what the public status page \(marketing-site\s*\n?\s*\/\/\s*\/status, future\) consumes\./,
    );
  });

  it('Aggregation rules pinned: major_outage > degraded > operational; major_outage NOT reachable from readiness probes today', () => {
    expect(body).toMatch(
      /Overall: any 'major_outage' → 'major_outage'; any 'degraded' →\s*\n?\s*\/\/\s*'degraded'; else 'operational'\./,
    );
    expect(body).toMatch(
      /'major_outage' isn't reachable from the readiness probes today\s*\n?\s*\/\/\s*\(single-failure → 'degraded'\); reserved for future incidents\s*\n?\s*\/\/\s*service to mark wide-blast-radius outages\./,
    );
  });

  it('No-auth posture + Cloudflare ~30s cache framing pinned with public, max-age=30 header', () => {
    expect(body).toMatch(/No auth required — status pages are public\./);
    expect(body).toMatch(
      /Caching: caller \(Cloudflare Pages, future\) caches the response for\s*\n?\s*\/\/\s*~30s\. Response includes Cache-Control: public, max-age=30\./,
    );
  });

  it('Constants: CACHE_MAX_AGE_SEC=30 + COMPONENT_TIMEOUT_MS=1500', () => {
    expect(body).toMatch(/const CACHE_MAX_AGE_SEC = 30;/);
    expect(body).toMatch(/const COMPONENT_TIMEOUT_MS = 1500;/);
  });

  it("ComponentStatus union: 'operational' | 'degraded' | 'major_outage'", () => {
    expect(body).toMatch(/type ComponentStatus = 'operational' \| 'degraded' \| 'major_outage';/);
  });

  it('ComponentResult: 3 fields name + status + last_checked_at (ISO string)', () => {
    expect(body).toMatch(/interface ComponentResult \{/);
    expect(body).toMatch(/name: string;/);
    expect(body).toMatch(/status: ComponentStatus;/);
    expect(body).toMatch(/last_checked_at: string;/);
  });

  it('StatusResponse: overall_status + components + recent_incidents (V-545.A — readonly PublicIncidentSummary[])', () => {
    expect(body).toMatch(/interface StatusResponse \{/);
    expect(body).toMatch(/overall_status: ComponentStatus;/);
    expect(body).toMatch(/components: ComponentResult\[\];/);
    expect(body).toMatch(/recent_incidents: readonly PublicIncidentSummary\[\];/);
  });

  it('runComponentCheck: per-check timeoutMs override fallback to COMPONENT_TIMEOUT_MS; Promise.race timeout; catch → degraded', () => {
    expect(body).toMatch(
      /async function runComponentCheck\(check: ReadinessCheck\): Promise<ComponentResult> \{/,
    );
    expect(body).toMatch(/const startedAt = new Date\(\);/);
    expect(body).toMatch(/const timeoutMs = check\.timeoutMs \?\? COMPONENT_TIMEOUT_MS;/);
    expect(body).toMatch(/await Promise\.race\(\[\s*\n?\s*check\.fn\(\),/);
    expect(body).toMatch(
      /timer = setTimeout\(\(\) => reject\(new Error\('timeout'\)\), timeoutMs\);/,
    );
    // The losing timer is cancelled — otherwise every /v1/status request leaves
    // one pending timer per readiness check alive for the full timeout.
    expect(body).toMatch(/\} finally \{\s*\n?\s*if \(timer !== undefined\) clearTimeout\(timer\);/);
    expect(body).toMatch(
      /return \{\s*\n?\s*name: check\.name,\s*\n?\s*status: 'operational',\s*\n?\s*last_checked_at: startedAt\.toISOString\(\),\s*\n?\s*\};/,
    );
    expect(body).toMatch(
      /\} catch \{\s*\n?\s*return \{\s*\n?\s*name: check\.name,\s*\n?\s*status: 'degraded',\s*\n?\s*last_checked_at: startedAt\.toISOString\(\),/,
    );
  });

  it('aggregateOverall: major_outage > degraded > operational precedence via .some()', () => {
    expect(body).toMatch(
      /function aggregateOverall\(components: readonly ComponentResult\[\]\): ComponentStatus \{\s*\n?\s*if \(components\.some\(\(c\) => c\.status === 'major_outage'\)\) return 'major_outage';\s*\n?\s*if \(components\.some\(\(c\) => c\.status === 'degraded'\)\) return 'degraded';\s*\n?\s*return 'operational';/,
    );
  });

  it('Route handler combines readiness with exact incident aggregates and fails closed on incident-read errors', () => {
    expect(body).toMatch(
      // Pins the GATE, not just the handler. This regex previously matched the
      // ungated registration, which is the state that let the most expensive
      // public endpoint in the status family run unlimited — every request fans
      // out to all readiness checks. Requiring the preHandler here means the
      // gate cannot be dropped without this failing.
      /app\.get\('\/v1\/status', \{ preHandler: statusSnapshotGate \}, async \(_request, reply\) => \{\s*\n?\s*const components = await Promise\.all\(opts\.readinessChecks\.map\(runComponentCheck\)\);/,
    );
    expect(body).toMatch(
      /const recentIncidents: PublicIncidentSummary\[\] = \[\];[\s\S]*?let incidentDataComplete = opts\.incidentsService !== undefined;\s*\n?\s*if \(opts\.incidentsService\) \{/,
    );
    expect(body).toContain('const feed = await opts.incidentsService.publicFeed({');
    expect(body).toContain('openIncidentCount = feed.openCount;');
    expect(body).toContain('hasOpenOutage = feed.openOutageCount > 0;');
    expect(body).toContain('incidentDataComplete = false;');
    expect(body).toContain("if (hasOpenOutage) overallStatus = 'major_outage';");
    expect(body).toContain('open_incidents: incidentDataComplete ? openIncidentCount : null');
    expect(body).toMatch(
      /reply\.header\('cache-control', `public, max-age=\$\{CACHE_MAX_AGE_SEC\.toString\(\)\}`\);/,
    );
  });

  it('StatusRoutesOptions: readinessChecks readonly + optional incidentsService (V-545.A)', () => {
    expect(body).toMatch(
      /export interface StatusRoutesOptions \{\s*\n?\s*readinessChecks: readonly ReadinessCheck\[\];/,
    );
    expect(body).toMatch(/incidentsService\?: IncidentsService;/);
  });

  it('imports: FastifyInstance + ReadinessCheck + IncidentsService', () => {
    expect(body).toMatch(/import type \{ FastifyInstance \} from 'fastify';/);
    expect(body).toMatch(/import type \{ ReadinessCheck \} from '\.\.\/lib\/app\.js';/);
    expect(body).toMatch(
      /import type \{ IncidentRow, IncidentsService \} from '\.\.\/services\/incidents\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
