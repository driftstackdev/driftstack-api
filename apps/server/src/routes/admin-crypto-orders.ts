// V-666.D — admin crypto-orders routes.
//
//   GET   /v1/admin/crypto-orders?account_id=acc_X&limit=N
//   GET   /v1/admin/crypto-orders.csv                        (V-666.V)
//   GET   /v1/admin/crypto-orders/stats                      (V-666.N)
//   GET   /v1/admin/crypto-orders/daily?days=N               (V-666.O)
//   GET   /v1/admin/crypto-orders/pending-age                (V-666.AC)
//   GET   /v1/admin/crypto-orders/idempotency-metrics        (V-666.AP)
//   GET   /v1/admin/crypto-orders/:order_id
//   GET   /v1/admin/crypto-orders/:order_id/events           (V-666.AT)
//   POST  /v1/admin/crypto-orders/:order_id/apply-ipn        (V-666.F)
//   POST  /v1/admin/crypto-orders/sweep-expired              (V-666.L)
//   PATCH /v1/admin/crypto-orders/:order_id/internal-note    (V-666.AA)
//
// Auth: driftstack_internal_admin scope. Used by the founder dashboard
// + support ops to look up the order behind a customer's
// "I sent the payment but the dashboard still says pending" ticket.
//
// Mostly read-only reporting. Three endpoints mutate: apply-ipn and
// sweep-expired advance order state through the same forward-only
// crypto-order state machine as the public IPN pipeline (V-666 / B)
// (neither bypasses it); internal-note sets an admin-only annotation
// field that is not part of the order state machine.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { buildCsv } from '../lib/csv.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import type { CryptoOrder, CryptoOrdersService } from '../services/crypto-orders.js';
import type { AdminAuditService, AdminAuditAction } from '../services/admin-audit.js';
import { readClientIp } from '../lib/client-ip.js';

export interface RegisterAdminCryptoOrdersRoutesDeps {
  service: CryptoOrdersService;
  /**
   * D-025 audit-gap fix — sweep-expired / apply-ipn / internal-note are
   * the 3 mutating endpoints on this route file; each now writes an
   * admin_audit_log row (success + failure) before responding, matching
   * every other admin route (see admin-accounts.ts's withAudit shape).
   */
  audit: AdminAuditService;
}

/**
 * V-1592 — the published filter form is `acc_<uuid>`, as the header of this file
 * says, and it was handed to a repo that filters `crypto_orders.account_id` — a
 * `uuid` column. So the documented usage was a cast error, not a filter: against
 * a real database `?account_id=acc_<uuid>` answered 500, and only the
 * undocumented bare-uuid form worked. Every test missed it because the in-memory
 * repo stores the id as a plain string, where `acc_1` is a perfectly good key.
 *
 * Both forms are accepted and the uuid is what reaches the repo; anything else
 * is refused as a bad request rather than becoming a server error.
 */
const ACCOUNT_FILTER_RE =
  /^(?:acc_)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function accountUuidFromFilter(value: string): string {
  const match = ACCOUNT_FILTER_RE.exec(value);
  if (!match?.[1]) {
    throw new BadRequestError('Invalid account_id. Expected "acc_<uuid>" or a bare UUID.');
  }
  return match[1];
}

const ListQuery = z.object({
  // account_id is `acc_<36-char-uuid>` (40 chars). 100 cap (slice 116
  // pattern) blocks multi-KB strings that would bloat the 400/404
  // problem+json body if the filter doesn't match anything.
  account_id: z.string().min(1).max(100).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  // V-666.T — admin search/filter knobs.
  status: z.enum(['pending', 'confirming', 'paid', 'failed', 'partial', 'cancelled']).optional(),
  search: z.string().min(1).max(200).optional(),
  // V-666.AS — exact-match payment_id filter. Capped at 128 so abuse
  // can't bloat the query log; real NowPayments ids are ~20 chars.
  payment_id: z.string().min(1).max(128).optional(),
  // V-666.AM — opaque cursor returned by a prior page's
  // `next_cursor`. Length-bounded to keep abusive callers honest.
  cursor: z.string().min(1).max(512).optional(),
  // V-666.BY — half-open created_at window. Same shape as the
  // customer endpoint (V-666.BX). Useful for the operator answering
  // "show me all the paid orders between March 1 and April 1".
  created_after: z.string().datetime().optional(),
  created_before: z.string().datetime().optional(),
});

