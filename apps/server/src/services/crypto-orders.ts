// V-666.B — crypto-orders service.
//
// In-memory order store + state machine for the NowPayments IPN flow.
// Customer-side `/checkout/crypto` opens an order → backend records
// it + returns the payment address → NowPayments IPN posts status
// updates → service transitions the order state.
//
// V-666.B posture: no DB persistence yet (crypto_orders table is a
// V-666.C follow-up gated on real merchant traffic). The in-memory
// store works for the early-customer manual-handoff cadence the
// founder expects in the first 4-8 weeks post-merchant-account-go-live.

export type CryptoOrderStatus =
  | 'pending' // order created; awaiting payment
  | 'confirming' // payment seen; awaiting on-chain confirmations
  | 'paid' // confirmations received; goods unlocked
  | 'failed' // payment timeout / refund / expired
  | 'partial' // amount received < expected
  // V-666.J — customer-initiated abandonment of a pending order before
  // any payment was received. Terminal; the IPN flow won't transition
  // out of it (a late-arriving payment leaves the order cancelled but
  // records the payment_id so support can reconcile).
  | 'cancelled';

export interface CryptoOrder {
  /** Internal order id; the customer also sees this on the checkout page. */
  order_id: string;
  /** Account this order is attributable to. Null for pre-signup checkouts. */
  account_id: string | null;
  /** Tier being purchased (or 'trial_pack'). */
  product: string;
  /** Expected payment in fiat-cents. */
  price_cents: number;
  /** Fiat currency the price_cents are denominated in. */
  price_currency: string;
  /** NowPayments payment_id once the order is matched to an IPN. */
  payment_id: string | null;
  status: CryptoOrderStatus;
  /**
   * V-666.Q — customer-supplied free-text note for their own
   * bookkeeping (PO numbers, internal labels, etc.). Capped at 500
   * chars at the route layer. Null when unset.
   */
  customer_note: string | null;
  /**
   * V-666.X — admin-recorded refund intent. Set on the first
   * requestRefund() call against a paid order; never cleared on
   * subsequent calls. The actual on-chain refund still goes through
   * the manual NowPayments dashboard — this field is the system-of-
   * record for "ops promised this customer a refund." Null when no
   * refund has been requested.
   */
  refund_requested_at: number | null;
  /**
   * V-666.X — operator-supplied reason for the refund. Capped at 500
   * chars at the route layer. Updated by subsequent requestRefund()
   * calls so support can amend the rationale without rotating
   * refund_requested_at.
   */
  refund_reason: string | null;
  /**
   * V-666.AA — admin-only internal note attached to the order. Used
   * by ops to record context that should NOT be visible to the
   * customer (e.g. "VIP account, manual outreach", "fraud signal,
   * watch for chargeback"). Capped at 2000 chars at the route layer
   * — twice the customer_note budget since these are internal +
   * support runbooks tend to be more verbose. Null when unset.
   */
  internal_note: string | null;
  created_at: number;
  updated_at: number;
}

export interface CryptoOrdersRepo {
  upsert(order: CryptoOrder): Promise<void>;
  getById(orderId: string): Promise<CryptoOrder | null>;
  /**
   * Admin / ops list. Filters by accountId when supplied; limits to
   * `limit` rows (default 50) ordered by created_at DESC.
   */
  listAll(opts?: { accountId?: string; limit?: number }): Promise<CryptoOrder[]>;
}

