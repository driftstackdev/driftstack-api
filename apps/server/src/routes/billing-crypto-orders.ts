// V-666.G — customer-facing crypto-orders routes.
//
//   GET /v1/billing/crypto-orders          — list caller's own orders
//   GET /v1/billing/crypto-orders/:id      — single order lookup
//
// Both routes are scoped to the calling account. Cross-account
// id lookups return 404 (not 403) — we don't leak the existence of
// orders that belong to other accounts.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import type { CryptoOrder, CryptoOrdersService } from '../services/crypto-orders.js';

export interface RegisterCustomerCryptoOrdersRoutesDeps {
  service: CryptoOrdersService;
}

const ListQuery = z.object({
  limit: z.string().regex(/^\d+$/).optional(),
});

const GetParams = z.object({
  order_id: z.string().min(1),
});

function toPublic(order: CryptoOrder): Record<string, unknown> {
  return {
    order_id: order.order_id,
    product: order.product,
    price_cents: order.price_cents,
    price_currency: order.price_currency,
    payment_id: order.payment_id,
    status: order.status,
    created_at: new Date(order.created_at).toISOString(),
    updated_at: new Date(order.updated_at).toISOString(),
  };
}

function requireCtx(request: FastifyRequest): NonNullable<FastifyRequest['account']> {
  if (!request.account) throw new Error('account context missing after requireAuth');
  return request.account;
}

export function registerCustomerCryptoOrdersRoutes(
  app: FastifyInstance,
  deps: RegisterCustomerCryptoOrdersRoutesDeps,
): void {
  app.get<{ Querystring: { limit?: string } }>(
    '/v1/billing/crypto-orders',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req: FastifyRequest<{ Querystring: { limit?: string } }>, reply) => {
      const ctx = requireCtx(req);
      const query = parseOrThrow(ListQuery, req.query);
      let limit: number | undefined;
      if (query.limit !== undefined) {
        const n = Number.parseInt(query.limit, 10);
        if (!Number.isInteger(n) || n < 1 || n > 100) {
          throw new BadRequestError('limit must be an integer between 1 and 100.');
        }
        limit = n;
      }
      const orders = await deps.service.listForAdmin({
        accountId: ctx.account.id,
        ...(limit !== undefined ? { limit } : {}),
      });
      return reply.send({ orders: orders.map(toPublic) });
    },
  );

  app.get<{ Params: { order_id: string } }>(
    '/v1/billing/crypto-orders/:order_id',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req: FastifyRequest<{ Params: { order_id: string } }>, reply) => {
      const ctx = requireCtx(req);
      const params = parseOrThrow(GetParams, req.params);
      const order = await deps.service.getById(params.order_id);
      if (order === null || order.account_id !== ctx.account.id) {
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
