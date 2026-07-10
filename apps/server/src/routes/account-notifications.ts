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
import { sseCorsHeaders, type CorsAllowDeps } from '../lib/cors-allow.js';

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
  /** W586 — CORS allow-list config. The SSE handler hijacks the reply and
   *  writes raw headers, bypassing the @fastify/cors onSend hook, so it must
   *  set Access-Control-Allow-Origin itself or EventSource is blocked. */
  cors?: CorsAllowDeps;
  /** L1 — max concurrent notification streams per account (DoS ceiling).
   *  Defaults to 10 — one GUI app instance opens one stream, so 10 covers
   *  multiple devices/tabs while bounding a buggy/abusive fan-out. Test seam. */
  maxStreamsPerAccount?: number;
}

const DEFAULT_HEARTBEAT_MS = 25_000;
const DEFAULT_MAX_SSE_PER_ACCOUNT = 10;
// L1 — backpressure high-water mark, mirroring the transcript SSE (agent-sessions
// W383). A stalled client (TCP window full) would otherwise let published events
// buffer unboundedly in the socket (reply.raw.writableLength grows → server OOM).
const MAX_SSE_BUFFER_BYTES = 4_000_000;

export function registerAccountNotificationsRoutes(
  app: FastifyInstance,
  opts: AccountNotificationsRoutesOptions,
): void {
  const bus = opts.notificationBus;
  if (bus === undefined) return; // opt-in wire-up; absent → no route
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const maxStreamsPerAccount = opts.maxStreamsPerAccount ?? DEFAULT_MAX_SSE_PER_ACCOUNT;
  // L1 — active SSE count per account (this app instance), bounded by the ceiling
  // above. Incremented when a stream is accepted, decremented in its cleanup.
  const activeByAccount = new Map<string, number>();

  app.get<{ Querystring: { ds_token?: string } }>(
    '/v1/account/me/notifications',
    // SSE: EventSource can't set an Authorization header, so this route
    // also accepts the bearer token via `?ds_token=` (requireAuthEventSource).
    // The header still wins when present.
    { preHandler: [app.requireAuthEventSource, app.rateLimit('global')] },
    (req, reply) => {
      const ctx = requireCtx(req);
      const accountId = ctx.account.id;

      // L1 — per-account concurrency ceiling. Each GUI app instance opens ONE
      // notification stream; the cap bounds a buggy/abusive client (or a
      // credential-sharing fan-out) from pinning unbounded sockets + bus
      // subscriptions on one account. At the cap we refuse the NEW stream with
      // 429 (the client backs off + retries) rather than evicting a live one.
      const active = activeByAccount.get(accountId) ?? 0;
      if (active >= maxStreamsPerAccount) {
        void reply
          .code(429)
          .header('retry-after', '30')
          .send({
            error: {
              code: 'too_many_notification_streams',
              message: `at most ${maxStreamsPerAccount} concurrent notification streams per account`,
            },
          });
        return;
      }
      // NOTE: the concurrency slot is acquired LATER — just before reply.hijack(),
      // once the stream is fully wired + cleanup is registered — NOT here. Acquiring
      // it before the close/error handlers exist meant a synchronous setup failure
      // (e.g. writeHead/write on a socket the client destroyed between the cap check
      // and here) would increment the counter with no cleanup ever wired to
      // decrement it → that account permanently loses a slot (audit pre-push, w83xq1aht).

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        // W586 — hijacked reply bypasses @fastify/cors's onSend hook, so set
        // the CORS header here or EventSource is blocked on the 200 stream.
        ...sseCorsHeaders(req.headers.origin, opts.cors ?? {}),
      });
      reply.raw.write(': stream open\n\n');

      const unsubscribe = bus.subscribe(accountId, (event) => {
        // Each event is one SSE frame. `event:` carries the
        // discriminator so the EventSource client can route via
        // addEventListener('cost.threshold_alert', …) etc.
        reply.raw.write(`event: ${event.kind}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        // L1 — past the high-water mark a stalled client is buffering unboundedly;
        // close the stream (EventSource auto-reconnects; the bus is live so no
        // durable event is lost). A healthy client drains and never trips this.
        if (reply.raw.writableLength > MAX_SSE_BUFFER_BYTES) cleanup();
      });

      // Each heartbeat also RE-VALIDATES the connection's auth: a web session
      // revoked after this stream connected (logout / revoke-all / refresh
      // rotation) must not keep receiving the account's events on the already-
      // hijacked socket. requireAuthEventSource re-runs authenticate() with the
      // request's stored token; on failure (revoked / expired) we DESTROY the
      // socket, which fires the 'close' handler below → cleanup. EventSource won't
      // silently re-establish (a fresh connect re-auths and 401s). Bounds the
      // post-revoke leak to one heartbeat (~25s, the auth cache TTL) instead of
      // lingering until the client's TCP drops; a transient auth blip just closes
      // and the client reconnects (self-healing).
      const heartbeat = setInterval(() => {
        void app.requireAuthEventSource(req, reply).then(
          () => reply.raw.write(`: heartbeat ${new Date().toISOString()}\n\n`),
          () => reply.raw.destroy(),
        );
      }, heartbeatMs);
      heartbeat.unref();

      let closed = false;
      const cleanup = (): void => {
        // Idempotent — invoked from the backpressure guard above AND the
        // close/error handlers below (incl. the heartbeat re-auth failure, which
        // destroys the socket → 'close'); double-end / double-unsubscribe /
        // double-decrement is avoided so the paths can't race.
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        const remaining = (activeByAccount.get(accountId) ?? 1) - 1;
        if (remaining <= 0) activeByAccount.delete(accountId);
        else activeByAccount.set(accountId, remaining);
        reply.raw.end();
      };
      req.raw.on('close', cleanup);
      req.raw.on('error', cleanup);
      // Acquire the concurrency slot now that the stream is fully established and
      // cleanup() is wired to release it — so a setup failure above can never leak
      // a slot. Synchronous from the cap check to here (no await), so no race.
      activeByAccount.set(accountId, active + 1);
      reply.hijack();
    },
  );
}
