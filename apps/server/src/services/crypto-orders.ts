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
  | 'partial'; // amount received < expected

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
      created_at: now,
      updated_at: now,
    };
    await this.opts.repo.upsert(order);
    return order;
  }

  async getById(orderId: string): Promise<CryptoOrder | null> {
    return this.opts.repo.getById(orderId);
  }

  /**
   * V-666.D — admin-only list. Returns the most-recent `limit` orders
   * across all customers, optionally filtered by account_id. Sort
   * order is `created_at DESC`.
   */
  async listForAdmin(opts: { accountId?: string; limit?: number } = {}): Promise<CryptoOrder[]> {
    return this.opts.repo.listAll(opts);
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
      if (
        order.status !== 'paid' &&
        mapped === 'paid' &&
        updated.account_id !== null &&
        this.opts.webhooks !== undefined
      ) {
        try {
          await this.opts.webhooks.enqueueEvent(updated.account_id, 'crypto.order.paid', {
            order_id: updated.order_id,
            product: updated.product,
            price_cents: updated.price_cents,
            price_currency: updated.price_currency,
            payment_id: updated.payment_id,
            paid_at: new Date(updated.updated_at).toISOString(),
          });
        } catch {
          /* swallow */
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
  // Terminal statuses don't move.
  if (current === 'paid' || current === 'failed') return false;
  // 'partial' is semi-terminal: only 'paid' or 'failed' overrides it.
  if (current === 'partial') return next === 'paid' || next === 'failed';
  // From 'pending' or 'confirming' anything except 'pending' is forward.
  return next !== 'pending';
}
