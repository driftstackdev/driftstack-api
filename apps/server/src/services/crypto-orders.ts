// V-666.B — crypto-orders service.
//
// Order store + state machine for the NowPayments IPN flow.
// Customer-side `/checkout/crypto` opens an order → backend records
// it + returns the payment address → NowPayments IPN posts status
// updates → service transitions the order state.
//
// V-799 — this header used to say there was no DB persistence and that
// the crypto_orders table was a later follow-up gated on merchant
// traffic. That table exists, `repo` is a REQUIRED constructor field
// below, and bootstrap passes `new DrizzleCryptoOrdersRepo(dbHandle)`,
// so no production path has ever run against an in-memory store since
// it landed. The operator runbook had inherited the same fiction and
// told on-call to expect orders to vanish on every deploy.

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
  /**
   * Billing-integrity (amount reconciliation) — the IPN-reported
   * amounts on an 'ipn'-sourced transition, persisted so support can
   * reconcile what was actually paid against the order price. Optional:
   * present only on IPN transitions that carried the amount fields.
   * `actually_paid` + `pay_amount` are CRYPTO-denominated (in `pay_currency`);
   * `price_amount` is FIAT (audit reference only — incomparable to actually_paid).
   */
  actually_paid?: number;
  pay_amount?: number;
  price_amount?: number;
  pay_currency?: string;
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
  /**
   * Billing-integrity (#1 crypto-denominated reconciliation) — the
   * crypto-denominated quote NowPayments mints at createPayment.
   * `pay_amount` is the amount owed in `pay_currency` (e.g. 0.0015 BTC); the
   * IPN's `actually_paid` is ALSO in `pay_currency`, so the paid-vs-short
   * reconciliation compares against THIS, never the FIAT price_amount
   * (incomparable units). Null for stub-provider / legacy orders that have no
   * minted quote (then applyIpnStatus preserves the prior status-only path).
   */
  pay_amount: number | null;
  pay_currency: string | null;
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
   * Billing-integrity (#7 cross-instance idempotency) — atomically insert
   * `order` tagged with `scopedIdempotencyKey`, or, if a row with that key
   * already exists (DB UNIQUE constraint), return the EXISTING order. This is
   * INSERT ... ON CONFLICT (idempotency_key) DO NOTHING + select-existing, so
   * two concurrent / cross-instance / post-restart requests with the same key
   * can never mint two orders. Returns `{ order, replayed }`: replayed=true
   * means the key already existed and the prior order is returned verbatim.
   *
   * V-725 — `bodyFingerprint` is RECORDED with the order, and a replay hands
   * back the fingerprint stored on the existing row as `storedFingerprint`, so
   * the caller can detect a key reused with a different body on a replay served
   * by the DATABASE. `null` means the row predates the column (or carried no
   * key): unknown, NOT matched. Before this the in-memory cache was the only
   * place a fingerprint lived, so every post-restart replay reported no
   * mismatch regardless of what the caller sent.
   */
  insertWithIdempotencyKey(
    order: CryptoOrder,
    scopedIdempotencyKey: string,
    bodyFingerprint: string,
  ): Promise<{ order: CryptoOrder; replayed: boolean; storedFingerprint: string | null }>;
  /**
   * Serialize a read-modify-write on ONE order. The DB impl takes a row-level
   * lock (SELECT … FOR UPDATE) inside a transaction, hands the locked committed
   * snapshot to `fn`, persists `fn`'s `updated` (skips the write when `fn` returns
   * `updated: null`), and returns `fn`'s `result`. Returns null if the order does
   * not exist. Closes the IPN dup-fire (#3) + note/cancel lost-update (#7) races:
   * the transition decision is computed against the LOCKED row, and the caller
   * fires side-effects OUTSIDE the lock gated on `result`.
   */
  withOrderLock<T>(
    orderId: string,
    fn: (locked: CryptoOrder) => { updated: CryptoOrder | null; result: T },
  ): Promise<T | null>;
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
  private readonly byIdempotencyKey = new Map<string, string>(); // scopedKey -> order_id
  /** V-725 — mirrors the persisted idempotency_body_fingerprint column. */
  private readonly fingerprintByIdempotencyKey = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/require-await
  async insertWithIdempotencyKey(
    order: CryptoOrder,
    scopedIdempotencyKey: string,
    bodyFingerprint: string,
  ): Promise<{ order: CryptoOrder; replayed: boolean; storedFingerprint: string | null }> {
    // Single-threaded JS → the check-and-insert is naturally atomic; mirrors
    // the DB impl's INSERT ... ON CONFLICT DO NOTHING contract. The real
    // cross-instance race lives only in the multi-connection Postgres path.
    const existingId = this.byIdempotencyKey.get(scopedIdempotencyKey);
    if (existingId !== undefined) {
      const existing = this.orders.get(existingId);
      if (existing !== undefined) {
        return {
          order: existing,
          replayed: true,
          storedFingerprint: this.fingerprintByIdempotencyKey.get(scopedIdempotencyKey) ?? null,
        };
      }
      this.byIdempotencyKey.delete(scopedIdempotencyKey);
      this.fingerprintByIdempotencyKey.delete(scopedIdempotencyKey);
    }
    this.orders.set(order.order_id, order);
    this.byIdempotencyKey.set(scopedIdempotencyKey, order.order_id);
    this.fingerprintByIdempotencyKey.set(scopedIdempotencyKey, bodyFingerprint);
    return { order, replayed: false, storedFingerprint: null };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async withOrderLock<T>(
    orderId: string,
    fn: (locked: CryptoOrder) => { updated: CryptoOrder | null; result: T },
  ): Promise<T | null> {
    // Single-threaded JS → the read-modify-write is already atomic; this mirrors
    // the DB impl's contract (locked snapshot → fn → conditional write → result).
    const order = this.orders.get(orderId);
    if (order === undefined) return null;
    const { updated, result } = fn(order);
    if (updated !== null) this.orders.set(orderId, updated);
    return result;
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
   * Postmark. It is INTENDED to route through the existing EmailService
   * template path (template ID + per-account locale resolution belongs
   * there). In tests, a local mock captures the intent so we can assert
   * the args without standing up the email pipeline.
   *
   * ⚠️ NOT WIRED IN PRODUCTION. bootstrap.ts does not pass this, so no
   * dedicated crypto receipt is sent — the sentence above described the
   * intended design in the present tense and read as if it were live.
   * Paying customers are not silently dropped: `tierActivator` IS wired
   * and emits `subscription.tier_changed`, which sends the tier-changed
   * email and writes the audit row. Adding a second, dedicated receipt
   * needs a new customer-facing template, so it is a product decision
   * rather than a wiring oversight to fix in passing. Declared in
   * tests/unit/bootstrap-unwired-optional-deps-are-declared.test.ts.
   */
  paidEmailNotifier?: CryptoOrderPaidEmailNotifier;
  /**
   * S41 2026-07-07 (founder-approved: wire crypto activation) — optional
   * account-tier activator. When supplied, applyIpnStatus invokes it on
   * the same pending|confirming|partial → paid transition where the
   * webhook + receipt email fire, and the activator upgrades the
   * account's tier to the order's purchased `product` (upgrade-only —
   * see CryptoTierActivationService for the no-downgrade precedence
   * rule). Same thin-seam decoupling as `webhooks`/`paidEmailNotifier`:
   * production wiring passes CryptoTierActivationService (backed by the
   * Stripe account-tier repo machinery); unit tests can pass a local
   * mock. UNLIKE the two best-effort emitters, a failure here is a paid
   * customer without their entitlement, so it is logged as a loud
   * integrity alarm (never silently swallowed) while still acking the
   * IPN 200.
   */
  tierActivator?: CryptoOrderTierActivator;
  /**
   * Billing-integrity — optional logger for integrity alarms (e.g. an IPN
   * payment_id that doesn't match the order's stored payment_id). When
   * omitted the alarm is silently dropped (tests without a logger).
   */
  logger?: {
    error: (obj: Record<string, unknown>, msg: string) => void;
    warn?: (obj: Record<string, unknown>, msg: string) => void;
  };
}

/**
 * Billing-integrity (amount reconciliation) — tolerance for the
 * `actually_paid >= pay_amount` check, as a fraction of pay_amount. BOTH are
 * CRYPTO-denominated, in the order's pay_currency.
 *
 * This comment used to say `price_amount`, which is the FIAT figure and is
 * incomparable to `actually_paid`. That is not a wording quibble: comparing the
 * two is the exact bug this code was fixed for, and the fix's own inline note
 * records the symptom — it "left every full payment stuck 'partial'". The code
 * was corrected and this description was not, so it survived describing the
 * defect as though it were the design.
 *
 * Crypto payments routinely settle a hair under the quoted amount due to
 * exchange-rate slippage between quote and settlement, and on-chain fee
 * rounding; 1% absorbs that without letting a real short-pay through.
 */
const AMOUNT_RECONCILE_TOLERANCE_FRACTION = 0.01;

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

/**
 * S41 2026-07-07 (founder-approved: wire crypto activation) — local
 * activator contract for "upgrade the account tier on paid". Same
 * decoupling rationale as {@link CryptoOrderWebhookEmitter}: this
 * service emits the activation intent at the exactly-once paid
 * transition; the production CryptoTierActivationService consumes it
 * (Stripe-parity tier write + audit + tier-changed email + auth-cache
 * invalidation). Tests can pass a mock to observe the intent without
 * standing up the account machinery.
 */
export interface CryptoOrderTierActivationIntent {
  account_id: string;
  order_id: string;
  /** The purchased tier — the order's `product` (a paid AccountTier slug). */
  product: string;
  payment_id: string | null;
  paid_at: string;
}

export interface CryptoOrderTierActivator {
  activateTierForPaidOrder: (intent: CryptoOrderTierActivationIntent) => Promise<void>;
  /**
   * C3 — refund/chargeback clawback for an already-paid order. Expires the
   * refunded order's entitlement and reconciles the account tier to its best
   * remaining valid access (a live Stripe sub / another valid crypto entitlement
   * / free) — non-stranding, and idempotent on an IPN replay.
   */
  revokeTierForRefundedOrder: (args: {
    account_id: string;
    order_id: string;
    at: Date;
  }) => Promise<{ revoked: boolean }>;
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
      pay_amount: null,
      pay_currency: null,
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
   * Billing-integrity (#9 payment_id binding + #1 crypto-denominated quote) —
   * persist the NowPayments payment_id AND the crypto-denominated quote
   * (pay_amount + pay_currency) minted for THIS order at createPayment time.
   * applyIpnStatus then rejects/alarms when an IPN's payment_id doesn't match
   * the stored one, and reconciles the IPN's `actually_paid` against the stored
   * pay_amount (same pay_currency unit), never the FIAT price_amount.
   * Only sets when currently unbound (the mint is a one-time event per order);
   * a later differing IPN payment_id is an integrity alarm, not an overwrite.
   * Returns the updated order, or null if the order doesn't exist.
   */
  async recordPaymentId(args: {
    order_id: string;
    payment_id: string;
    /** Crypto-denominated amount owed (in pay_currency) from the NowPayments quote. */
    pay_amount?: number;
    /** Pay currency (chain/asset) the quote + IPN actually_paid are denominated in. */
    pay_currency?: string;
  }): Promise<CryptoOrder | null> {
    const now = this.nowFn();
    return this.opts.repo.withOrderLock(args.order_id, (order) => {
      if (order.payment_id !== null) {
        // Already bound — don't overwrite (idempotent re-call / retry).
        return { updated: null, result: order };
      }
      const updated: CryptoOrder = {
        ...order,
        payment_id: args.payment_id,
        // Bind the crypto-denominated quote alongside the payment_id (same mint).
        ...(args.pay_amount !== undefined ? { pay_amount: args.pay_amount } : {}),
        ...(args.pay_currency !== undefined ? { pay_currency: args.pay_currency } : {}),
        updated_at: now,
      };
      return { updated, result: updated };
    });
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

    // Billing-integrity (#7) — the create goes through the DB-backed
    // insertWithIdempotencyKey (INSERT ... ON CONFLICT (idempotency_key) DO
    // NOTHING), so a duplicate same-key request on ANOTHER instance (or after a
    // restart, where the in-memory cache + single-flight above are empty) is
    // deduped by the DB UNIQUE constraint instead of minting a second order.
    // The in-memory layers above stay as a same-process fast-path; the DB is
    // the cross-instance source of truth, and its `replayed` flag is honoured.
    const createPromise = (async (): Promise<{
      order: CryptoOrder;
      replayed: boolean;
      storedFingerprint: string | null;
    }> => {
      const candidate: CryptoOrder = {
        order_id: args.order_id,
        account_id: args.account_id,
        product: args.product,
        price_cents: args.price_cents,
        price_currency: args.price_currency,
        payment_id: null,
        pay_amount: null,
        pay_currency: null,
        status: 'pending',
        customer_note: null,
        internal_note: null,
        events: [{ status: 'pending', at: now, source: 'create' }],
        created_at: now,
        updated_at: now,
      };
      return this.opts.repo.insertWithIdempotencyKey(candidate, scopeKey, fingerprint);
    })();
    // Single-flight awaits the order (not the {order,replayed} envelope) so the
    // existing inflight-replay contract is unchanged.
    const orderPromise = createPromise.then((r) => r.order);
    this.idempotencyInflight.set(scopeKey, { promise: orderPromise, fingerprint });
    let result: { order: CryptoOrder; replayed: boolean; storedFingerprint: string | null };
    try {
      result = await createPromise;
    } finally {
      this.idempotencyInflight.delete(scopeKey);
    }
    this.idempotencyKeys.set(scopeKey, {
      order_id: result.order.order_id,
      recorded_at: now,
      fingerprint,
    });
    if (result.replayed) {
      // The DB found a prior order for this key (cross-instance / post-restart
      // duplicate) — surface it as a replay, not a fresh write.
      //
      // V-725 — compare against the fingerprint RECORDED on that row. This
      // branch previously hardcoded `false`, which was not a conservative
      // default but a false statement: it claimed the bodies matched when
      // nothing had been compared. A null stored fingerprint (row predates the
      // column) stays false, because an unknown body is not a proven mismatch.
      const mismatch =
        result.storedFingerprint !== null && result.storedFingerprint !== fingerprint;
      if (mismatch) this.idempotentBodyMismatches += 1;
      this.idempotentReplays += 1;
      return { order: result.order, replayed: true, bodyFingerprintMismatch: mismatch };
    }
    this.idempotentFirstWrites += 1;
    return { order: result.order, replayed: false, bodyFingerprintMismatch: false };
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
    const now = this.nowFn();
    // #7 — locked read-modify-write (admin path; no ownership scope).
    return this.opts.repo.withOrderLock(args.order_id, (order) => {
      const normalised =
        args.internal_note === null || args.internal_note.length === 0 ? null : args.internal_note;
      const updated: CryptoOrder = { ...order, internal_note: normalised, updated_at: now };
      return { updated, result: updated };
    });
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
    const now = this.nowFn();
    // #7 — locked read-modify-write so a concurrent IPN can't carry a stale status/
    // events snapshot back over the note write (and vice-versa).
    return this.opts.repo.withOrderLock(args.order_id, (order) => {
      if (order.account_id !== args.account_id) return { updated: null, result: null };
      const normalised =
        args.customer_note === null || args.customer_note.length === 0 ? null : args.customer_note;
      const updated: CryptoOrder = { ...order, customer_note: normalised, updated_at: now };
      return { updated, result: updated };
    });
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
    const now = this.nowFn();
    // #7 — lock the row so a concurrent IPN/note edit can't clobber the cancel, and the
    // 'pending' + ownership guards are re-checked against the LOCKED committed row.
    return this.opts.repo.withOrderLock<
      | { ok: 'cancelled'; order: CryptoOrder }
      | { ok: 'not_cancellable'; reason: CryptoOrderStatus }
      | null
    >(args.order_id, (order) => {
      if (order.account_id !== args.account_id) {
        return { updated: null, result: null };
      }
      if (order.status !== 'pending') {
        return { updated: null, result: { ok: 'not_cancellable' as const, reason: order.status } };
      }
      const updated: CryptoOrder = {
        ...order,
        status: 'cancelled',
        events: [...order.events, { status: 'cancelled', at: now, source: 'cancel' }],
        updated_at: now,
      };
      return { updated, result: { ok: 'cancelled' as const, order: updated } };
    });
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
        // V-666.W — time-to-pay = paid-transition moment − order mint. Source
        // the paid moment from the event log (paidAtMs), NOT updated_at: a
        // post-payment note edit bumps updated_at and would inflate the KPI.
        const elapsed = paidAtMs(o) - o.created_at;
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
      paid_at: order.status === 'paid' ? new Date(paidAtMs(order)).toISOString() : null,
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
    const now = this.nowFn();
    // #79 — re-check + write under the row lock (SELECT…FOR UPDATE), like cancelOrder /
    // applyIpnStatus. The previous unlocked read-modify-upsert could clobber a
    // concurrently-PAID order back to 'failed': an IPN flipping pending→paid between
    // the read and the upsert was blindly overwritten, so a paid customer lost their
    // tier AND got a contradictory crypto.order.failed webhook. The guard now reads the
    // LOCKED committed row, so a won-the-race IPN is seen here and the expire is skipped.
    const expiredOrder = await this.opts.repo.withOrderLock<CryptoOrder | null>(
      args.order_id,
      (order) => {
        if (order.status !== 'pending' || now - order.created_at < args.olderThanMs) {
          return { updated: null, result: null };
        }
        const updated: CryptoOrder = {
          ...order,
          status: 'failed',
          events: [...order.events, { status: 'failed', at: now, source: 'expired' }],
          updated_at: now,
        };
        return { updated, result: updated };
      },
    );
    if (expiredOrder === null) return null; // not found OR no longer pending/old-enough
    // V-666.AN — fire crypto.order.failed on the expire transition (only when we
    // actually performed the pending→failed write).
    await this.emitFailedTransition(expiredOrder, 'expired');
    return expiredOrder;
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
      // #79 — re-check + write under the row lock (not the stale listPendingOlderThan
      // snapshot). The old "defensive re-check" tested `o.status` from the non-locking
      // SELECT, so a concurrent IPN flipping this row pending→paid between the scan and
      // the upsert was clobbered back to 'failed' (paid customer loses tier + spurious
      // failed webhook). The locked read sees the won-the-race IPN and skips the row.
      const swept = await this.opts.repo.withOrderLock<CryptoOrder | null>(o.order_id, (order) => {
        if (order.status !== 'pending' || now - order.created_at < opts.olderThanMs) {
          return { updated: null, result: null };
        }
        const updated: CryptoOrder = {
          ...order,
          status: 'failed',
          events: [...order.events, { status: 'failed', at: now, source: 'swept' }],
          updated_at: now,
        };
        return { updated, result: updated };
      });
      if (swept === null) continue; // a concurrent IPN won the row, or it vanished
      // V-666.AN — fire crypto.order.failed for each swept order. Per-row emission
      // rather than a single batch event so a customer who paid mid-sweep sees the
      // transition the same way as a single expireOrder call.
      await this.emitFailedTransition(swept, 'swept');
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
    /**
     * Billing-integrity (#1 crypto-denominated amount reconciliation) — the
     * IPN-reported amounts. `actually_paid` + `pay_amount` are CRYPTO-denominated
     * (in `pay_currency`, e.g. 0.0015 BTC); `price_amount` is FIAT (audit-only).
     * When the provider status maps to 'paid', a paid transition is only allowed
     * if `actually_paid >= pay_amount * (1 - tolerance)` (both in pay_currency);
     * an under-payment routes to 'partial' instead. The IPN's `pay_amount` is the
     * quote NowPayments echoes back; the order also stores its own pay_amount at
     * createPayment, used as the fallback / the cross-check unit.
     * Optional so callers (admin replay / legacy) that don't supply amounts
     * preserve the prior status-only behaviour.
     */
    actually_paid?: number;
    /** Crypto-denominated amount owed (pay_currency); reconciled against actually_paid. */
    pay_amount?: number;
    /** FIAT expected amount — persisted on the audit event ONLY (incomparable to actually_paid). */
    price_amount?: number;
    pay_currency?: string;
  }): Promise<CryptoOrder | null> {
    const now = this.nowFn();
    const mapped0 = mapNowpaymentsStatus(args.provider_status);

    // #3 — lock the order row and decide the transition against the LOCKED committed
    // snapshot, so concurrent / re-delivered IPNs serialize and only the WINNING
    // transition writes + (below, OUTSIDE the lock) fires the paid/failed side-effects
    // exactly once. Previously the read-modify-write was unlocked: two same-order IPNs
    // both read pre-paid, both upserted, both fired the webhook + receipt email.
    const outcome = await this.opts.repo.withOrderLock(args.order_id, (order) => {
      // Billing-integrity (#9 payment_id binding). The order's payment_id is
      // minted + stored at createPayment time. If the IPN's payment_id differs
      // from the stored one, the IPN is for a DIFFERENT on-chain payment than
      // this order — reject it (no state change) and surface a mismatch alarm
      // rather than silently letting a wrong payment drive the order. The
      // public IPN is HMAC-verified (not externally forgeable), but the admin
      // apply-ipn path takes an operator-supplied payment_id, so this guards a
      // fat-fingered or malicious operator from attaching the wrong payment.
      if (order.payment_id !== null && order.payment_id !== args.payment_id) {
        return {
          updated: null,
          result: {
            order,
            firePaid: false,
            fireFailed: false,
            paymentIdMismatch: true,
            payCurrencyMismatch: false,
            settledPaymentDropped: false,
          },
        };
      }
      if (mapped0 === null) {
        // Unknown provider status: leave state alone (no write).
        return {
          updated: null,
          result: {
            order,
            firePaid: false,
            fireFailed: false,
            paymentIdMismatch: false,
            payCurrencyMismatch: false,
            settledPaymentDropped: false,
          },
        };
      }

      // Billing-integrity (#1 crypto-denominated amount reconciliation). When the
      // IPN reports a terminal 'paid' BUT the CRYPTO-denominated actually_paid is
      // short of the CRYPTO-denominated amount owed, do NOT flip to paid — route
      // to 'partial'. NowPayments' 'finished' is confirmation-based, not
      // amount-based, so a short on-chain payment that later "finishes" must not
      // unlock the paid tier. actually_paid + the owed quote are BOTH in
      // pay_currency (e.g. BTC) — we never compare against the FIAT price_amount
      // (incomparable units; that left every full payment stuck 'partial'). The
      // owed amount is the IPN's pay_amount when present, else the order's
      // pay_amount bound at createPayment. A tiny tolerance absorbs exchange-rate
      // slippage + on-chain fee rounding. With no crypto amount on either side
      // (admin replay / legacy / stub), reconciliation is skipped (status-only).
      let mapped = mapped0;
      let payCurrencyMismatch = false;
      if (mapped === 'paid' && args.actually_paid !== undefined) {
        // Currency-mismatch guard: if the IPN's pay_currency disagrees with the
        // pay_currency bound to the order, the amounts aren't in the same unit —
        // do NOT unlock; route to 'partial' + flag for the alarm below.
        if (
          args.pay_currency !== undefined &&
          order.pay_currency !== null &&
          args.pay_currency.toLowerCase() !== order.pay_currency.toLowerCase()
        ) {
          mapped = 'partial';
          payCurrencyMismatch = true;
        } else {
          const owed = args.pay_amount ?? order.pay_amount ?? undefined;
          if (owed !== undefined) {
            const minAccepted = owed * (1 - AMOUNT_RECONCILE_TOLERANCE_FRACTION);
            if (args.actually_paid < minAccepted) {
              mapped = 'partial';
            }
          }
        }
      }

      // Bind the crypto-denominated quote onto the order if the IPN carries it and
      // the order didn't have one yet (createPayment binds it normally, but a
      // first IPN can backfill it so a later re-delivery still reconciles).
      const boundPayAmount = order.pay_amount ?? args.pay_amount ?? null;
      const boundPayCurrency = order.pay_currency ?? args.pay_currency ?? null;

      if (isTerminalForward(order.status, mapped)) {
        // V-666.AT — append an event only on an actual status change; a same-state
        // refresh just bumps updated_at. The event carries the reconciliation
        // amounts (when supplied) so support can audit what was actually paid.
        const reconcileFields =
          args.actually_paid !== undefined ||
          args.pay_amount !== undefined ||
          args.price_amount !== undefined
            ? {
                ...(args.actually_paid !== undefined ? { actually_paid: args.actually_paid } : {}),
                ...(args.pay_amount !== undefined ? { pay_amount: args.pay_amount } : {}),
                ...(args.price_amount !== undefined ? { price_amount: args.price_amount } : {}),
                ...(args.pay_currency !== undefined ? { pay_currency: args.pay_currency } : {}),
              }
            : {};
        const events =
          order.status === mapped
            ? order.events
            : [
                ...order.events,
                { status: mapped, at: now, source: 'ipn' as const, ...reconcileFields },
              ];
        const updated: CryptoOrder = {
          ...order,
          payment_id: order.payment_id ?? args.payment_id,
          pay_amount: boundPayAmount,
          pay_currency: boundPayCurrency,
          status: mapped,
          events,
          updated_at: now,
        };
        return {
          updated,
          result: {
            order: updated,
            // Prior-status checks read the LOCKED status → a re-delivered IPN that
            // finds the order already failed/paid does NOT re-fire the side-effects.
            fireFailed: order.status !== 'failed' && mapped === 'failed',
            firePaid: order.status !== 'paid' && mapped === 'paid' && updated.account_id !== null,
            paymentIdMismatch: false,
            payCurrencyMismatch,
            settledPaymentDropped: false,
          },
        };
      }
      // No-op transition: record the payment_id + crypto quote if we didn't have them yet.
      if (
        order.payment_id === null ||
        order.pay_amount !== boundPayAmount ||
        order.pay_currency !== boundPayCurrency
      ) {
        const updated: CryptoOrder = {
          ...order,
          payment_id: order.payment_id ?? args.payment_id,
          pay_amount: boundPayAmount,
          pay_currency: boundPayCurrency,
          updated_at: now,
        };
        return {
          updated,
          result: {
            order: updated,
            firePaid: false,
            fireFailed: false,
            paymentIdMismatch: false,
            payCurrencyMismatch,
            settledPaymentDropped: false,
          },
        };
      }
      return {
        updated: null,
        result: {
          order,
          firePaid: false,
          fireFailed: false,
          paymentIdMismatch: false,
          payCurrencyMismatch,
          // V-743 — money arrived on an order that is already terminally NOT
          // paid, almost always because the expiry sweep flipped it to 'failed'
          // before the IPN landed. isTerminalForward deliberately refuses the
          // transition ("a late IPN payment cannot revive an abandoned order"),
          // so NOT applying it is correct and is left alone here.
          //
          // What was wrong is that it happened in silence: no entitlement, no
          // revenue row, no event (events are appended only inside the
          // forward-transition branch above), and the IPN acked 200 with a
          // routine info line. The funds settled on-chain and nothing anywhere
          // asked a human to refund or grant manually. This flag exists purely to
          // make that loud.
          settledPaymentDropped: mapped === 'paid' && order.status !== 'paid',
        },
      };
    });
    if (outcome === null) return null; // order not found

    // Billing-integrity (#9) — a payment_id mismatch is an integrity alarm:
    // log loudly + DON'T apply. Return the unchanged order so the caller acks
    // the IPN (NowPayments stops retrying) but no state moved.
    // V-743 — integrity alarm, deliberately NOT a state change. The refusal to
    // revive a terminal order is by design; the alarm is what lets support see
    // that a customer paid and received nothing. logger.error rather than warn:
    // this always needs a human, unlike the accidental-key-reuse warn below.
    if (outcome.settledPaymentDropped) {
      this.opts.logger?.error(
        {
          component: 'crypto-orders',
          event: 'ipn_settled_payment_dropped_on_terminal_order',
          order_id: args.order_id,
          order_status: outcome.order.status,
          provider_status: args.provider_status,
          actually_paid: args.actually_paid,
          price_cents: outcome.order.price_cents,
          account_id: outcome.order.account_id,
        },
        'settled crypto payment arrived on a terminal non-paid order; no entitlement granted — refund or grant manually',
      );
    }
    if (outcome.paymentIdMismatch) {
      this.opts.logger?.error(
        {
          component: 'crypto-orders',
          event: 'ipn_payment_id_mismatch',
          order_id: args.order_id,
          stored_payment_id: outcome.order.payment_id,
          ipn_payment_id: args.payment_id,
        },
        'crypto IPN payment_id does not match the order — REJECTED (integrity alarm)',
      );
      return outcome.order;
    }

    // Billing-integrity (#1) — a pay_currency mismatch is an integrity alarm: the
    // IPN's actually_paid is denominated in a DIFFERENT crypto than the order's
    // bound quote, so it can't be reconciled. We already routed the transition to
    // 'partial' (never unlocked the paid tier); surface the mismatch loudly.
    if (outcome.payCurrencyMismatch) {
      this.opts.logger?.error(
        {
          component: 'crypto-orders',
          event: 'ipn_pay_currency_mismatch',
          order_id: args.order_id,
          stored_pay_currency: outcome.order.pay_currency,
          ipn_pay_currency: args.pay_currency,
        },
        'crypto IPN pay_currency does not match the order — routed to partial (integrity alarm)',
      );
    }

    // C3 — a refund/failure IPN for an ALREADY-PAID order. `paid` is
    // terminal-forward, so the lock made no transition (outcome.order.status is
    // still 'paid'). The activated tier IS now auto-clawed-back: the entitlement
    // this order granted is revoked and the account tier is reconciled to its
    // best REMAINING valid access (a live Stripe sub / another valid crypto
    // entitlement / free) via the same non-stranding best-remaining machinery the
    // expiry sweeper uses — see the tierActivator.revokeTierForRefundedOrder call
    // among the side-effects below (fired OUTSIDE the lock). This WARN is an ops
    // visibility note; it no longer names a manual remediation as the primary
    // path (the clawback is automatic + idempotent on IPN replay). Gating on
    // mapped0 (not provider_status==='refunded') also catches an anomalous
    // failed/expired-after-paid; provider_status is logged to distinguish. The
    // payment_id-mismatch early-return above already excludes a refund for a
    // DIFFERENT payment (which alarms separately).
    if (mapped0 === 'failed' && outcome.order.status === 'paid') {
      this.opts.logger?.warn?.(
        {
          component: 'crypto-orders',
          event: 'ipn_refund_after_paid',
          order_id: args.order_id,
          account_id: outcome.order.account_id,
          product: outcome.order.product,
          payment_id: outcome.order.payment_id,
          provider_status: args.provider_status,
        },
        'crypto IPN reports refund/failure for an ALREADY-PAID order — order stays paid; the activated tier is auto-clawed back via entitlement revocation + best-remaining reconcile (non-stranding, idempotent on replay)',
      );
    }

    // Side-effects fire OUTSIDE the lock, gated on the atomic transition decision.
    if (outcome.fireFailed) {
      // V-666.AN — crypto.order.failed on the IPN-driven →failed transition.
      await this.emitFailedTransition(outcome.order, 'ipn');
    }
    // C3 — refund/chargeback clawback on an ALREADY-PAID order. Same gate as the
    // WARN above (a refund/failure IPN that made no forward transition because
    // the order is terminal-paid). Fires OUTSIDE the lock alongside the other
    // side-effects. Best-effort: a clawback failure must NOT break the 200 IPN
    // ack (a non-200 would make NowPayments retry the refund IPN indefinitely),
    // so it logs a loud integrity alarm naming the manual admin change-tier
    // fallback instead. Idempotent on replay: the activator's revoke only affects
    // a still-valid entitlement, so a re-delivered refund IPN finds it already
    // expired and no-ops (no second reconcile / emit).
    if (
      mapped0 === 'failed' &&
      outcome.order.status === 'paid' &&
      this.opts.tierActivator !== undefined &&
      outcome.order.account_id !== null
    ) {
      try {
        await this.opts.tierActivator.revokeTierForRefundedOrder({
          account_id: outcome.order.account_id,
          order_id: outcome.order.order_id,
          at: new Date(this.nowFn()),
        });
      } catch (err) {
        this.opts.logger?.error(
          {
            component: 'crypto-orders',
            event: 'crypto_refund_tier_clawback_failed',
            order_id: outcome.order.order_id,
            account_id: outcome.order.account_id,
            product: outcome.order.product,
            payment_id: outcome.order.payment_id,
            err: err instanceof Error ? err.message : String(err),
          },
          'crypto order refunded but the tier clawback FAILED — the refunded customer may retain the paid tier until the entitlement expires; remediate via admin change-tier (integrity alarm)',
        );
      }
    }
    // V-666.I/R — crypto.order.paid webhook + receipt email on the →paid transition.
    // Best-effort: emission failures are swallowed so the IPN ack stays 200.
    if (outcome.firePaid && outcome.order.account_id !== null) {
      const paidAtIso = new Date(outcome.order.updated_at).toISOString();
      // S41 2026-07-07 (founder-approved: wire crypto activation) — account-tier
      // activation fires FIRST among the paid side-effects: the tier grant is
      // the entitlement the customer paid for; the webhook + receipt email
      // below are informational. Idempotency: `firePaid` is computed against
      // the LOCKED committed row (order.status !== 'paid' && mapped === 'paid'),
      // so a replayed / duplicate / out-of-order IPN — which finds the order
      // already paid — never re-invokes the activator: no re-apply, no tier
      // flip-flop. The no-downgrade / stale-order precedence rule lives in the
      // activator itself (CryptoTierActivationService), decided atomically
      // against the account row. UNLIKE the best-effort webhook/email catches
      // below, a failure here is NOT silent: the customer paid and did not
      // receive their tier, so it logs a loud integrity alarm naming the
      // remediation path (admin change-tier), while the IPN still acks 200
      // (a NowPayments retry would find the order already paid and cannot
      // re-drive activation — ops must remediate from the alarm).
      if (this.opts.tierActivator !== undefined) {
        try {
          await this.opts.tierActivator.activateTierForPaidOrder({
            account_id: outcome.order.account_id,
            order_id: outcome.order.order_id,
            product: outcome.order.product,
            payment_id: outcome.order.payment_id,
            paid_at: paidAtIso,
          });
        } catch (err) {
          this.opts.logger?.error(
            {
              component: 'crypto-orders',
              event: 'crypto_paid_tier_activation_failed',
              order_id: outcome.order.order_id,
              account_id: outcome.order.account_id,
              product: outcome.order.product,
              err: err instanceof Error ? err.message : String(err),
            },
            'crypto order reached paid but tier activation FAILED — customer paid without receiving their tier; remediate via admin change-tier (integrity alarm)',
          );
        }
      }
      if (this.opts.webhooks !== undefined) {
        try {
          await this.opts.webhooks.enqueueEvent(outcome.order.account_id, 'crypto.order.paid', {
            order_id: outcome.order.order_id,
            product: outcome.order.product,
            price_cents: outcome.order.price_cents,
            price_currency: outcome.order.price_currency,
            payment_id: outcome.order.payment_id,
            paid_at: paidAtIso,
          });
        } catch {
          /* swallow */
        }
      }
      if (this.opts.paidEmailNotifier !== undefined) {
        try {
          await this.opts.paidEmailNotifier.notifyOrderPaid({
            account_id: outcome.order.account_id,
            order_id: outcome.order.order_id,
            product: outcome.order.product,
            price_cents: outcome.order.price_cents,
            price_currency: outcome.order.price_currency,
            payment_id: outcome.order.payment_id,
            paid_at: paidAtIso,
          });
        } catch {
          /* swallow */
        }
      }
    }
    return outcome.order;
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
/** The moment an order transitioned to paid — sourced from the append-only
 *  event log, NOT `updated_at`. `updated_at` is bumped by post-payment note
 *  edits (setInternalNote / updateCustomerNote have no status guard), which
 *  would drift the customer receipt's paid_at + inflate the time-to-pay KPI.
 *  Falls back to updated_at for legacy rows with no recorded paid event. */
function paidAtMs(order: CryptoOrder): number {
  return order.events.find((e) => e.status === 'paid')?.at ?? order.updated_at;
}

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
