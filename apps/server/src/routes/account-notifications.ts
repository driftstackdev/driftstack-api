// 2026-05-20 — GUI panel notification SSE stream (v0.1 follow-up to
// the NotificationEventBus v0 scaffold at services/notification-event-
// bus.ts). One per-account SSE stream surfaces every NotificationEvent
// the server publishes (cost.threshold_alert today; incident /
// audit.high_severity / session.errored over time).
//
// Shape mirrors the agent-sessions transcript SSE pattern (Arc 2
// sub-slice 8.3): write event-stream headers, hijack the reply,
// subscribe to the bus per-accountId, heartbeat every 25s, cleanup on
// connection close.
//
// Distinct from the agent-sessions transcript stream: that one is
// per-session (the customer subscribes after they've created a
// specific session); this one is per-account (the GUI's notification
// panel subscribes once at app start and receives everything the
// account's owner-effective scope publishes).
//
// No Last-Event-ID resume in v0.1 — the bus is in-memory only, so
// disconnect-replay isn't meaningful. v0.2 will add a small per-
// account ring buffer + Last-Event-ID handling once a customer
// concretely asks for it.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { NotificationEventBus } from '../services/notification-event-bus.js';

function requireCtx(request: FastifyRequest): NonNullable<FastifyRequest['account']> {
  if (!request.account) throw new Error('account context missing after requireAuth');
  return request.account;
}

export interface AccountNotificationsRoutesOptions {
  /** The bus the dispatchers publish to. Optional — when omitted the
   *  route is NOT registered, mirroring the transcript-stream pattern
   *  where SSE is opt-in. */
  notificationBus?: NotificationEventBus;
  /** Heartbeat cadence (ms). Defaults to 25s — long enough to avoid
   *  noise on the wire, short enough to keep load-balancers from
   *  closing idle connections. Test seam. */
  heartbeatMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 25_000;

export function registerAccountNotificationsRoutes(
  app: FastifyInstance,
  opts: AccountNotificationsRoutesOptions,
): void {
  const bus = opts.notificationBus;
  if (bus === undefined) return; // opt-in wire-up; absent → no route
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  app.get(
    '/v1/account/me/notifications',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    (req, reply) => {
      const ctx = requireCtx(req);
      const accountId = ctx.account.id;

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      reply.raw.write(': stream open\n\n');

      const unsubscribe = bus.subscribe(accountId, (event) => {
        // Each event is one SSE frame. `event:` carries the
        // discriminator so the EventSource client can route via
        // addEventListener('cost.threshold_alert', …) etc.
        reply.raw.write(`event: ${event.kind}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      });

      const heartbeat = setInterval(() => {
        reply.raw.write(`: heartbeat ${new Date().toISOString()}\n\n`);
      }, heartbeatMs);
      heartbeat.unref();

      const cleanup = (): void => {
        clearInterval(heartbeat);
        unsubscribe();
        reply.raw.end();
      };
      req.raw.on('close', cleanup);
      req.raw.on('error', cleanup);
      reply.hijack();
    },
  );
}
