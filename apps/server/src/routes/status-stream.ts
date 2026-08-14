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
// The SLA aggregate has both the app-wide global IP gate and its own
// 60/min/IP direct-request budget. The SSE stream is bounded per
// process at 500 total connections and 10 per IP.

import type { FastifyInstance } from 'fastify';
import { FeatureUnavailableError } from '../lib/errors.js';
import { AUTH_IP_LIMITS, ipRateLimit } from '../middleware/ip-rate-limit.js';
import type { IncidentEvent, IncidentEventBus } from '../services/incident-event-bus.js';
import type { RateLimitStore } from '../services/rate-limit.js';
import { hijackedReplyHeaders } from '../lib/hijacked-reply.js';
import type { SlaReportingService } from '../services/sla-reporting.js';
import { sseCorsHeaders, type CorsAllowDeps } from '../lib/cors-allow.js';

// Same per-stream high-water mark as the authenticated notification/transcript
// SSE routes. Connection caps bound socket count; this independently bounds the
// bytes a single stalled public client can retain between writes.
const MAX_SSE_BUFFER_BYTES = 4_000_000;

export interface StatusStreamRoutesOptions {
  bus: IncidentEventBus;
  sla: SlaReportingService;
  /** Shared token-bucket store for the public SLA aggregate's per-IP gate. */
  rateLimitStore: RateLimitStore;
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
  const statusSlaGate = ipRateLimit(opts.rateLimitStore, {
    bucketPrefix: 'status_sla',
    capacity: AUTH_IP_LIMITS.statusSla.capacity,
    refillPerSecond: AUTH_IP_LIMITS.statusSla.refillPerSecond,
  });
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
      reply.header('retry-after', '30');
      throw new FeatureUnavailableError('Status stream at capacity; retry shortly.');
    }
    // Acquire capacity only after the raw response, subscription, timer and
    // close/error cleanup are all established below. A synchronous setup failure
    // must not consume a slot that has no handler capable of releasing it.
    let acquired = false;
    let released = false;
    const releaseConn = (): void => {
      if (!acquired || released) return;
      released = true;
      openTotal -= 1;
      const n = (openPerIp.get(ip) ?? 1) - 1;
      if (n <= 0) openPerIp.delete(ip);
      else openPerIp.set(ip, n);
    };
    // Hijack the reply so Fastify doesn't auto-finish the response.
    reply.raw.writeHead(200, {
      // Hijack drops everything the pipeline set — the request id and the
      // rate-limit accounting for the token this connection just spent.
      // Spread FIRST so this route's own content-type and cache-control win.
      ...hijackedReplyHeaders(reply),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // disable nginx-style buffering
      // W586 — hijacked reply bypasses @fastify/cors; set ACAO here.
      ...sseCorsHeaders(request.headers.origin, opts.cors ?? {}),
    });
    // Initial comment to flush headers immediately on some proxies.
    reply.raw.write(': stream open\n\n');

    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined = undefined;
    let unsubscribe: () => void = () => {};
    const cleanup = (): void => {
      // Idempotent across event/heartbeat backpressure and both socket signals.
      if (closed) return;
      closed = true;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      unsubscribe();
      releaseConn();
      reply.raw.end();
    };

    const closeIfBackpressured = (): void => {
      if (reply.raw.writableLength > MAX_SSE_BUFFER_BYTES) cleanup();
    };

    const send = (event: IncidentEvent): void => {
      if (closed) return;
      const data = JSON.stringify(event);
      // SSE framing: `event:` (named) + `data:` + blank-line terminator.
      reply.raw.write(`event: ${event.event}\n`);
      reply.raw.write(`data: ${data}\n\n`);
      closeIfBackpressured();
    };

    unsubscribe = bus.subscribe(send);
    heartbeat = setInterval(() => {
      if (closed) return;
      // SSE comment lines (start with `:`) are heartbeats — no data.
      reply.raw.write(`: heartbeat ${new Date().toISOString()}\n\n`);
      closeIfBackpressured();
    }, heartbeatMs);
    heartbeat.unref();

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);

    // Keep Fastify from completing the response — we'll end manually.
    reply.hijack();
    openTotal += 1;
    openPerIp.set(ip, perIp + 1);
    acquired = true;
  });

  // /v1/status/sla — same public/no-auth posture as /v1/status/incidents.
  // A route-specific 60/min/IP budget bounds direct requests for the
  // rolling aggregate independently of the coarser app-wide IP gate.
  app.get('/v1/status/sla', { preHandler: statusSlaGate }, async (_request, reply) => {
    const data = await sla.report(new Date());
    reply.header('cache-control', 'public, max-age=30');
    return { data };
  });
}
