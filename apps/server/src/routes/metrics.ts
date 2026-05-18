// Arc 4 Wave 2.B sub-slice 8.18 (v2-#8) — GET /metrics Prometheus scrape.
//
// Scraped by VictoriaMetrics / Prometheus / Grafana Agent. The content
// type is `text/plain; version=0.0.4` per the exposition-format spec;
// scrapers reject anything else.
//
// Auth: bearer-token gated by METRICS_SCRAPE_TOKEN env var. The route
// is exposed publicly (so external scrapers can reach it without
// needing an internal-only path), but the token prevents unauthenticated
// readers from harvesting internal counters. The deploy bridge writes
// the token to /etc/driftstack/api.env; the value is rotated on the
// same cadence as other internal credentials.
//
// If METRICS_SCRAPE_TOKEN is unset, the route returns 503 — surfaces a
// missing-config bug early rather than silently exposing internals.

import type { FastifyInstance } from 'fastify';
import type { MetricsRegistry } from '../services/metrics-registry.js';

export interface MetricsRoutesDeps {
  readonly registry: MetricsRegistry;
  readonly scrapeToken: string | null;
}

export function registerMetricsRoutes(app: FastifyInstance, deps: MetricsRoutesDeps): void {
  app.get('/metrics', async (req, reply) => {
    if (deps.scrapeToken === null || deps.scrapeToken.length === 0) {
      reply.code(503);
      return { error: 'metrics scrape token not configured' };
    }
    const authz = req.headers.authorization;
    const expected = `Bearer ${deps.scrapeToken}`;
    if (authz !== expected) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return deps.registry.render();
  });
}