export class InMemoryCryptoOrdersRepo implements CryptoOrdersRepo {
  private readonly orders = new Map<string, CryptoOrder>();
  // eslint-disable-next-line @typescript-eslint/require-await
  async upsert(order: CryptoOrder): Promise<void> {
    this.orders.set(order.order_id, order);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async getById(orderId: string): Promise<CryptoOrder | null> {
    return this.orders.get(orderId) ?? null;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async listAll(opts: { accountId?: string; limit?: number } = {}): Promise<CryptoOrder[]> {
    const limit = opts.limit ?? 50;
    const all = Array.from(this.orders.values());
    const filtered =
      opts.accountId !== undefined ? all.filter((o) => o.account_id === opts.accountId) : all;
    return filtered.sort((a, b) => b.created_at - a.created_at).slice(0, limit);
  }
}

/**
 * NowPayments payment_status values map to our internal status set.
 * Reference:
 *   https://documenter.getpostman.com/view/7907941/2s93JusNJt#field-payment-status
 */
export function mapNowpaymentsStatus(provider: string): CryptoOrderStatus | null {
  switch (provider) {
    case 'waiting':
      return 'pending';
    case 'confirming':
    case 'sending':
      return 'confirming';
    case 'partially_paid':
      return 'partial';
    case 'finished':
      return 'paid';
    case 'failed':
    case 'expired':
    case 'refunded':
      return 'failed';
    default:
      return null; // unknown provider status — caller decides what to do.
  }
}

export interface CryptoOrdersServiceOpts {
  repo: CryptoOrdersRepo;
  /** Test seam — defaults to Date.now. */
  nowFn?: () => number;
  /**
   * V-666.I — optional webhook emitter (wire-ready posture). When
   * provided, applyIpnStatus fires `crypto.order.paid` whenever an
   * order transitions to the paid state. Best-effort: emission
   * failures don't roll back the state transition.
   *
   * Production wiring is deferred — the
   * `webhook_event_type` Postgres enum does NOT yet carry
   * `crypto.order.paid`. Adding it requires a forward migration; until
   * that lands the bootstrap MUST NOT pass a `WebhooksService`-backed
   * emitter here (the INSERT into webhook_deliveries would 22P02
   * invalid input value for enum). Unit tests pass a local mock
   * emitter that doesn't go through the DB.
   */
  webhooks?: CryptoOrderWebhookEmitter;
  /**
   * V-666.R — optional "paid receipt email" notifier. Same wire-ready
   * posture as `webhooks`: when supplied, applyIpnStatus invokes it on
   * the same paid-transition where the webhook fires. Best-effort:
   * notifier errors are swallowed so the IPN ack stays 200.
   *
   * The notifier is an *intent emitter* — it does not directly call
   * Postmark. Production wiring routes through the existing
   * EmailService template path (template ID + per-account locale
   * resolution belongs there). In tests, a local mock captures the
   * intent so we can assert the args without standing up the email
   * pipeline.
   */
  paidEmailNotifier?: CryptoOrderPaidEmailNotifier;
}

/**
 * V-666.I — local emitter contract. Decoupled from {@link WebhooksService}
 * on purpose: this interface accepts the literal `'crypto.order.paid'`
 * even though the WebhookEventType union does not yet include it. The
 * separation lets the V-666.I emission path land + be tested ahead of
 * the DB migration that adds the enum value.
 */
export interface CryptoOrderWebhookEmitter {
  enqueueEvent: (
    accountId: string,
    eventType: 'crypto.order.paid',
    data: Record<string, unknown>,
  ) => Promise<number>;
}

/**
 * V-666.R — local notifier contract for the "receipt email on paid"
 * scaffold. Same decoupling rationale as
 * {@link CryptoOrderWebhookEmitter}: the service emits an intent and
 * the production EmailService consumes it. Tests pass a mock
 * implementation so the paid-transition fan-out is verifiable without
 * the Postmark wiring.
 */
export interface CryptoOrderPaidEmail {
  account_id: string;
  order_id: string;
  product: string;
  price_cents: number;
  price_currency: string;
  payment_id: string | null;
  paid_at: string;
}

export interface CryptoOrderPaidEmailNotifier {
  notifyOrderPaid: (intent: CryptoOrderPaidEmail) => Promise<void>;
}

export class CryptoOrdersService {
  private readonly nowFn: () => number;
  constructor(private readonly opts: CryptoOrdersServiceOpts) {
    this.nowFn = opts.nowFn ?? Date.now;
  }

  async create(args: {
    order_id: string;
    account_id: string | null;
    product: string;
    price_cents: number;
    price_currency: string;
  }): Promise<CryptoOrder> {
    const now = this.nowFn();
    const order: CryptoOrder = {
      order_id: args.order_id,
      account_id: args.account_id,
      product: args.product,
      price_cents: args.price_cents,
      price_currency: args.price_currency,
      payment_id: null,
      status: 'pending',
      customer_note: null,
      refund_requested_at: null,
      refund_reason: null,
      internal_note: null,
      created_at: now,
      updated_at: now,
    };
    await this.opts.repo.upsert(order);
    return order;
  }

  /**
   * V-666.X — admin records the intent to refund a paid order. This
   * is a system-of-record write, not an on-chain action: the actual
   * refund goes through the NowPayments dashboard. The method
   * preserves the first `refund_requested_at` timestamp on
   * subsequent calls so we keep the canonical "when did this start"
   * answer even if support amends the reason text.
   *
   * Returns:
   *   - { ok: 'recorded', order } on success
   *   - { ok: 'not_paid', currentStatus } when the order isn't in
   *     the paid state (only paid orders can be refunded)
   *   - null when the order doesn't exist
   */
  async requestRefund(args: {
    order_id: string;
    reason: string;
  }): Promise<
    | { ok: 'recorded'; order: CryptoOrder }
    | { ok: 'not_paid'; currentStatus: CryptoOrderStatus }
    | null
  > {
    const order = await this.opts.repo.getById(args.order_id);
    if (order === null) return null;
    if (order.status !== 'paid') {
      return { ok: 'not_paid', currentStatus: order.status };
    }
    const now = this.nowFn();
    const updated: CryptoOrder = {
      ...order,
      refund_requested_at: order.refund_requested_at ?? now,
      refund_reason: args.reason,
      updated_at: now,
    };
    await this.opts.repo.upsert(updated);
    return { ok: 'recorded', order: updated };
  }

  /**
   * V-666.AA — admin sets / updates / clears the internal note on
   * an order. Works on every status (unlike requestRefund which is
   * paid-only) since ops may want to record context on a pending
   * order ("customer reached out about wallet network mistake") just
   * as much as on a paid one. Empty string normalises to null so
   * "clearing" the note is the same code path as "unset".
   *
   * Returns the updated order, or null when the order doesn't exist.
   */
  async setInternalNote(args: {
    order_id: string;
    internal_note: string | null;
  }): Promise<CryptoOrder | null> {
    const order = await this.opts.repo.getById(args.order_id);
    if (order === null) return null;
    const normalised =
      args.internal_note === null || args.internal_note.length === 0 ? null : args.internal_note;
    const updated: CryptoOrder = {
      ...order,
      internal_note: normalised,
      updated_at: this.nowFn(),
    };
    await this.opts.repo.upsert(updated);
    return updated;
  }

  /**
   * V-666.Y — admin clears a previously-recorded refund request.
   * Used when the customer reconsiders or ops determines the refund
   * was raised in error. Both refund_requested_at + refund_reason
   * are reset to null. Idempotent: calling on an order with no
   * existing refund returns ok:'noop' so ops scripts don't need to
   * check first.
   *
   * Returns:
   *   - { ok: 'cleared', order } when a refund was previously set
   *     and is now cleared
   *   - { ok: 'noop' } when no refund had been requested
   *   - null when the order doesn't exist
   */
  async cancelRefundRequest(args: {
    order_id: string;
  }): Promise<{ ok: 'cleared'; order: CryptoOrder } | { ok: 'noop' } | null> {
    const order = await this.opts.repo.getById(args.order_id);
    if (order === null) return null;
    if (order.refund_requested_at === null) return { ok: 'noop' };
    const updated: CryptoOrder = {
      ...order,
      refund_requested_at: null,
      refund_reason: null,
      updated_at: this.nowFn(),
    };
    await this.opts.repo.upsert(updated);
    return { ok: 'cleared', order: updated };
  }

  /**
   * V-666.Q — customer-side note update. Caller scopes to their own
   * account; cross-account PATCH returns null (404-style). Empty
   * string is normalised to null. Length cap enforced at the route
   * layer; this method trusts whatever the route validated.
   */
  async updateCustomerNote(args: {
    order_id: string;
    account_id: string;
    customer_note: string | null;
  }): Promise<CryptoOrder | null> {
    const order = await this.opts.repo.getById(args.order_id);
    if (order === null || order.account_id !== args.account_id) return null;
    const normalised =
      args.customer_note === null || args.customer_note.length === 0 ? null : args.customer_note;
    const updated: CryptoOrder = {
      ...order,
      customer_note: normalised,
      updated_at: this.nowFn(),
    };
    await this.opts.repo.upsert(updated);
    return updated;
  }

  async getById(orderId: string): Promise<CryptoOrder | null> {
    return this.opts.repo.getById(orderId);
  }

  /**
   * V-666.D — admin-only list. Returns the most-recent `limit` orders
   * across all customers, optionally filtered by account_id. Sort
   * order is `created_at DESC`.
   *
   * V-666.T — extends with optional status filter + free-text search
   * across order_id / product / customer_note. Filters apply in-service
   * post-fetch; the repo scan window is bumped to `scanLimit` (default
   * 1_000) so a narrow filter on a large backlog still returns enough
   * rows. The DB-backed repo (V-666.C) will push the filters to SQL.
   */
  async listForAdmin(
    opts: {
      accountId?: string;
      limit?: number;
      status?: CryptoOrderStatus;
      search?: string;
      scanLimit?: number;
    } = {},
  ): Promise<CryptoOrder[]> {
    const limit = opts.limit ?? 50;
    const scanLimit = opts.scanLimit ?? 1_000;
    const rawScanLimit = opts.status !== undefined || opts.search !== undefined ? scanLimit : limit;
    const raw = await this.opts.repo.listAll({
      ...(opts.accountId !== undefined ? { accountId: opts.accountId } : {}),
      limit: rawScanLimit,
    });
    const needle = opts.search?.toLowerCase().trim();
    const filtered = raw.filter((o) => {
      if (opts.status !== undefined && o.status !== opts.status) return false;
      if (needle !== undefined && needle.length > 0) {
        const hay =
          o.order_id.toLowerCase() +
          '|' +
          o.product.toLowerCase() +
          '|' +
          (o.customer_note?.toLowerCase() ?? '');
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    return filtered.slice(0, limit);
  }

  /**
   * V-666.J — customer-initiated cancel on a pending order. Only
   * `pending` orders can be cancelled; once a payment has been seen
   * (confirming/partial) the cancellation must go through support so
   * the customer's on-chain funds can be reconciled.
   *
   * Returns { ok: 'cancelled' } on success, or { ok: 'not_cancellable',
   * reason } when the order is already past the cancellable window.
   * Returns null when the order doesn't exist OR doesn't belong to
   * the supplied accountId (404-style; we don't leak existence of
   * other accounts' orders).
   */
  async cancelOrder(args: {
    order_id: string;
    account_id: string;
  }): Promise<
    | { ok: 'cancelled'; order: CryptoOrder }
    | { ok: 'not_cancellable'; reason: CryptoOrderStatus }
    | null
  > {
    const order = await this.opts.repo.getById(args.order_id);
    if (order === null || order.account_id !== args.account_id) return null;
    if (order.status !== 'pending') {
      return { ok: 'not_cancellable', reason: order.status };
    }
    const updated: CryptoOrder = {
      ...order,
      status: 'cancelled',
      updated_at: this.nowFn(),
    };
    await this.opts.repo.upsert(updated);
    return { ok: 'cancelled', order: updated };
  }

  /**
   * V-666.O — admin per-day breakdown. Counts orders created in
   * each of the last `days` UTC dates (inclusive of today), grouped
   * by created_at date and status. Returns one row per (date, status)
   * combination that has at least one order; days with no orders are
   * omitted from the response (the caller fills gaps client-side if
   * a zero-fill chart is wanted).
   *
   * scanLimit caps the lookback window the same way as getStatsForAdmin
   * to avoid blowing up on large backlogs.
   */
  async getDailyBreakdownForAdmin(
    opts: {
      days?: number;
      scanLimit?: number;
    } = {},
  ): Promise<{
    days: number;
    rows: Array<{ date: string; status: CryptoOrderStatus; count: number }>;
    truncated: boolean;
  }> {
    const days = opts.days ?? 7;
    const scanLimit = opts.scanLimit ?? 10_000;
    const now = this.nowFn();
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const rows = await this.opts.repo.listAll({ limit: scanLimit });
    const buckets = new Map<string, number>();
    for (const o of rows) {
      if (o.created_at < cutoff) continue;
      const date = new Date(o.created_at).toISOString().slice(0, 10);
      const key = `${date}::${o.status}`;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    const out: Array<{ date: string; status: CryptoOrderStatus; count: number }> = [];
    for (const [key, count] of buckets) {
      const [date, status] = key.split('::') as [string, CryptoOrderStatus];
      out.push({ date, status, count });
    }
    // Stable sort: date asc, then status alphabetical for predictable output.
    out.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.status < b.status ? -1 : 1;
    });
    return {
      days,
      rows: out,
      truncated: rows.length === scanLimit,
    };
  }

  /**
   * V-666.N — admin stats summary across all orders. Returns
   * counts per status, total order count, and total paid revenue
   * (sum of price_cents on `paid` orders) per currency. Currency-
   * split because we accept multiple fiat currencies and can't
   * sum across them without a conversion table.
   *
   * The summary scans up to `scanLimit` orders (default 10_000)
   * and sets `truncated=true` when more orders exist beyond that
   * window — operators reading a truncated summary know to widen
   * the limit OR move analytics to a proper warehouse.
   */
  async getStatsForAdmin(opts: { scanLimit?: number } = {}): Promise<{
    total: number;
    byStatus: Record<CryptoOrderStatus, number>;
    paidRevenueCents: Record<string, number>;
    /**
     * V-666.W — mean elapsed time, in milliseconds, between order
     * creation and the paid transition, averaged across every paid
     * order in the scan window. Null when no paid orders are in
     * scope (avoids returning 0, which would imply "instant paid"
     * rather than "no data").
     */
    avgTimeToPaidMs: number | null;
    /** V-666.W — count of paid orders used to compute avgTimeToPaidMs. */
    paidSample: number;
    truncated: boolean;
    scanned: number;
  }> {
    const scanLimit = opts.scanLimit ?? 10_000;
    const rows = await this.opts.repo.listAll({ limit: scanLimit });
    const byStatus: Record<CryptoOrderStatus, number> = {
      pending: 0,
      confirming: 0,
      paid: 0,
      failed: 0,
      partial: 0,
      cancelled: 0,
    };
    const paidRevenueCents: Record<string, number> = {};
    let paidElapsedSumMs = 0;
    let paidSample = 0;
    for (const o of rows) {
      byStatus[o.status] += 1;
      if (o.status === 'paid') {
        paidRevenueCents[o.price_currency] =
          (paidRevenueCents[o.price_currency] ?? 0) + o.price_cents;
        // V-666.W — updated_at on a paid order is the moment the IPN
        // applied the paid transition; created_at is order mint. The
        // difference is the customer's "time-to-pay" for that order.
        const elapsed = o.updated_at - o.created_at;
        if (elapsed >= 0) {
          paidElapsedSumMs += elapsed;
          paidSample += 1;
        }
      }
    }
    return {
      total: rows.length,
      byStatus,
      paidRevenueCents,
      avgTimeToPaidMs: paidSample > 0 ? Math.round(paidElapsedSumMs / paidSample) : null,
      paidSample,
      truncated: rows.length === scanLimit,
      scanned: rows.length,
    };
  }

  /**
   * V-666.M — build a normalized receipt payload for an order the
   * caller owns. Returns null when the order doesn't exist OR
   * belongs to another account (404-style; no existence leak).
   *
   * Works for any status, not just paid — the consuming UI gates
   * the "download PDF" affordance on `status === 'paid'`. For non-
   * paid orders, `payment_id` + `paid_at` are null and the receipt
   * acts as an order summary.
   */
  async getReceipt(args: { order_id: string; account_id: string; issued_at?: number }): Promise<{
    order_id: string;
    issued_at: string;
    status: CryptoOrderStatus;
    product: string;
    price_cents: number;
    price_currency: string;
    payment_id: string | null;
    paid_at: string | null;
    created_at: string;
  } | null> {
    const order = await this.opts.repo.getById(args.order_id);
    if (order === null || order.account_id !== args.account_id) return null;
    const issuedAt = args.issued_at ?? this.nowFn();
    return {
      order_id: order.order_id,
      issued_at: new Date(issuedAt).toISOString(),
      status: order.status,
      product: order.product,
      price_cents: order.price_cents,
      price_currency: order.price_currency,
      payment_id: order.payment_id,
      paid_at: order.status === 'paid' ? new Date(order.updated_at).toISOString() : null,
      created_at: new Date(order.created_at).toISOString(),
    };
  }

  /**
   * V-666.K — auto-expire a single pending order if it's older than
   * `olderThanMs`. Only `pending` orders are eligible; orders that
   * have seen any payment activity (confirming/partial/paid/failed/
   * cancelled) are left alone — those require explicit ops handling.
   *
   * Maps to `failed` rather than a new status because the existing
   * `failed` already documents "payment timeout / refund / expired"
   * as its semantic. Returns the updated order on expiry, or null
   * when the order doesn't exist / isn't expirable / isn't old enough.
   */
  async expireOrder(args: { order_id: string; olderThanMs: number }): Promise<CryptoOrder | null> {
    const order = await this.opts.repo.getById(args.order_id);
    if (order === null) return null;
    if (order.status !== 'pending') return null;
    const now = this.nowFn();
    if (now - order.created_at < args.olderThanMs) return null;
    const updated: CryptoOrder = {
      ...order,
      status: 'failed',
      updated_at: now,
    };
    await this.opts.repo.upsert(updated);
    return updated;
  }

  /**
   * V-666.K — bulk-sweep pending orders older than `olderThanMs`,
   * transitioning each to `failed`. Designed for a nightly cron tick.
   *
   * Returns `{ expired, capped }`:
   *   - `expired` — number of orders flipped to `failed` this tick.
   *   - `capped` — true when the sweep hit `limit` (more may remain;
   *     the cron should re-run until `capped: false`). We can't return
   *     an exact "remaining" without scanning the full table, which
   *     defeats the point of the limit; `capped` is the honest signal.
   *
   * Limit caps the work-per-tick so a long-stuck backlog doesn't
   * block the cron for minutes; the next tick picks up the remainder.
   * Default limit = 500.
   */
  async sweepExpiredOrders(opts: {
    olderThanMs: number;
    limit?: number;
  }): Promise<{ expired: number; capped: boolean }> {
    const limit = opts.limit ?? 500;
    const candidates = await this.opts.repo.listAll({ limit });
    const now = this.nowFn();
    const eligible = candidates.filter(
      (o) => o.status === 'pending' && now - o.created_at >= opts.olderThanMs,
    );
    let expired = 0;
    for (const o of eligible) {
      const updated: CryptoOrder = {
        ...o,
        status: 'failed',
        updated_at: now,
      };
      await this.opts.repo.upsert(updated);
      expired += 1;
    }
    return { expired, capped: expired === limit };
  }

  /**
   * Apply a NowPayments IPN update to the order with the given
   * order_id. Returns the new order state, or null when the order
   * doesn't exist (the IPN is then logged + ignored — we don't
   * create orders from an IPN; the checkout flow does that).
   *
   * State transitions:
   *   pending → confirming / partial / paid / failed
   *   confirming → paid / failed / partial
   *   partial → paid / failed (terminal partial doesn't auto-flip)
   *
   * Idempotent: receiving the same paid IPN twice is a no-op.
   * Reverse transitions (paid → pending) are rejected — we never
   * downgrade a paid order from an IPN, even if NowPayments retries.
   */
  async applyIpnStatus(args: {
    order_id: string;
    payment_id: string;
    provider_status: string;
  }): Promise<CryptoOrder | null> {
    const order = await this.opts.repo.getById(args.order_id);
    if (order === null) return null;
    const mapped = mapNowpaymentsStatus(args.provider_status);
    if (mapped === null) return order; // unknown status: leave state alone, record payment_id only.
    if (isTerminalForward(order.status, mapped)) {
      const updated: CryptoOrder = {
        ...order,
        payment_id: order.payment_id ?? args.payment_id,
        status: mapped,
        updated_at: this.nowFn(),
      };
      await this.opts.repo.upsert(updated);
      // V-666.I — fire crypto.order.paid when transitioning INTO the
      // paid state. Skipped when the order was already paid (re-deliver
      // of the same IPN). Skipped when no emitter is wired. Best-effort:
      // an emission failure is swallowed so the IPN ack stays 200.
      if (order.status !== 'paid' && mapped === 'paid' && updated.account_id !== null) {
        const paidAtIso = new Date(updated.updated_at).toISOString();
        if (this.opts.webhooks !== undefined) {
          try {
            await this.opts.webhooks.enqueueEvent(updated.account_id, 'crypto.order.paid', {
              order_id: updated.order_id,
              product: updated.product,
              price_cents: updated.price_cents,
              price_currency: updated.price_currency,
              payment_id: updated.payment_id,
              paid_at: paidAtIso,
            });
          } catch {
            /* swallow */
          }
        }
        // V-666.R — paid-receipt email scaffold. Fired in parallel with
        // the webhook above; failures swallowed so the IPN ack still 200s.
        if (this.opts.paidEmailNotifier !== undefined) {
          try {
            await this.opts.paidEmailNotifier.notifyOrderPaid({
              account_id: updated.account_id,
              order_id: updated.order_id,
              product: updated.product,
              price_cents: updated.price_cents,
              price_currency: updated.price_currency,
              payment_id: updated.payment_id,
              paid_at: paidAtIso,
            });
          } catch {
            /* swallow */
          }
        }
      }
      return updated;
    }
    // No-op transition. Record the payment_id if we didn't have it yet.
    if (order.payment_id === null) {
      const updated: CryptoOrder = {
        ...order,
        payment_id: args.payment_id,
        updated_at: this.nowFn(),
      };
      await this.opts.repo.upsert(updated);
      return updated;
    }
    return order;
  }
}

/**
 * Allow transitions that move the order forward (towards a terminal
 * state). Reject reverse transitions.
 */
function isTerminalForward(current: CryptoOrderStatus, next: CryptoOrderStatus): boolean {
  // Same state — idempotent no-op, but caller wants the row touched
  // (updated_at refresh).
  if (current === next) return true;
  // Terminal statuses don't move. V-666.J — 'cancelled' joins
  // 'paid'/'failed' as terminal; a late IPN payment cannot revive
  // an abandoned order.
  if (current === 'paid' || current === 'failed' || current === 'cancelled') return false;
  // 'partial' is semi-terminal: only 'paid' or 'failed' overrides it.
  if (current === 'partial') return next === 'paid' || next === 'failed';
  // From 'pending' or 'confirming' anything except 'pending' is forward.
  return next !== 'pending';
}
