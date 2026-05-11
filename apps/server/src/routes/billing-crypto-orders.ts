// V-666.G — customer-facing crypto-orders routes.
//
//   GET   /v1/billing/crypto-orders                  — list caller's own orders
//   GET   /v1/billing/crypto-orders/:id              — single order lookup
//   PATCH /v1/billing/crypto-orders/:id              — update customer_note (V-666.Q)
//   POST  /v1/billing/crypto-orders/:id/cancel       — abandon a pending order (V-666.J)
//   GET   /v1/billing/crypto-orders/:id/receipt      — normalized receipt JSON (V-666.M)
//   GET   /v1/billing/crypto-orders/:id/receipt.txt  — same receipt as text/plain (V-666.P)
//   GET   /v1/billing/crypto-orders/:id/receipt.pdf  — same receipt as application/pdf (V-666.U)
//
// All routes are scoped to the calling account. Cross-account
// id lookups return 404 (not 403) — we don't leak the existence of
// orders that belong to other accounts.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BadRequestError, ConflictError, NotFoundError } from '../lib/errors.js';
import { buildReceiptPdfBytes } from '../lib/receipt-pdf.js';
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
    customer_note: order.customer_note ?? null,
    created_at: new Date(order.created_at).toISOString(),
    updated_at: new Date(order.updated_at).toISOString(),
  };
}

const UpdateNoteSchema = z.object({
  customer_note: z.string().max(500).nullable(),
});

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

  // V-666.Q — update the customer's free-text note on an order
  // (PO numbers / internal labels). Length cap 500 chars; empty
  // string normalised to null.
  app.patch<{
    Params: { order_id: string };
    Body: { customer_note?: string | null };
  }>(
    '/v1/billing/crypto-orders/:order_id',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (
      req: FastifyRequest<{
        Params: { order_id: string };
        Body: { customer_note?: string | null };
      }>,
      reply,
    ) => {
      const ctx = requireCtx(req);
      const params = parseOrThrow(GetParams, req.params);
      const body = parseOrThrow(UpdateNoteSchema, req.body);
      const updated = await deps.service.updateCustomerNote({
        order_id: params.order_id,
        account_id: ctx.account.id,
        customer_note: body.customer_note,
      });
      if (updated === null) {
        throw new NotFoundError(`No crypto order with id "${params.order_id}".`);
      }
      return reply.send(toPublic(updated));
    },
  );

  // V-666.M — return a normalized receipt payload for an order the
  // caller owns. Works for any status; consuming UI gates "Download
  // PDF" / "Email me" affordances on `status === 'paid'`.
  app.get<{ Params: { order_id: string } }>(
    '/v1/billing/crypto-orders/:order_id/receipt',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req: FastifyRequest<{ Params: { order_id: string } }>, reply) => {
      const ctx = requireCtx(req);
      const params = parseOrThrow(GetParams, req.params);
      const receipt = await deps.service.getReceipt({
        order_id: params.order_id,
        account_id: ctx.account.id,
      });
      if (receipt === null) {
        throw new NotFoundError(`No crypto order with id "${params.order_id}".`);
      }
      return reply.send(receipt);
    },
  );

  // V-666.P — plain-text rendering of the same receipt. Useful for
  // wget / curl / cron jobs that pipe the receipt to a file without
  // an extra jq step. Identical access semantics as the JSON variant.
  app.get<{ Params: { order_id: string } }>(
    '/v1/billing/crypto-orders/:order_id/receipt.txt',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req: FastifyRequest<{ Params: { order_id: string } }>, reply) => {
      const ctx = requireCtx(req);
      const params = parseOrThrow(GetParams, req.params);
      const receipt = await deps.service.getReceipt({
        order_id: params.order_id,
        account_id: ctx.account.id,
      });
      if (receipt === null) {
        throw new NotFoundError(`No crypto order with id "${params.order_id}".`);
      }
      const lines = [
        'Driftstack receipt',
        '',
        `Order: ${receipt.order_id}`,
        `Issued: ${receipt.issued_at}`,
        `Status: ${receipt.status}`,
        `Product: ${receipt.product}`,
        `Amount: ${(receipt.price_cents / 100).toFixed(2)} ${receipt.price_currency}`,
      ];
      if (receipt.paid_at !== null) lines.push(`Paid at: ${receipt.paid_at}`);
      if (receipt.payment_id !== null) lines.push(`Payment id: ${receipt.payment_id}`);
      lines.push(`Created: ${receipt.created_at}`);
      return reply.type('text/plain; charset=utf-8').send(lines.join('\n') + '\n');
    },
  );

  // V-666.U — PDF rendering of the receipt for archiving / emailing.
  // Same access semantics as the JSON / .txt variants; cross-account
  // requests return 404. Content-Disposition: attachment so a browser
  // GET triggers a download with a meaningful filename.
  app.get<{ Params: { order_id: string } }>(
    '/v1/billing/crypto-orders/:order_id/receipt.pdf',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req: FastifyRequest<{ Params: { order_id: string } }>, reply) => {
      const ctx = requireCtx(req);
      const params = parseOrThrow(GetParams, req.params);
      const receipt = await deps.service.getReceipt({
        order_id: params.order_id,
        account_id: ctx.account.id,
      });
      if (receipt === null) {
        throw new NotFoundError(`No crypto order with id "${params.order_id}".`);
      }
      const bytes = buildReceiptPdfBytes(receipt);
      return reply
        .type('application/pdf')
        .header('content-disposition', `attachment; filename="receipt-${receipt.order_id}.pdf"`)
        .send(bytes);
    },
  );

  // V-666.J — cancel a pending order. Customer-facing self-service
  // abandonment. Once any payment activity exists (confirming/partial/
  // paid/failed) the cancel must go through support so the customer's
  // on-chain funds can be reconciled — those statuses return 409.
  app.post<{ Params: { order_id: string } }>(
    '/v1/billing/crypto-orders/:order_id/cancel',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req: FastifyRequest<{ Params: { order_id: string } }>, reply) => {
      const ctx = requireCtx(req);
      const params = parseOrThrow(GetParams, req.params);
      const result = await deps.service.cancelOrder({
        order_id: params.order_id,
        account_id: ctx.account.id,
      });
      if (result === null) {
        throw new NotFoundError(`No crypto order with id "${params.order_id}".`);
      }
      if (result.ok === 'not_cancellable') {
        throw new ConflictError(
          `Order is in state "${result.reason}" and can no longer be cancelled. Contact support for refund / recovery.`,
          { resource: 'crypto_order', field: 'status' },
        );
      }
      return reply.send(toPublic(result.order));
    },
  );
}

function parseOrThrow<T>(schema: z.ZodSchema<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestError(result.error.message);
  return result.data;
}