const GetParams = z.object({
  // order_id is `ord_<36-char-uuid>` (40 chars); 100 cap = headroom.
  order_id: z.string().min(1).max(100),
});

// V-666.F — admin manual IPN application. Operator path: when
// NowPayments fails to deliver an IPN (rare), ops can advance an
// order by hand by posting the provider_status they observed in
// the NowPayments dashboard. The same state machine that the real
// IPN route uses applies (forward-only, reverse-to-pending rejected).
const ApplyIpnBody = z.object({
  // provider_status is a NowPayments status string (~20 chars typical:
  // 'waiting' / 'confirming' / 'finished' / etc). 64 cap is generous.
  provider_status: z.string().min(1).max(64),
  // payment_id is a NowPayments opaque id (~20 chars typical); 128
  // matches the ListQuery filter cap.
  payment_id: z.string().min(1).max(128),
});

// V-666.L — admin sweep-trigger body. olderThanHours defaults to 24h
// (matching the typical NowPayments payment window); limit defaults
// to 500 (matching the service's own per-tick cap).
const SweepBody = z.object({
  older_than_hours: z.number().int().min(1).max(8760).optional(), // up to 1 year
  limit: z.number().int().min(1).max(500).optional(),
});

// V-666.O — daily-breakdown query. days bounded to 90 to keep the
// O(N orders) scan affordable; longer reports should pull from a
// warehouse, not the live in-memory repo.
const DailyQuery = z.object({
  days: z.string().regex(/^\d+$/).optional(),
});

// V-666.V — CSV export query. Same shape as ListQuery but with a
// higher limit ceiling (1000) since CSV is the export path.
const CsvQuery = z.object({
  // Same 100 cap as ListQuery — keep the two query schemas
  // structurally identical except for the limit ceiling.
  account_id: z.string().min(1).max(100).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  status: z.enum(['pending', 'confirming', 'paid', 'failed', 'partial', 'cancelled']).optional(),
  search: z.string().min(1).max(200).optional(),
  // V-666.BY — date-range filter; same shape as the JSON list.
  created_after: z.string().datetime().optional(),
  created_before: z.string().datetime().optional(),
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
    customer_note: order.customer_note ?? null,
    // V-666.AA — admin-only field; nullish-coalesce keeps older repo
    // fixtures serialising cleanly even before they round-trip through
    // the service's create() path.
    internal_note: order.internal_note ?? null,
    created_at: new Date(order.created_at).toISOString(),
    updated_at: new Date(order.updated_at).toISOString(),
  };
}

// V-666.AA — admin internal-note body. Empty string normalises to
// null at the service layer; 2000-char ceiling is twice the
// customer_note budget because internal runbooks tend to be longer.
const InternalNoteBody = z.object({
  internal_note: z.string().max(2000).nullable(),
});

