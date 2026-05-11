// V-666.D — admin crypto-orders routes.
//
//   GET /v1/admin/crypto-orders?account_id=acc_X&limit=N
//   GET /v1/admin/crypto-orders/:order_id
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
}

function parseOrThrow<T>(schema: z.ZodSchema<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestError(result.error.message);
  return result.data;
}
