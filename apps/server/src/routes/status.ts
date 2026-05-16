// V-176 — public-facing status endpoint.
//
// Distinct from /ready (which is the k8s / liveness probe consumed by
// orchestration infrastructure). /v1/status is the CUSTOMER-FACING
// status surface — what the public status page (marketing-site
// /status, future) consumes.
//
// Response shape:
//   {
//     overall_status: 'operational' | 'degraded' | 'major_outage',
//     components: [
//       { name, status, last_checked_at }
//     ],
//     recent_incidents: []  // placeholder; future: incidents service
//   }
//
// Component check derivation:
//   - Each ReadinessCheck (postgres, redis, r2, etc.) runs with its
//     existing timeout. ok → 'operational'; failed → 'degraded'.
//   - Overall: any 'major_outage' → 'major_outage'; any 'degraded' →
//     'degraded'; else 'operational'.
//   - 'major_outage' isn't reachable from the readiness probes today
//     (single-failure → 'degraded'); reserved for future incidents
//     service to mark wide-blast-radius outages.
//
// No auth required — status pages are public.
//
// Caching: caller (Cloudflare Pages, future) caches the response for
// ~30s. Response includes Cache-Control: public, max-age=30.

import type { FastifyInstance } from 'fastify';
import type { ReadinessCheck } from '../lib/app.js';
import type { IncidentRow, IncidentsService } from '../services/incidents.js';

const CACHE_MAX_AGE_SEC = 30;
const COMPONENT_TIMEOUT_MS = 1500;
const RECENT_INCIDENTS_LIMIT = 5;
const RECENT_INCIDENTS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

type ComponentStatus = 'operational' | 'degraded' | 'major_outage';

interface ComponentResult {
  name: string;
  status: ComponentStatus;
  last_checked_at: string;
}

interface PublicIncidentSummary {
  id: string;
  title: string;
  severity: string;
  status: string;
  started_at: string;
  resolved_at: string | null;
}

interface StatusResponse {
  overall_status: ComponentStatus;
  components: ComponentResult[];
  recent_incidents: readonly PublicIncidentSummary[];
}

function summarizeIncident(row: IncidentRow): PublicIncidentSummary {
  return {
    id: `inc_${row.id}`,
    title: row.title,
    severity: row.severity,
    status: row.status,
    started_at: row.startedAt.toISOString(),
    resolved_at: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

async function runComponentCheck(check: ReadinessCheck): Promise<ComponentResult> {
  const startedAt = new Date();
  try {
    const timeoutMs = check.timeoutMs ?? COMPONENT_TIMEOUT_MS;
    await Promise.race([
      check.fn(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    return {
      name: check.name,
      status: 'operational',
      last_checked_at: startedAt.toISOString(),
    };
  } catch {
    return {
      name: check.name,
      status: 'degraded',
      last_checked_at: startedAt.toISOString(),
    };
  }
}

function aggregateOverall(components: readonly ComponentResult[]): ComponentStatus {
  if (components.some((c) => c.status === 'major_outage')) return 'major_outage';
  if (components.some((c) => c.status === 'degraded')) return 'degraded';
  return 'operational';
}

export interface StatusRoutesOptions {
  readinessChecks: readonly ReadinessCheck[];
  /** Optional — when provided, /v1/status surfaces the last 5
   *  public incidents from the last 30 days. When omitted (fresh
   *  fixtures), `recent_incidents` is an empty array. */
  incidentsService?: IncidentsService;
}

export function registerStatusRoutes(app: FastifyInstance, opts: StatusRoutesOptions): void {
  app.get('/v1/status', async (_request, reply) => {
    const components = await Promise.all(opts.readinessChecks.map(runComponentCheck));
    const recentIncidents: PublicIncidentSummary[] = [];
    if (opts.incidentsService) {
      try {
        const rows = await opts.incidentsService.list({
          scope: 'public',
          since: new Date(Date.now() - RECENT_INCIDENTS_WINDOW_MS),
          limit: RECENT_INCIDENTS_LIMIT,
        });
        for (const row of rows) recentIncidents.push(summarizeIncident(row));
      } catch {
        // Fail-open — /v1/status stays available even if incidents
        // service errors. Empty list is the same shape clients expect
        // when there are simply no incidents.
      }
    }
    const body: StatusResponse = {
      overall_status: aggregateOverall(components),
      components,
      recent_incidents: recentIncidents,
    };
    reply.header('cache-control', `public, max-age=${CACHE_MAX_AGE_SEC.toString()}`);
    return body;
  });
}