export function registerAdminCryptoOrdersRoutes(
  app: FastifyInstance,
  deps: RegisterAdminCryptoOrdersRoutesDeps,
): void {
  // D-025 audit-gap fix — wraps a mutation with audit-on-success +
  // audit-on-error, same shape as admin-accounts.ts's withAudit. Orders
  // aren't account-scoped the way admin-accounts.ts's targets are, so
  // this records the order_id as targetResourceId (targetAccountId stays
  // unset — CryptoOrder.account_id is nullable + not the audit subject).
  // sweep-expired operates on a batch, not one order, so it passes `null`.
  async function withAudit<T>(
    request: FastifyRequest,
    action: AdminAuditAction,
    orderId: string | null,
    inputPayload: Record<string, unknown>,
    perform: () => Promise<T>,
  ): Promise<T> {
    const ctx = request.account;
    if (!ctx) throw new Error('account context missing after requireAuth');
    try {
      const result = await perform();
      await deps.audit.record({
        adminAccountId: ctx.account.id,
        adminKeyId: ctx.apiKey.id,
        action,
        targetResourceId: orderId,
        inputPayload,
        result: 'success',
        ipAddress: readClientIp(request),
      });
      return result;
    } catch (err) {
      const code =
        err instanceof Error && err.name ? err.name.toLowerCase().replace(/error$/, '') : 'unknown';
      await deps.audit.record({
        adminAccountId: ctx.account.id,
        adminKeyId: ctx.apiKey.id,
        action,
        targetResourceId: orderId,
        inputPayload,
        result: `error: ${code}`,
        ipAddress: readClientIp(request),
      });
      throw err;
    }
  }

  // V-666.BE — Cache-Control: no-store, private on admin crypto
  // responses. Used to live as a route-local onSend hook; promoted
  // to an app-level hook on /v1/admin/* in V-666.BT so every admin
  // endpoint (accounts, audit, sessions, webhooks, etc.) inherits
  // the same defense-in-depth header.
  app.get<{
    Querystring: {
      account_id?: string;
      limit?: string;
      status?: string;
      search?: string;
      payment_id?: string;
      cursor?: string;
      created_after?: string;
      created_before?: string;
    };
  }>(
    '/v1/admin/crypto-orders',
    { preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')] },
    async (
      req: FastifyRequest<{
        Querystring: {
          account_id?: string;
          limit?: string;
          status?: string;
          search?: string;
          payment_id?: string;
          cursor?: string;
          created_after?: string;
          created_before?: string;
        };
      }>,
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
      const createdAfter =
        query.created_after !== undefined ? new Date(query.created_after).getTime() : undefined;
      const createdBefore =
        query.created_before !== undefined ? new Date(query.created_before).getTime() : undefined;
      // V-666.BZ — same inverted-window guard as the customer route.
      if (
        createdAfter !== undefined &&
        createdBefore !== undefined &&
        createdBefore <= createdAfter
      ) {
        throw new BadRequestError('created_before must be strictly greater than created_after.');
      }
      const page = await deps.service.listForAdminPage({
        ...(query.account_id !== undefined
          ? { accountId: accountUuidFromFilter(query.account_id) }
          : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.search !== undefined ? { search: query.search } : {}),
        ...(query.payment_id !== undefined ? { paymentId: query.payment_id } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(createdAfter !== undefined ? { createdAfter } : {}),
        ...(createdBefore !== undefined ? { createdBefore } : {}),
      });
      return reply.send({
        orders: page.orders.map(toPublic),
        next_cursor: page.nextCursor,
      });
    },
  );

  // V-666.V — admin CSV export. Same filter set as the JSON list
  // route. Max limit raised to 1000 to match a typical export window;
  // for larger datasets the operator paginates by account_id /
  // date-bucket and concatenates. Returns text/csv with a Content-
  // Disposition attachment so a browser GET triggers a download.
  app.get<{
    Querystring: {
      account_id?: string;
      limit?: string;
      status?: string;
      search?: string;
      created_after?: string;
      created_before?: string;
    };
  }>(
    '/v1/admin/crypto-orders.csv',
    { preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')] },
    async (
      req: FastifyRequest<{
        Querystring: {
          account_id?: string;
          limit?: string;
          status?: string;
          search?: string;
          created_after?: string;
          created_before?: string;
        };
      }>,
      reply,
    ) => {
      const query = parseOrThrow(CsvQuery, req.query);
      let limit = 1000;
      if (query.limit !== undefined) {
        const n = Number.parseInt(query.limit, 10);
        if (!Number.isInteger(n) || n < 1 || n > 1000) {
          throw new BadRequestError('limit must be an integer between 1 and 1000.');
        }
        limit = n;
      }
      const createdAfter =
        query.created_after !== undefined ? new Date(query.created_after).getTime() : undefined;
      const createdBefore =
        query.created_before !== undefined ? new Date(query.created_before).getTime() : undefined;
      if (
        createdAfter !== undefined &&
        createdBefore !== undefined &&
        createdBefore <= createdAfter
      ) {
        throw new BadRequestError('created_before must be strictly greater than created_after.');
      }
      const orders = await deps.service.listForAdmin({
        ...(query.account_id !== undefined
          ? { accountId: accountUuidFromFilter(query.account_id) }
          : {}),
        limit,
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.search !== undefined ? { search: query.search } : {}),
        ...(createdAfter !== undefined ? { createdAfter } : {}),
        ...(createdBefore !== undefined ? { createdBefore } : {}),
      });
      const csv = buildCsv({
        header: [
          'order_id',
          'account_id',
          'product',
          'price_cents',
          'price_currency',
          'status',
          'payment_id',
          'customer_note',
          'internal_note',
          'created_at',
          'updated_at',
        ],
        rows: orders.map((o) => [
          o.order_id,
          o.account_id,
          o.product,
          o.price_cents,
          o.price_currency,
          o.status,
          o.payment_id,
          o.customer_note,
          o.internal_note ?? null,
          new Date(o.created_at).toISOString(),
          new Date(o.updated_at).toISOString(),
        ]),
      });
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="crypto-orders.csv"')
        .send(csv);
    },
  );

  // V-666.N — at-a-glance stats summary for the ops dashboard.
  // Counts per status + paid revenue per currency. Truncated when
  // more orders exist than the scan window (10k default).
  // V-666.W — adds avg_time_to_paid_ms + paid_sample for the ops
  // "how fast are customers actually paying" KPI.
  // V-666.AE — adds paid_revenue_by_product + paid_count_by_product
  // for the "which tiers are converting" KPI.
  app.get(
    '/v1/admin/crypto-orders/stats',
    { preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')] },
    async (_req, reply) => {
      const stats = await deps.service.getStatsForAdmin();
      return reply.send({
        total: stats.total,
        by_status: stats.byStatus,
        paid_revenue_cents: stats.paidRevenueCents,
        avg_time_to_paid_ms: stats.avgTimeToPaidMs,
        paid_sample: stats.paidSample,
        paid_revenue_by_product: stats.paidRevenueByProduct,
        paid_count_by_product: stats.paidCountByProduct,
        truncated: stats.truncated,
        scanned: stats.scanned,
      });
    },
  );

  // V-666.AP — idempotency-key counters. Cheap to scrape (no full-
  // table walk) — useful for noticing when retries spike (often a
  // client-side bug or a network-blip rate). Auth gated to the
  // internal admin scope same as the rest of this surface.
  app.get(
    '/v1/admin/crypto-orders/idempotency-metrics',
    { preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')] },
    (_req, reply) => {
      const m = deps.service.getIdempotencyMetrics();
      return reply.send({
        replays: m.replays,
        first_writes: m.firstWrites,
        // V-666.AR — body-fingerprint mismatch count. Trending non-
        // zero signals a client that's reusing keys across distinct
        // intents (often a hardcoded constant where a generated UUID
        // belongs).
        body_mismatches: m.bodyMismatches,
      });
    },
  );

  // V-666.AC — pending-orders age histogram. Buckets currently-
  // pending orders by age (under 1h / 1-6h / 6-24h / over 24h) so
  // ops can spot stale checkouts that should be swept or contacted.
  app.get(
    '/v1/admin/crypto-orders/pending-age',
    { preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')] },
    async (_req, reply) => {
      const histo = await deps.service.getPendingAgeHistogram();
      return reply.send({
        buckets: histo.buckets,
        pending_value_cents: histo.pendingValueCents,
        total: histo.total,
        truncated: histo.truncated,
        scanned: histo.scanned,
      });
    },
  );

  // V-666.O — per-day breakdown for the last N UTC days (default 7,
  // max 90). One row per (date, status) combination that had at
  // least one order in the window.
  app.get<{ Querystring: { days?: string } }>(
    '/v1/admin/crypto-orders/daily',
    { preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')] },
    async (req: FastifyRequest<{ Querystring: { days?: string } }>, reply) => {
      const query = parseOrThrow(DailyQuery, req.query);
      let days = 7;
      if (query.days !== undefined) {
        const n = Number.parseInt(query.days, 10);
        if (!Number.isInteger(n) || n < 1 || n > 90) {
          throw new BadRequestError('days must be an integer between 1 and 90.');
        }
        days = n;
      }
      const breakdown = await deps.service.getDailyBreakdownForAdmin({ days });
      return reply.send({
        days: breakdown.days,
        rows: breakdown.rows,
        truncated: breakdown.truncated,
      });
    },
  );

  app.get<{ Params: { order_id: string } }>(
    '/v1/admin/crypto-orders/:order_id',
    { preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')] },
    async (req: FastifyRequest<{ Params: { order_id: string } }>, reply) => {
      const params = parseOrThrow(GetParams, req.params);
      const order = await deps.service.getById(params.order_id);
      if (order === null) {
        throw new NotFoundError(`No crypto order with id "${params.order_id}".`);
      }
      return reply.send(toPublic(order));
    },
  );

  // V-666.AT — order events timeline. Returns the order's append-
  // only event log oldest-first. The customer-facing surface
  // doesn't expose this yet; the admin drawer is the first
  // consumer. Each event carries the destination status, the
  // server timestamp, and the source ('create' / 'ipn' / 'cancel'
  // / 'expired' / 'swept').
  app.get<{ Params: { order_id: string } }>(
    '/v1/admin/crypto-orders/:order_id/events',
    { preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')] },
    async (req: FastifyRequest<{ Params: { order_id: string } }>, reply) => {
      const params = parseOrThrow(GetParams, req.params);
      const events = await deps.service.getOrderEvents(params.order_id);
      if (events === null) {
        throw new NotFoundError(`No crypto order with id "${params.order_id}".`);
      }
      return reply.send({
        events: events.map((e) => ({
          status: e.status,
          at: new Date(e.at).toISOString(),
          source: e.source,
        })),
      });
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
    { preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')] },
    async (req: FastifyRequest<{ Body: { older_than_hours?: number; limit?: number } }>, reply) => {
      const body = parseOrThrow(SweepBody, req.body ?? {});
      const olderThanHours = body.older_than_hours ?? 24;
      const olderThanMs = olderThanHours * 60 * 60 * 1000;
      const result = await withAudit(
        req,
        'crypto_order.swept',
        null,
        {
          older_than_hours: olderThanHours,
          ...(body.limit !== undefined ? { limit: body.limit } : {}),
        },
        () =>
          deps.service.sweepExpiredOrders({
            olderThanMs,
            ...(body.limit !== undefined ? { limit: body.limit } : {}),
          }),
      );
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
    { preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')] },
    async (
      req: FastifyRequest<{
        Params: { order_id: string };
        Body: { provider_status?: string; payment_id?: string };
      }>,
      reply,
    ) => {
      const params = parseOrThrow(GetParams, req.params);
      const body = parseOrThrow(ApplyIpnBody, req.body);
      const updated = await withAudit(
        req,
        'crypto_order.ipn_applied',
        params.order_id,
        { provider_status: body.provider_status, payment_id: body.payment_id },
        async () => {
          const result = await deps.service.applyIpnStatus({
            order_id: params.order_id,
            payment_id: body.payment_id,
            provider_status: body.provider_status,
          });
          if (result === null) {
            throw new NotFoundError(`No crypto order with id "${params.order_id}".`);
          }
          return result;
        },
      );
      return reply.send(toPublic(updated));
    },
  );

  // V-666.AA — admin sets / clears the internal-note field on an
  // order. PATCH semantics: send { internal_note: "..." } to set,
  // { internal_note: null } or { internal_note: "" } to clear.
  app.patch<{
    Params: { order_id: string };
    Body: { internal_note?: string | null };
  }>(
    '/v1/admin/crypto-orders/:order_id/internal-note',
    { preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')] },
    async (
      req: FastifyRequest<{
        Params: { order_id: string };
        Body: { internal_note?: string | null };
      }>,
      reply,
    ) => {
      const params = parseOrThrow(GetParams, req.params);
      const body = parseOrThrow(InternalNoteBody, req.body);
      const updated = await withAudit(
        req,
        'crypto_order.note_updated',
        params.order_id,
        { internal_note: body.internal_note },
        async () => {
          const result = await deps.service.setInternalNote({
            order_id: params.order_id,
            internal_note: body.internal_note,
          });
          if (result === null) {
            throw new NotFoundError(`No crypto order with id "${params.order_id}".`);
          }
          return result;
        },
      );
      return reply.send(toPublic(updated));
    },
  );
}

function parseOrThrow<T>(schema: z.ZodSchema<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestError(result.error.message);
  return result.data;
}
