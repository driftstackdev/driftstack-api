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
//
// #122 read:billing floor (2026-07-08) — all 5 GETs (list / single /
// receipt / receipt.txt / receipt.pdf) require the read:billing scope; a
// broad `read` or `account_owner` key satisfies it via V-481, so the
// dashboard + GUI device keys are unaffected and only a genuinely narrow
// non-billing key is refused. The 2 mutations (PATCH note / cancel) keep
// admin:billing (W496). Completes the S46 read:billing floor for the
// crypto-order read family.

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
  // V-666.BR — single-value status filter on the customer list.
  // Mirrors the admin endpoint so customer-side dashboards can
  // narrow their history view (e.g. "show only paid orders")
  // without paging through the full result set.
  status: z.enum(['pending', 'confirming', 'paid', 'failed', 'partial', 'cancelled']).optional(),
  // V-666.BU — cursor for forward pagination. Opaque base64url
  // encoding of `{ts, id}`; consumers treat it as a token. The
  // service layer encodes/decodes it. 512 cap matches the admin
  // ListQuery cursor cap.
  cursor: z.string().min(1).max(512).optional(),
  // V-666.BX — half-open date-range filter on created_at. Both
  // bounds accept ISO 8601 timestamps. created_after is inclusive,
  // created_before is exclusive.
  created_after: z.string().datetime().optional(),
  created_before: z.string().datetime().optional(),
});

const GetParams = z.object({
  // order_id is `ord_<36-char-uuid>` (40 chars); 100 cap = slice
  // 116/117 defensive pattern.
  order_id: z.string().min(1).max(100),
});

// V-666.AV — customer-facing pay-window hint. Pending orders carry
// an `expires_at` ISO timestamp set to `created_at + PAY_WINDOW_MS`
// so the UI can render a countdown without computing locally. The
// hint is purely informational — actual expiry is enforced by the
// admin sweep + the customer cancel endpoint, which both consult
// their own thresholds. Non-pending orders carry expires_at: null.
const PAY_WINDOW_MS = 60 * 60 * 1000;

function toPublic(order: CryptoOrder): Record<string, unknown> {
  return {
    order_id: order.order_id,
    product: order.product,
    price_cents: order.price_cents,
    price_currency: order.price_currency,
    payment_id: order.payment_id,
    status: order.status,
    customer_note: order.customer_note ?? null,
    // V-666.AU — customer-facing event timeline. Same shape as the
    // admin /events endpoint (V-666.AT) but inlined on the
    // envelope so the order-detail GET is a single round trip.
    // Excludes the 'swept' source from the customer's view —
    // admin sweep is an internal lifecycle event the customer
    // doesn't need to see; we surface it as a regular 'expired'
    // from their perspective.
    events: order.events.map((e) => ({
      status: e.status,
      at: new Date(e.at).toISOString(),
      source: e.source === 'swept' ? 'expired' : e.source,
    })),
    expires_at:
      order.status === 'pending' ? new Date(order.created_at + PAY_WINDOW_MS).toISOString() : null,
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
  app.get<{
    Querystring: {
      limit?: string;
      status?: string;
      cursor?: string;
      created_after?: string;
      created_before?: string;
    };
  }>(
    '/v1/billing/crypto-orders',
    { preHandler: [app.requireAuth, app.requireScope('read:billing'), app.rateLimit('global')] },
    async (
      req: FastifyRequest<{
        Querystring: {
          limit?: string;
          status?: string;
          cursor?: string;
          created_after?: string;
          created_before?: string;
        };
      }>,
      reply,
    ) => {
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
      // V-666.BU — cursor pagination. The service produces a
      // next_cursor when there's at least one more matching row
      // beyond the returned page; null otherwise. Consumers loop
      // until they get null.
      const createdAfter =
        query.created_after !== undefined ? new Date(query.created_after).getTime() : undefined;
      const createdBefore =
        query.created_before !== undefined ? new Date(query.created_before).getTime() : undefined;
      // V-666.BZ — reject obviously-wrong windows (before <= after).
      // The empty result was previously silent, which masked common
      // bugs (swapped args, missing tz suffix).
      if (
        createdAfter !== undefined &&
        createdBefore !== undefined &&
        createdBefore <= createdAfter
      ) {
        throw new BadRequestError('created_before must be strictly greater than created_after.');
      }
      const page = await deps.service.listForAdminPage({
        accountId: ctx.account.id,
        ...(limit !== undefined ? { limit } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(createdAfter !== undefined ? { createdAfter } : {}),
        ...(createdBefore !== undefined ? { createdBefore } : {}),
      });
      // V-666.AW — order state changes constantly between mints + IPNs;
      // shared / proxy caches must never serve stale state. `private`
      // additionally signals that even browser caches shouldn't share
      // the response across users on the same machine.
      void reply.header('cache-control', 'no-store, private');
      return reply.send({
        orders: page.orders.map(toPublic),
        next_cursor: page.nextCursor,
      });
    },
  );

  app.get<{ Params: { order_id: string } }>(
    '/v1/billing/crypto-orders/:order_id',
    { preHandler: [app.requireAuth, app.requireScope('read:billing'), app.rateLimit('global')] },
    async (req: FastifyRequest<{ Params: { order_id: string } }>, reply) => {
      const ctx = requireCtx(req);
      const params = parseOrThrow(GetParams, req.params);
      const order = await deps.service.getById(params.order_id);
      if (order === null || order.account_id !== ctx.account.id) {
        throw new NotFoundError(`No crypto order with id "${params.order_id}".`);
      }
      // V-666.AW — same no-store, private rationale: status flips
      // mid-checkout (pending → confirming → paid) and we never want
      // a cached pending response to mask a paid IPN.
      void reply.header('cache-control', 'no-store, private');
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
    // W496 — admin:billing on the order-note write (account_owner satisfies, V-481).
    { preHandler: [app.requireAuth, app.requireScope('admin:billing'), app.rateLimit('global')] },
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
    { preHandler: [app.requireAuth, app.requireScope('read:billing'), app.rateLimit('global')] },
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
    { preHandler: [app.requireAuth, app.requireScope('read:billing'), app.rateLimit('global')] },
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
    { preHandler: [app.requireAuth, app.requireScope('read:billing'), app.rateLimit('global')] },
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
    // W496 — admin:billing: cancelling an order is a subscription-change action.
    { preHandler: [app.requireAuth, app.requireScope('admin:billing'), app.rateLimit('global')] },
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
          `Order is in state "${result.reason}" and can no longer be cancelled. Crypto payments are non-refundable; contact support if you need to discuss reconciliation.`,
          { resource: 'crypto_order', field: 'status' },
        );
      }
      return reply.send(toPublic(result.order));
    },
  );
}

function parseOrThrow<T>(schema: z.ZodSchema<T>, input: unknown): T {
  const result = schema.safeParse(input);
  // Don't leak the raw serialized zod error (full issue/path JSON) into the
  // customer-facing problem detail; this helper validates several shapes
  // (query params + body), so keep the message generic.
  if (!result.success) throw new BadRequestError('Invalid request parameters.');
  return result.data;
}
