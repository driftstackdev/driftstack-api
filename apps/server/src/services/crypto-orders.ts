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

import { createHash as nodeCreateHash } from 'node:crypto';

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

/**
 * V-666.AT — append-only state-transition event. Each entry records
 * the status the order moved to + the source of that transition.
 * The list grows on every state change; we never mutate or remove
 * prior entries. Used by support to reconstruct an order's history
 * without grepping logs.
 */
export interface CryptoOrderEvent {
  /** Status the order entered. */
  status: CryptoOrderStatus;
  /** Server timestamp (ms since epoch) of the transition. */
  at: number;
  /**
   * What drove the transition. 'create' for the initial pending,
   * 'ipn' for NowPayments IPNs (including admin-replayed IPNs),
   * 'cancel' for customer-initiated cancellation, 'expired' for
   * customer-side expiry on the cancel endpoint, 'swept' for an
   * admin background sweep.
   */
  source: 'create' | 'ipn' | 'cancel' | 'expired' | 'swept';
}

export interface CryptoOrder {
  /** Internal order id; the customer also sees this on the checkout page. */
  order_id: string;
  /** Account this order is attributable to. Null for pre-signup checkouts. */
  account_id: string | null;
  /** Paid tier being purchased (the free tier is not purchasable). */
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
   * V-666.AA — admin-only internal note attached to the order. Used
   * by ops to record context that should NOT be visible to the
   * customer (e.g. "VIP account, manual outreach", "fraud signal,
   * watch for chargeback"). Capped at 2000 chars at the route layer
   * — twice the customer_note budget since these are internal +
   * support runbooks tend to be more verbose. Null when unset.
   */
  internal_note: string | null;
  /**
   * V-666.AT — append-only event log. Ordered oldest → newest. The
   * first entry is always the create event; subsequent entries
   * record each state transition. We keep the list on the order
   * envelope so a single getById fetches both current state + full
   * history.
   */
  events: CryptoOrderEvent[];
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
  /**
   * Sweep support — pending orders created at or before `olderThan`
   * (epoch ms), ordered OLDEST-FIRST, capped at `limit`. Distinct from
   * `listAll` (newest-first) on purpose: the sweep must drain the
   * oldest stale orders, and a newest-first scan never reaches them
   * once the table holds more than `limit` rows.
   */
  listPendingOlderThan(opts: { olderThan: number; limit: number }): Promise<CryptoOrder[]>;
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
  // eslint-disable-next-line @typescript-eslint/require-await
  async listPendingOlderThan(opts: { olderThan: number; limit: number }): Promise<CryptoOrder[]> {
    return Array.from(this.orders.values())
      .filter((o) => o.status === 'pending' && o.created_at <= opts.olderThan)
      .sort((a, b) => a.created_at - b.created_at)
      .slice(0, opts.limit);
  }
}

/**
 * V-666.AM — opaque cursor codec used by listForAdminPage. Encodes
 * the (created_at, order_id) pair of the last row in the current
 * page so the next call resumes immediately after it. Exposed for
 * testing; production code paths treat cursors as opaque strings.
 */
export interface CryptoOrderCursor {
  ts: number;
  id: string;
}

export function encodeCursor(cur: CryptoOrderCursor): string {
  const json = JSON.stringify(cur);
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeCursor(token: string): CryptoOrderCursor | null {
  try {
    const json = Buffer.from(token, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.ts !== 'number' || typeof obj.id !== 'string') return null;
    return { ts: obj.ts, id: obj.id };
  } catch {
    return null;
  }
}

/**
 * V-666.AR — body fingerprint for an idempotency-key request. Hashed
 * over the structured args (not the raw request body) so trivial
 * differences like whitespace don't trigger a false mismatch. SHA-256
 * → hex; not collision-resistant against an adversarial caller, but
 * the threat model here is "accidental key reuse," not "deliberate
 * forgery."
 */
export function idempotencyBodyFingerprint(args: {
  product: string;
  price_cents: number;
  price_currency: string;
}): string {
  const normalised = JSON.stringify({
    product: args.product,
    price_cents: args.price_cents,
    price_currency: args.price_currency,
  });
  return nodeCreateHash('sha256').update(normalised).digest('hex');
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
   * Production wiring is LIVE: migration 0064 (2026-05-22) added
   * `crypto.order.paid` + `crypto.order.failed` to the
   * `webhook_event_type` Postgres enum, so the bootstrap passes a
   * `WebhooksService`-backed emitter here — a subscribed customer gets
   * a real delivery on the paid transition. Unit tests pass a local
   * mock emitter that doesn't go through the DB.
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
 * V-666.I — local emitter contract: a thin seam over {@link
 * WebhooksService}, whose `WebhookEventType` union + the
 * `webhook_event_type` pgEnum now both carry these literals (migration
 * 0064). Keeping a local interface lets unit tests inject a mock
 * emitter without standing up the DB-backed delivery pipeline.
 */
export interface CryptoOrderWebhookEmitter {
  enqueueEvent: (
    accountId: string,
    // V-666.AN — adds 'crypto.order.failed' alongside 'crypto.order.paid'.
    // Fires on the pending/confirming/partial → failed terminal
    // transition (whether via IPN, expireOrder, or sweepExpiredOrders).
    // Both literals are live in the `webhook_event_type` pgEnum
    // (migration 0064) + the WebhookEventType union; the bootstrap
    // wires the WebhooksService as the emitter sink.
    eventType: 'crypto.order.paid' | 'crypto.order.failed',
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
      internal_note: null,
      events: [{ status: 'pending', at: now, source: 'create' }],
      created_at: now,
      updated_at: now,
    };
    await this.opts.repo.upsert(order);
    return order;
  }

  /**
   * V-666.AO — idempotency-key wrapper around create(). Callers that
   * supply an Idempotency-Key on POST /v1/billing/crypto-checkout get
   * the original order back on retries instead of minting a new one.
   *
   * The key is scoped per-account (or the literal '_anon' for
   * pre-signup checkouts) so colliding keys across customers don't
   * leak one customer's order to another. Records are pruned 24h
   * after they were first stored — long enough that customer retries
   * over a network blip succeed, short enough that the keyspace
   * doesn't grow unbounded under sustained traffic.
   *
   * Returns { order, replayed }. `replayed: true` means the supplied
   * key matched a prior order and the cached order is returned
   * verbatim; the caller can use this to set a response header
   * (`Idempotent-Replayed: 1`).
   */
  async createIdempotent(args: {
    idempotency_key: string;
    order_id: string;
    account_id: string | null;
    product: string;
    price_cents: number;
    price_currency: string;
  }): Promise<{ order: CryptoOrder; replayed: boolean; bodyFingerprintMismatch: boolean }> {
    const now = this.nowFn();
    this.pruneIdempotency(now);
    const scopeKey = `${args.account_id ?? '_anon'}:${args.idempotency_key}`;
    const fingerprint = idempotencyBodyFingerprint(args);
    const cached = this.idempotencyKeys.get(scopeKey);
    if (cached !== undefined) {
      const existing = await this.opts.repo.getById(cached.order_id);
      if (existing !== null) {
        this.idempotentReplays += 1;
        const mismatch = cached.fingerprint !== fingerprint;
        if (mismatch) this.idempotentBodyMismatches += 1;
        return { order: existing, replayed: true, bodyFingerprintMismatch: mismatch };
      }
      // Cached row was somehow evicted from the repo; treat as fresh.
      this.idempotencyKeys.delete(scopeKey);
    }
    // Single-flight: a concurrent request whose create() for this scope key
    // is still in flight awaits that same create + replays its order, rather
    // than racing into a second create (the persistent cache below is only
    // set AFTER create() resolves, so the window between the cache check above
    // and that set is otherwise unguarded for concurrent callers).
    const inflight = this.idempotencyInflight.get(scopeKey);
    if (inflight !== undefined) {
      const order = await inflight.promise;
      this.idempotentReplays += 1;
      const mismatch = inflight.fingerprint !== fingerprint;
      if (mismatch) this.idempotentBodyMismatches += 1;
      return { order, replayed: true, bodyFingerprintMismatch: mismatch };
    }

    const createPromise = this.create({
      order_id: args.order_id,
      account_id: args.account_id,
      product: args.product,
      price_cents: args.price_cents,
      price_currency: args.price_currency,
    });
    this.idempotencyInflight.set(scopeKey, { promise: createPromise, fingerprint });
    let order: CryptoOrder;
    try {
      order = await createPromise;
    } finally {
      this.idempotencyInflight.delete(scopeKey);
    }
    this.idempotencyKeys.set(scopeKey, {
      order_id: order.order_id,
      recorded_at: now,
      fingerprint,
    });
    this.idempotentFirstWrites += 1;
    return { order, replayed: false, bodyFingerprintMismatch: false };
  }

  private readonly idempotencyKeys = new Map<
    string,
    { order_id: string; recorded_at: number; fingerprint: string }
  >();
  /**
   * Single-flight guard for CONCURRENT same-key creates. `createIdempotent`'s
   * cache check + set straddle an `await this.create()`, so two simultaneous
   * requests with the same scope key (the double-click case) would both miss
   * the cache and both create an order — defeating the documented "duplicate
   * POSTs with the same key replay the original order" contract. Concurrent
   * callers await the first request's in-flight create and replay its order
   * instead. Entries are short-lived (deleted in a `finally`), so they need no
   * TTL prune. NB: in-memory ⇒ single-process only; cross-instance dedup is
   * the DB-backed follow-up gated on real merchant traffic (see file header).
   */
  private readonly idempotencyInflight = new Map<
    string,
    { promise: Promise<CryptoOrder>; fingerprint: string }
  >();
  private static readonly IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
  /** V-666.AP — count of replay hits since process start. */
  private idempotentReplays = 0;
  /** V-666.AP — count of fresh creates via createIdempotent since process start. */
  private idempotentFirstWrites = 0;
  /** V-666.AR — count of replays where the request body differed from the stored fingerprint. */
  private idempotentBodyMismatches = 0;

  /**
   * V-666.AP — snapshot of the idempotency counters. Exposed as a
   * separate method (rather than baked into getStatsForAdmin) so
   * that fast-firing metrics scrapers don't pay the full scan cost.
   *
   * V-666.AR — adds bodyMismatches (count of replays where the
   * request body fingerprint differed from the stored one — i.e.
   * the client accidentally reused a key across distinct intents).
   */
  getIdempotencyMetrics(): { replays: number; firstWrites: number; bodyMismatches: number } {
    return {
      replays: this.idempotentReplays,
      firstWrites: this.idempotentFirstWrites,
      bodyMismatches: this.idempotentBodyMismatches,
    };
  }

  private pruneIdempotency(now: number): void {
    const cutoff = now - CryptoOrdersService.IDEMPOTENCY_TTL_MS;
    for (const [k, v] of this.idempotencyKeys) {
      if (v.recorded_at < cutoff) this.idempotencyKeys.delete(k);
    }
  }

  /**
   * V-666.AA — admin sets / updates / clears the internal note on
   * an order. Works on every status since ops may want to record
   * context on a pending order ("customer reached out about wallet
   * network mistake") just as much as on a paid one. Empty string
   * normalises to null so "clearing" the note is the same code path
   * as "unset".
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
   * V-666.AT — admin reverse-history lookup. Returns the order's
   * append-only event log, or null when the order doesn't exist.
   * Called from the admin detail surface; customer-facing surface
   * can derive the same list from the order envelope returned by
   * `GET /v1/billing/crypto-orders/:id` if we surface `events` there
   * in a follow-up.
   */
  async getOrderEvents(orderId: string): Promise<CryptoOrderEvent[] | null> {
    const order = await this.opts.repo.getById(orderId);
    if (order === null) return null;
    return order.events;
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
      // V-666.AS — exact-match filter on payment_id (reverse-lookup
      // from a NowPayments id). Same semantics as listForAdminPage.
      paymentId?: string;
      scanLimit?: number;
      // V-666.BX — half-open created_at window. Either bound may be
      // omitted; passing both gives a windowed scan.
      createdAfter?: number;
      createdBefore?: number;
    } = {},
  ): Promise<CryptoOrder[]> {
    const result = await this.listForAdminPage(opts);
    return result.orders;
  }

  /**
   * V-666.AM — paginated admin list. Same filter set as listForAdmin,
   * plus a `cursor` opaque token that resumes the scan from the next
   * row after the cursor's target. Sort order is `created_at DESC`
   * with `order_id` as the tiebreaker; the cursor encodes both so
   * pagination is stable across ties in created_at.
   *
   * Returns `{ orders, nextCursor }` where `nextCursor` is non-null
   * iff there is at least one more matching row beyond the returned
   * page. The cursor is base64url-encoded JSON of
   * `{ ts: created_at, id: order_id }`. A consumer treats it as
   * opaque — internal callers can decode for debugging but should
   * not parse it in production code paths.
   */
  async listForAdminPage(
    opts: {
      accountId?: string;
      limit?: number;
      status?: CryptoOrderStatus;
      search?: string;
      /**
       * V-666.AS — exact-match filter on payment_id. Used by support
       * to reverse-look-up a Driftstack order from a NowPayments
       * payment id the customer sent over. Distinct from `search`
       * (which is fuzzy across order_id / product / customer_note)
       * so the lookup is unambiguous + cheap.
       */
      paymentId?: string;
      cursor?: string;
      scanLimit?: number;
      /**
       * V-666.BX — date-range filter on created_at (epoch ms).
       * Both bounds are half-open: createdAfter is inclusive of
       * `>=` and createdBefore is exclusive of `<`. Either can be
       * omitted; passing both gives a windowed scan.
       */
      createdAfter?: number;
      createdBefore?: number;
    } = {},
  ): Promise<{ orders: CryptoOrder[]; nextCursor: string | null }> {
    const limit = opts.limit ?? 50;
    const scanLimit = opts.scanLimit ?? 1_000;
    const narrowingFilter =
      opts.status !== undefined ||
      opts.search !== undefined ||
      opts.paymentId !== undefined ||
      opts.createdAfter !== undefined ||
      opts.createdBefore !== undefined;
    // Pagination math: filters or an active cursor need the full scan
    // window (we may reject many rows or need to seek past the cursor
    // anchor). The unfiltered first-page case asks the repo for one
    // extra row so we can tell whether a next page exists.
    const repoLimit = narrowingFilter || opts.cursor !== undefined ? scanLimit : limit + 1;
    const raw = await this.opts.repo.listAll({
      ...(opts.accountId !== undefined ? { accountId: opts.accountId } : {}),
      limit: repoLimit,
    });
    const needle = opts.search?.toLowerCase().trim();
    const paymentIdNeedle = opts.paymentId?.trim();
    const filtered = raw.filter((o) => {
      if (opts.status !== undefined && o.status !== opts.status) return false;
      if (paymentIdNeedle !== undefined && paymentIdNeedle.length > 0) {
        if (o.payment_id !== paymentIdNeedle) return false;
      }
      if (needle !== undefined && needle.length > 0) {
        const hay =
          o.order_id.toLowerCase() +
          '|' +
          o.product.toLowerCase() +
          '|' +
          (o.customer_note?.toLowerCase() ?? '');
        if (!hay.includes(needle)) return false;
      }
      if (opts.createdAfter !== undefined && o.created_at < opts.createdAfter) return false;
      if (opts.createdBefore !== undefined && o.created_at >= opts.createdBefore) return false;
      return true;
    });
    // Stable sort: created_at DESC, order_id ASC as tiebreaker. The
    // repo already returns created_at DESC but doesn't pin the tie
    // resolution, so we redo it deterministically here.
    filtered.sort((a, b) =>
      a.created_at !== b.created_at
        ? b.created_at - a.created_at
        : a.order_id < b.order_id
          ? -1
          : a.order_id > b.order_id
            ? 1
            : 0,
    );
    let startIdx = 0;
    if (opts.cursor !== undefined && opts.cursor.length > 0) {
      const decoded = decodeCursor(opts.cursor);
      if (decoded === null) {
        // Malformed cursor — caller's bug. Surface to the route as a
        // 400-able condition by returning an empty page; the route
        // layer can validate stricter if it wants to 400 explicitly.
        return { orders: [], nextCursor: null };
      }
      const anchorIdx = filtered.findIndex(
        (o) => o.created_at === decoded.ts && o.order_id === decoded.id,
      );
      // If we can't find the anchor row in the scan window, behave
      // conservatively and return an empty page rather than guessing.
      // Callers detect "ran off the end" by getting an empty page
      // with nextCursor:null and stop iterating.
      if (anchorIdx === -1) {
        return { orders: [], nextCursor: null };
      }
      startIdx = anchorIdx + 1;
    }
    const page = filtered.slice(startIdx, startIdx + limit);
    const hasMore = filtered.length > startIdx + limit;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last !== undefined
        ? encodeCursor({ ts: last.created_at, id: last.order_id })
        : null;
    return { orders: page, nextCursor };
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
    const now = this.nowFn();
    const updated: CryptoOrder = {
      ...order,
      status: 'cancelled',
      events: [...order.events, { status: 'cancelled', at: now, source: 'cancel' }],
      updated_at: now,
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
    // Align the lookback to UTC-date boundaries. The method buckets by
    // UTC date (created_at → YYYY-MM-DD), so the filter must be date-
    // aligned too: a rolling `now - days*24h` cutoff makes the oldest
    // day a partial slice (under-counted) and lets the window spill into
    // a days+1-th date. cutoff = 00:00:00 UTC of (days-1) days ago, so
    // the window is exactly the last `days` full UTC dates incl. today.
    const nowDate = new Date(now);
    const startOfTodayUtc = Date.UTC(
      nowDate.getUTCFullYear(),
      nowDate.getUTCMonth(),
      nowDate.getUTCDate(),
    );
    const cutoff = startOfTodayUtc - (days - 1) * 24 * 60 * 60 * 1000;
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
    /**
     * V-666.AE — paid revenue keyed by product. Inner map is per-
     * currency, matching paidRevenueCents. Used for the
     * "which tiers are actually converting" KPI on the ops dashboard.
     */
    paidRevenueByProduct: Record<string, Record<string, number>>;
    /**
     * V-666.AE — count of paid orders per product. Pairs with
     * paidRevenueByProduct so the consumer can compute ARPU by tier
     * without re-scanning.
     */
    paidCountByProduct: Record<string, number>;
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
    const paidRevenueByProduct: Record<string, Record<string, number>> = {};
    const paidCountByProduct: Record<string, number> = {};
    let paidElapsedSumMs = 0;
    let paidSample = 0;
    for (const o of rows) {
      byStatus[o.status] += 1;
      if (o.status === 'paid') {
        paidRevenueCents[o.price_currency] =
          (paidRevenueCents[o.price_currency] ?? 0) + o.price_cents;
        // V-666.AE — per-product revenue. Inner map keyed by currency
        // so we don't conflate EUR + USD totals.
        const productMap = paidRevenueByProduct[o.product] ?? {};
        productMap[o.price_currency] = (productMap[o.price_currency] ?? 0) + o.price_cents;
        paidRevenueByProduct[o.product] = productMap;
        paidCountByProduct[o.product] = (paidCountByProduct[o.product] ?? 0) + 1;
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
      paidRevenueByProduct,
      paidCountByProduct,
      truncated: rows.length === scanLimit,
      scanned: rows.length,
    };
  }

  /**
   * V-666.AC — pending-orders age histogram. For each currently-
   * pending order (status === 'pending'), bucket by age since
   * created_at. Buckets are: under_1h / 1h_to_6h / 6h_to_24h /
   * over_24h. The over_24h bucket is the most operationally
   * interesting — those are candidates for sweepExpiredOrders.
   *
   * Pure read-only; does not mutate orders. Scans pending orders
   * oldest-first via listPendingOlderThan(olderThan = now) and caps at
   * scanLimit, so when the backlog is truncated it drops the freshest
   * orders, never the stale over_24h sweep candidates — the bucket
   * operators actually act on.
   */
  async getPendingAgeHistogram(opts: { scanLimit?: number } = {}): Promise<{
    buckets: {
      under_1h: number;
      h1_to_6h: number;
      h6_to_24h: number;
      over_24h: number;
    };
    /** Sum of price_cents across pending orders, by currency. */
    pendingValueCents: Record<string, number>;
    /** Convenience total = sum of the four bucket counts. */
    total: number;
    truncated: boolean;
    scanned: number;
  }> {
    const scanLimit = opts.scanLimit ?? 10_000;
    const now = this.nowFn();
    // Pending-only, oldest-first. listAll is newest-first across ALL
    // statuses, so a backlog of newer terminal/fresh orders used to
    // crowd the old pending orders out of the scan window and
    // under-count the over_24h bucket. olderThan = now matches every
    // pending order (none are created in the future).
    const rows = await this.opts.repo.listPendingOlderThan({ olderThan: now, limit: scanLimit });
    const buckets = {
      under_1h: 0,
      h1_to_6h: 0,
      h6_to_24h: 0,
      over_24h: 0,
    };
    const pendingValueCents: Record<string, number> = {};
    let total = 0;
    for (const o of rows) {
      // All rows are pending by construction (listPendingOlderThan).
      total += 1;
      const ageMs = now - o.created_at;
      if (ageMs < 60 * 60_000) buckets.under_1h += 1;
      else if (ageMs < 6 * 60 * 60_000) buckets.h1_to_6h += 1;
      else if (ageMs < 24 * 60 * 60_000) buckets.h6_to_24h += 1;
      else buckets.over_24h += 1;
      pendingValueCents[o.price_currency] =
        (pendingValueCents[o.price_currency] ?? 0) + o.price_cents;
    }
    return {
      buckets,
      pendingValueCents,
      total,
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
      events: [...order.events, { status: 'failed', at: now, source: 'expired' }],
      updated_at: now,
    };
    await this.opts.repo.upsert(updated);
    // V-666.AN — fire crypto.order.failed on the expire transition.
    await this.emitFailedTransition(updated, 'expired');
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
    const now = this.nowFn();
    const cutoff = now - opts.olderThanMs;
    // Oldest-first among eligible rows. A newest-first listAll scan
    // would never reach stale OLD orders once newer orders exceed the
    // limit, leaving them stuck pending forever.
    const candidates = await this.opts.repo.listPendingOlderThan({ olderThan: cutoff, limit });
    let expired = 0;
    for (const o of candidates) {
      // Defensive re-check: the repo query already filters to pending +
      // past-cutoff, but guard against a race with a concurrent IPN
      // transition between the query and the upsert below.
      if (o.status !== 'pending' || now - o.created_at < opts.olderThanMs) continue;
      const updated: CryptoOrder = {
        ...o,
        status: 'failed',
        events: [...o.events, { status: 'failed', at: now, source: 'swept' }],
        updated_at: now,
      };
      await this.opts.repo.upsert(updated);
      // V-666.AN — fire crypto.order.failed for each swept order.
      // Per-row emission rather than a single batch event so a
      // customer who paid mid-sweep sees the transition the same
      // way as a single expireOrder call.
      await this.emitFailedTransition(updated, 'swept');
      expired += 1;
    }
    // `capped` reflects whether the SCAN filled the limit (more stale
    // orders may remain beyond this batch), not the flip count — so the
    // nightly cron knows to re-run until it comes back false.
    return { expired, capped: candidates.length === limit };
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
      const now = this.nowFn();
      // V-666.AT — only append an event when the status actually
      // changes; a repeat IPN that's a same-state refresh updates
      // the row's updated_at without bloating the event log.
      const events =
        order.status === mapped
          ? order.events
          : [...order.events, { status: mapped, at: now, source: 'ipn' as const }];
      const updated: CryptoOrder = {
        ...order,
        payment_id: order.payment_id ?? args.payment_id,
        status: mapped,
        events,
        updated_at: now,
      };
      await this.opts.repo.upsert(updated);
      // V-666.AN — fire crypto.order.failed on the IPN-driven
      // pending/confirming/partial → failed transition. The
      // prior-status check skips the (rejected) failed→failed retry
      // case isTerminalForward would otherwise treat as a no-op
      // refresh.
      if (order.status !== 'failed' && mapped === 'failed') {
        await this.emitFailedTransition(updated, 'ipn');
      }
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

  /**
   * V-666.AN — fire crypto.order.failed when an order transitions
   * INTO the failed state. Shared by the three failed-transition
   * paths (applyIpnStatus, expireOrder, sweepExpiredOrders). The
   * `reason` parameter distinguishes the call site for the consumer:
   *   - 'ipn'        — NowPayments reported failed/expired/refunded
   *   - 'expired'    — operator-triggered expire on a single order
   *   - 'swept'      — bulk nightly sweep of stale pending orders
   *
   * Best-effort emission, mirrors the V-666.I pattern: a webhook
   * failure is swallowed so the IPN ack / cron tick stays 200.
   */
  private async emitFailedTransition(
    order: CryptoOrder,
    reason: 'ipn' | 'expired' | 'swept',
  ): Promise<void> {
    if (order.account_id === null) return;
    if (this.opts.webhooks === undefined) return;
    const failedAtIso = new Date(order.updated_at).toISOString();
    try {
      await this.opts.webhooks.enqueueEvent(order.account_id, 'crypto.order.failed', {
        order_id: order.order_id,
        product: order.product,
        price_cents: order.price_cents,
        price_currency: order.price_currency,
        payment_id: order.payment_id,
        reason,
        failed_at: failedAtIso,
      });
    } catch {
      /* swallow */
    }
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
