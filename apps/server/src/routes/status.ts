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

const CACHE_MAX_AGE_SEC = 30;
const COMPONENT_TIMEOUT_MS = 1500;

type ComponentStatus = 'operational' | 'degraded' | 'major_outage';

interface ComponentResult {
  name: string;
  status: ComponentStatus;
  last_checked_at: string;
}

interface StatusResponse {
  overall_status: ComponentStatus;
  components: ComponentResult[];
  recent_incidents: readonly never[]; // placeholder until incidents service lands
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
}

export function registerStatusRoutes(app: FastifyInstance, opts: StatusRoutesOptions): void {
  app.get('/v1/status', async (_request, reply) => {
    const components = await Promise.all(opts.readinessChecks.map(runComponentCheck));
    const body: StatusResponse = {
      overall_status: aggregateOverall(components),
      components,
      recent_incidents: [],
    };
    reply.header('cache-control', `public, max-age=${CACHE_MAX_AGE_SEC.toString()}`);
    return body;
  });
}
