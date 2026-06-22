// V-295e — public status streaming + SLA endpoints.
//
//   GET /v1/status/stream — Server-Sent Events. Clients connect with
//   `EventSource(url)` and receive every public incident.created /
//   incident.resolved event in real time. Heartbeat every 30s keeps
//   the connection alive through proxies.
//
//   GET /v1/status/sla — rolling 30-day uptime per probe target,
//   computed from the V-295b system_health_probes table.
//
// Both endpoints are unauthenticated (the status site is public).
// SLA is rate-limited globally. The SSE stream has NO app-level
// rate-limit or concurrent-connection cap, and Fastify/Node set no
// maxConnections — so its connection bounding is only the per-IP
// TCP-connection ceiling at the OS / Cloudflare edge layer (a
// defense-in-depth gap surfaced as queue item 4.15).

import type { FastifyInstance } from 'fastify';
import type { IncidentEvent, IncidentEventBus } from '../services/incident-event-bus.js';
import type { SlaReportingService } from '../services/sla-reporting.js';
import { sseCorsHeaders, type CorsAllowDeps } from '../lib/cors-allow.js';

export interface StatusStreamRoutesOptions {
  bus: IncidentEventBus;
  sla: SlaReportingService;
  /**
   * Heartbeat interval in ms. Defaults to 30s — well below typical
   * proxy idle-timeouts (60s on Cloudflare, longer elsewhere).
   */
  heartbeatMs?: number;
  /** W586 — CORS allow-list config; the hijacked SSE reply sets ACAO itself
   *  (the status site reads this cross-origin). */
  cors?: CorsAllowDeps;
}

export function registerStatusStreamRoutes(
  app: FastifyInstance,
  opts: StatusStreamRoutesOptions,
): void {
  const { bus, sla } = opts;
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  // Concurrent-connection caps (audit #6 — the unauth SSE had no app-level bound, a
  // resource-exhaustion DoS). Global cap bounds total resource; per-IP cap stops one client
  // exhausting it. In-memory counters (SSE is single-process per node), released idempotently
  // on close/error so the counters can't leak.
  const MAX_TOTAL_CONNECTIONS = 500;
  const MAX_CONNECTIONS_PER_IP = 10;
  let openTotal = 0;
  const openPerIp = new Map<string, number>();

  app.get('/v1/status/stream', (request, reply) => {
    // Connection-cap gate (before hijack): reject at capacity so an attacker can't open
    // unbounded SSE connections (per-IP first, then global).
    const ip = request.ip;
    const perIp = openPerIp.get(ip) ?? 0;
    if (openTotal >= MAX_TOTAL_CONNECTIONS || perIp >= MAX_CONNECTIONS_PER_IP) {
      reply
        .code(503)
        .header('retry-after', '30')
        .send({ error: 'Status stream at capacity; retry shortly.' });
      return;
    }
    openTotal += 1;
    openPerIp.set(ip, perIp + 1);
    let released = false;
    const releaseConn = (): void => {
      if (released) return;
      released = true;
      openTotal -= 1;
      const n = (openPerIp.get(ip) ?? 1) - 1;
      if (n <= 0) openPerIp.delete(ip);
      else openPerIp.set(ip, n);
    };
    // Hijack the reply so Fastify doesn't auto-finish the response.
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // disable nginx-style buffering
      // W586 — hijacked reply bypasses @fastify/cors; set ACAO here.
      ...sseCorsHeaders(request.headers.origin, opts.cors ?? {}),
    });
    // Initial comment to flush headers immediately on some proxies.
    reply.raw.write(': stream open\n\n');

    const send = (event: IncidentEvent): void => {
      const data = JSON.stringify(event);
      // SSE framing: `event:` (named) + `data:` + blank-line terminator.
      reply.raw.write(`event: ${event.event}\n`);
      reply.raw.write(`data: ${data}\n\n`);
    };

    const unsubscribe = bus.subscribe(send);
    const heartbeat = setInterval(() => {
      // SSE comment lines (start with `:`) are heartbeats — no data.
      reply.raw.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    }, heartbeatMs);
    heartbeat.unref();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      releaseConn();
      reply.raw.end();
    };

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);

    // Keep Fastify from completing the response — we'll end manually.
    reply.hijack();
  });

  // /v1/status/sla — same no-auth posture as /v1/status/incidents.
  // The query is a cheap aggregate over a small table (one probe/min
  // per target = ~43k rows in 30d), so no extra rate-limiting needed.
  app.get('/v1/status/sla', async () => {
    const data = await sla.report(new Date());
    return { data };
  });
}
