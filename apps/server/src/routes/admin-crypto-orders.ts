// V-666.D — admin crypto-orders routes.
//
//   GET  /v1/admin/crypto-orders?account_id=acc_X&limit=N
//   GET  /v1/admin/crypto-orders/stats                (V-666.N)
//   GET  /v1/admin/crypto-orders/:order_id
//   POST /v1/admin/crypto-orders/:order_id/apply-ipn  (V-666.F)
//   POST /v1/admin/crypto-orders/sweep-expired        (V-666.L)
//
// Auth: driftstack_internal_admin scope. Used by the founder dashboard
// + support ops to look up the order behind a customer's
// "I sent the payment but the dashboard still says pending" ticket.
// Read-only — order mutations happen via the IPN pipeline (V-666 / B).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import type { CryptoOrder, CryptoOrdersService } from '../services/crypto-orders.js';

export interface RegisterAdminCryptoOrdersRoutesDeps {
  service: CryptoOrdersService;
}

const ListQuery = z.object({
  account_id: z.string().min(1).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
});

const GetParams = z.object({
  order_id: z.string().min(1),
});

// V-666.F — admin manual IPN application. Operator path: when
// NowPayments fails to deliver an IPN (rare), ops can advance an
// order by hand by posting the provider_status they observed in
// the NowPayments dashboard. The same state machine that the real
// IPN route uses applies (forward-only, reverse-to-pending rejected).
const ApplyIpnBody = z.object({
  provider_status: z.string().min(1),
  payment_id: z.string().min(1),
});

// V-666.L — admin sweep-trigger body. olderThanHours defaults to 24h
// (matching the typical NowPayments payment window); limit defaults
// to 500 (matching the service's own per-tick cap).
const SweepBody = z.object({
  older_than_hours: z.number().int().min(1).max(8760).optional(), // up to 1 year
  limit: z.number().int().min(1).max(500).optional(),
});

function toPublic(order: CryptoOrder): Record<string, unknown> {
  return {
    order_id: order.order_id,
    account_id: order.account_id,
    product: order.product,
    price_cents: order.price_cents,
    price_currency: order.price_currency,
    payment_id: order.payment_id,
    status: order.status,
    created_at: new Date(order.created_at).toISOString(),
    updated_at: new Date(order.updated_at).toISOString(),
  };
}

export function registerAdminCryptoOrdersRoutes(
  app: FastifyInstance,
  deps: RegisterAdminCryptoOrdersRoutesDeps,
): void {
  app.get<{ Querystring: { account_id?: string; limit?: string } }>(
    '/v1/admin/crypto-orders',
    { preHandler: [app.requireScope('driftstack_internal_admin')] },
    async (
      req: FastifyRequest<{ Querystring: { account_id?: string; limit?: string } }>,
      reply,
    ) => {
      const query = parseOrThrow(ListQuery, req.query);
      let limit: number | undefined;
      if (query.limit !== undefined) {
        const n = Number.parseInt(query.limit, 10);
        if (!Number.isInteger(n) || n < 1 || n > 200) {
          throw new BadRequestError('limit must be an integer between 1 and 200.');
        }
        limit = n;
      }
      const orders = await deps.service.listForAdmin({
        ...(query.account_id !== undefined ? { accountId: query.account_id } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return reply.send({ orders: orders.map(toPublic) });
    },
  );

  // V-666.N — at-a-glance stats summary for the ops dashboard.
  // Counts per status + paid revenue per currency. Truncated when
  // more orders exist than the scan window (10k default).
  app.get(
    '/v1/admin/crypto-orders/stats',
    { preHandler: [app.requireScope('driftstack_internal_admin')] },
    async (_req, reply) => {
      const stats = await deps.service.getStatsForAdmin();
      return reply.send({
        total: stats.total,
        by_status: stats.byStatus,
        paid_revenue_cents: stats.paidRevenueCents,
        truncated: stats.truncated,
        scanned: stats.scanned,
      });
    },
  );

  app.get<{ Params: { order_id: string } }>(
    '/v1/admin/crypto-orders/:order_id',
    { preHandler: [app.requireScope('driftstack_internal_admin')] },
    async (req: FastifyRequest<{ Params: { order_id: string } }>, reply) => {
      const params = parseOrThrow(GetParams, req.params);
      const order = await deps.service.getById(params.order_id);
      if (order === null) {
        throw new NotFoundError(`No crypto order with id "${params.order_id}".`);
      }
      return reply.send(toPublic(order));
    },
  );

  // V-666.L — on-demand sweep of stale pending orders. Idempotent —
  // ops can invoke any time without side effects on non-eligible
  // orders. Returns the count expired this tick + a `capped` flag
  // signalling whether more remain (caller re-runs until capped:
  // false). Nightly cron lands separately when scheduled-jobs picks
  // this up.
  app.post<{
    Body: { older_than_hours?: number; limit?: number };
  }>(
    '/v1/admin/crypto-orders/sweep-expired',
    { preHandler: [app.requireScope('driftstack_internal_admin')] },
    async (req: FastifyRequest<{ Body: { older_than_hours?: number; limit?: number } }>, reply) => {
      const body = parseOrThrow(SweepBody, req.body ?? {});
      const olderThanHours = body.older_than_hours ?? 24;
      const olderThanMs = olderThanHours * 60 * 60 * 1000;
      const result = await deps.service.sweepExpiredOrders({
        olderThanMs,
        ...(body.limit !== undefined ? { limit: body.limit } : {}),
      });
      return reply.send({
        expired: result.expired,
        capped: result.capped,
        older_than_hours: olderThanHours,
      });
    },
  );

  // V-666.F — manual IPN application. Used by ops to recover from
  // missed NowPayments webhooks. Routes through the same state
  // machine as the public IPN endpoint, so the forward-only +
  // idempotency guarantees still hold.
  app.post<{
    Params: { order_id: string };
    Body: { provider_status?: string; payment_id?: string };
  }>(
    '/v1/admin/crypto-orders/:order_id/apply-ipn',
    { preHandler: [app.requireScope('driftstack_internal_admin')] },
    async (
      req: FastifyRequest<{
        Params: { order_id: string };
        Body: { provider_status?: string; payment_id?: string };
      }>,
      reply,
    ) => {
      const params = parseOrThrow(GetParams, req.params);
      const body = parseOrThrow(ApplyIpnBody, req.body);
      const updated = await deps.service.applyIpnStatus({
        order_id: params.order_id,
        payment_id: body.payment_id,
        provider_status: body.provider_status,
      });
      if (updated === null) {
        throw new NotFoundError(`No crypto order with id "${params.order_id}".`);
      }
      return reply.send(toPublic(updated));
    },
  );
}

function parseOrThrow<T>(schema: z.ZodSchema<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestError(result.error.message);
  return result.data;
}
