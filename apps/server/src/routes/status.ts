// V-176 — public-facing status endpoint.
//
// Distinct from /ready (which is the k8s / liveness probe consumed by
// orchestration infrastructure). /v1/status is the CUSTOMER-FACING
// status surface — what the public status page (apps/status-site,
// deployed to Cloudflare) consumes.
//
// Response shape:
//   {
//     overall_status: 'operational' | 'degraded' | 'major_outage',
//     components: [
//       { name, status, last_checked_at }
//     ],
//     recent_incidents: [
//       { id, title, severity, status, started_at, resolved_at }
//     ],
//     open_incidents: number | null,
//     incident_data_complete: boolean
//   }
//
// Component check derivation:
//   - Each ReadinessCheck (postgres, redis, r2, etc.) runs with its
//     existing timeout. ok → 'operational'; failed → 'degraded'.
//   - Overall: any 'major_outage' → 'major_outage'; any 'degraded' →
//     'degraded'; else 'operational'.
//   - No readiness check can produce 'major_outage': runComponentCheck
//     returns only 'operational' or 'degraded', so aggregateOverall's
//     first branch is unreachable from components alone. The OVERALL
//     verdict still reaches it — an open incident of outage severity
//     sets 'major_outage' directly, which is the wide-blast-radius
//     signal a per-component probe cannot express.
//
// V-796 — incidents are LIVE here, and this header used to say they were
// not. It described recent_incidents as "placeholder; future: incidents
// service" and 'major_outage' as "reserved for future incidents service",
// long after publicFeed() was wired and the hasOpenOutage escalation was
// emitting exactly that value. This file's own drift guard pinned BOTH the
// "future" sentence and the `if (hasOpenOutage) overallStatus =
// 'major_outage';` line that refutes it — a claim and its contradiction
// asserted green in the same run, because a parity pin records what the
// text said, never whether it was true. It also documented a three-field
// response for a body that has five.
//
// recent_incidents is the newest RECENT_INCIDENTS_LIMIT public incidents
// inside RECENT_INCIDENTS_WINDOW_MS; open_incidents is the exact all-time
// open count.
//
// Absence fails CLOSED. No incidentsService, or a publicFeed() throw, sets
// incident_data_complete=false, nulls open_incidents, and escalates an
// otherwise-operational verdict to 'degraded'. An empty incident list is
// never an all-clear on its own.
//
// No auth required — status pages are public.
//
// Caching: the caller (Cloudflare Pages) caches the response for ~30s.
// Response includes Cache-Control: public, max-age=30.

import type { FastifyInstance } from 'fastify';
import type { ReadinessCheck } from '../lib/app.js';
import type { IncidentRow, IncidentsService } from '../services/incidents.js';
import type { RateLimitStore } from '../services/rate-limit.js';
import { AUTH_IP_LIMITS, ipRateLimit } from '../middleware/ip-rate-limit.js';

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
  /** Exact all-time count of currently open public incidents. */
  open_incidents: number | null;
  /** False means incident storage could not prove an all-clear. */
  incident_data_complete: boolean;
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
  // The losing side of the race has to be cancelled. When the probe wins, an
  // uncleared timer stays pending for the FULL timeout, so every /v1/status
  // request leaves one live timer per readiness check behind — keeping the
  // event loop awake and delaying shutdown by up to that long. The /ready twin
  // (runWithTimeout in lib/app.ts) already clears in a finally; this is the
  // same race and needs the same cleanup.
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeoutMs = check.timeoutMs ?? COMPONENT_TIMEOUT_MS;
    await Promise.race([
      check.fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
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
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function aggregateOverall(components: readonly ComponentResult[]): ComponentStatus {
  if (components.some((c) => c.status === 'major_outage')) return 'major_outage';
  if (components.some((c) => c.status === 'degraded')) return 'degraded';
  return 'operational';
}

export interface StatusRoutesOptions {
  readinessChecks: readonly ReadinessCheck[];
  /** Required, matching the sibling public status routes. Optional would mean
   *  an omitted store silently serves the endpoint ungated, which is the state
   *  this gate exists to end. */
  rateLimitStore: RateLimitStore;
  /** Optional — when provided, /v1/status surfaces all-time open truth
   *  plus bounded recent resolved history. When omitted (fresh fixtures),
   *  `recent_incidents` is an empty array. */
  incidentsService?: IncidentsService;
}

export function registerStatusRoutes(app: FastifyInstance, opts: StatusRoutesOptions): void {
  // The only member of the public status family that had no gate, and the most
  // expensive one in it: each request fans out to every readiness check. Its
  // siblings (`status_incidents_list`, `status_incident_detail`, `status_sla`)
  // were gated against direct-API abuse that bypasses the CDN; this closes the
  // same hole at the same budget.
  const statusSnapshotGate = ipRateLimit(opts.rateLimitStore, {
    bucketPrefix: 'status_snapshot',
    capacity: AUTH_IP_LIMITS.statusSnapshot.capacity,
    refillPerSecond: AUTH_IP_LIMITS.statusSnapshot.refillPerSecond,
  });

  app.get('/v1/status', { preHandler: statusSnapshotGate }, async (_request, reply) => {
    const components = await Promise.all(opts.readinessChecks.map(runComponentCheck));
    const recentIncidents: PublicIncidentSummary[] = [];
    let openIncidentCount = 0;
    let hasOpenOutage = false;
    // Optional injection exists for narrow fixtures only. Absence must fail
    // closed in the public response rather than fabricating an all-clear.
    let incidentDataComplete = opts.incidentsService !== undefined;
    if (opts.incidentsService) {
      try {
        const feed = await opts.incidentsService.publicFeed({
          since: new Date(Date.now() - RECENT_INCIDENTS_WINDOW_MS),
          limit: RECENT_INCIDENTS_LIMIT,
        });
        openIncidentCount = feed.openCount;
        hasOpenOutage = feed.openOutageCount > 0;
        for (const row of feed.rows) recentIncidents.push(summarizeIncident(row));
      } catch {
        // Keep the status endpoint available, but never convert an incident
        // storage failure into an operational/all-clear claim.
        incidentDataComplete = false;
      }
    }
    let overallStatus = aggregateOverall(components);
    if (hasOpenOutage) overallStatus = 'major_outage';
    else if ((!incidentDataComplete || openIncidentCount > 0) && overallStatus === 'operational') {
      overallStatus = 'degraded';
    }
    const body: StatusResponse = {
      overall_status: overallStatus,
      components,
      recent_incidents: recentIncidents,
      open_incidents: incidentDataComplete ? openIncidentCount : null,
      incident_data_complete: incidentDataComplete,
    };
    reply.header('cache-control', `public, max-age=${CACHE_MAX_AGE_SEC.toString()}`);
    return body;
  });
}
