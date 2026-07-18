// V-534.AC — composite crypto-checkout flow view.
//
// Three-step flow stitched together from the V-534.* hook family:
//   1. Pick a product → useCryptoQuote shows the price preview.
//   2. Click "Start checkout" → useCryptoCheckout mints an order.
//   3. Once the order_id is in hand → useCryptoOrder polls until
//      the status reaches a terminal state (paid / failed).
//
// Designed for the GUI's /billing/crypto-checkout entry point. The
// component takes a `defaultProduct` prop so it can be embedded from
// pricing-page CTAs; the user can still switch products before
// minting.

import { useEffect, useRef, useState } from 'react';
import { CryptoOrderStatusBadge } from '../components/CryptoOrderStatusBadge';
import { ErrorBanner } from '../components/ErrorBanner';
import { writeClipboardText } from '../lib/clipboard';
import { formatCents, formatProduct } from '../lib/crypto-format';
import { useCryptoCheckout } from '../lib/use-crypto-checkout';
import { useCryptoOrder } from '../lib/use-crypto-order';
import { useCryptoQuote } from '../lib/use-crypto-quote';

export interface CryptoCheckoutFlowViewProps {
  defaultProduct: string;
}

const SUPPORTED_PRODUCTS = [
  'solo_manual',
  'team_manual',
  'agency_manual',
  'api_starter',
  'api_builder',
  'api_scale',
] as const;

function formatCryptoAmount(amount: number): string {
  return amount.toLocaleString('en-US', {
    useGrouping: false,
    maximumFractionDigits: 20,
  });
}

export function CryptoCheckoutFlowView(props: CryptoCheckoutFlowViewProps): JSX.Element {
  const [product, setProduct] = useState<string>(props.defaultProduct);
  const checkout = useCryptoCheckout();
  const selectedProduct = checkout.lockedArgs?.product ?? product;
  // Checkout is server-locked to USD. Request the preview in that same
  // currency so the amount shown before confirmation matches the order.
  const quote = useCryptoQuote({ product: selectedProduct, priceCurrency: 'USD' });
  const currentQuote =
    quote.state.kind === 'ready' &&
    quote.state.data.product === selectedProduct &&
    quote.state.data.price_currency === 'USD'
      ? quote.state.data
      : null;
  const orderId = checkout.state.kind === 'ready' ? checkout.state.order.order_id : null;
  const orderStatus = useCryptoOrder(orderId, { pollIntervalMs: 5_000 });
  const statusOrderIdRef = useRef<string | null>(orderId);
  const lastAuthoritativeStatusRef = useRef<
    'pending' | 'confirming' | 'paid' | 'failed' | 'partial' | 'cancelled' | null
  >(null);
  if (statusOrderIdRef.current !== orderId) {
    statusOrderIdRef.current = orderId;
    lastAuthoritativeStatusRef.current = null;
  }
  const currentOrderStatus =
    orderStatus.state.kind === 'ready' && orderStatus.state.data.order_id === orderId
      ? orderStatus.state.data
      : null;
  if (
    currentOrderStatus !== null &&
    !(
      lastAuthoritativeStatusRef.current !== null &&
      lastAuthoritativeStatusRef.current !== 'pending' &&
      currentOrderStatus.status === 'pending'
    )
  ) {
    lastAuthoritativeStatusRef.current = currentOrderStatus.status;
  }
  const checkoutOrder = checkout.state.kind === 'ready' ? checkout.state.order : null;
  const effectiveOrderStatus = lastAuthoritativeStatusRef.current ?? checkoutOrder?.status ?? null;
  const hasCurrentOrderStatus = currentOrderStatus !== null;
  const parsedPaymentDeadline =
    currentOrderStatus?.status === 'pending' && typeof currentOrderStatus.expires_at === 'string'
      ? Date.parse(currentOrderStatus.expires_at)
      : Number.NaN;
  const paymentDeadlineMs = Number.isFinite(parsedPaymentDeadline) ? parsedPaymentDeadline : null;
  const [paymentDeadlineTick, setPaymentDeadlineTick] = useState(0);
  useEffect(() => {
    if (paymentDeadlineMs === null) return undefined;
    const remainingMs = paymentDeadlineMs - Date.now();
    if (remainingMs <= 0) return undefined;
    const timer = window.setTimeout(
      () => setPaymentDeadlineTick((tick) => tick + 1),
      Math.min(remainingMs + 1, 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [orderId, paymentDeadlineMs, paymentDeadlineTick]);
  const hasOpenPaymentWindow =
    currentOrderStatus?.status === 'pending' &&
    effectiveOrderStatus === 'pending' &&
    paymentDeadlineMs !== null &&
    paymentDeadlineMs > Date.now();
  const activePaymentContext =
    checkoutOrder?.provider === 'nowpayments' &&
    hasOpenPaymentWindow &&
    checkoutOrder.payment_address !== null &&
    checkoutOrder.pay_currency !== null &&
    checkoutOrder.pay_amount !== null &&
    checkoutOrder.pay_amount > 0
      ? {
          address: checkoutOrder.payment_address,
          amount: checkoutOrder.pay_amount,
          currency: checkoutOrder.pay_currency,
        }
      : null;
  const activePaymentAddress = activePaymentContext?.address ?? null;
  const canStartAnotherCheckout =
    effectiveOrderStatus === 'paid' ||
    effectiveOrderStatus === 'failed' ||
    effectiveOrderStatus === 'cancelled';
  const activePaymentAddressRef = useRef<string | null>(activePaymentAddress);
  activePaymentAddressRef.current = activePaymentAddress;
  const activePaymentDeadlineRef = useRef<number | null>(
    hasOpenPaymentWindow ? paymentDeadlineMs : null,
  );
  activePaymentDeadlineRef.current = hasOpenPaymentWindow ? paymentDeadlineMs : null;
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  // Track the "Copied ✓" reset timer so a torn-down address block (Start-another-checkout
  // unmounts the copy button) or a rapid re-copy can't update stale copy state
  // or stack overlapping timers (audit 2026-07-08 #19).
  const copiedTimerRef = useRef<number | null>(null);
  const copyGenerationRef = useRef(0);
  useEffect(() => {
    return () => {
      copyGenerationRef.current += 1;
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

  useEffect(() => {
    copyGenerationRef.current += 1;
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = null;
    setCopyState('idle');
  }, [activePaymentAddress]);

  const onStart = (): void => {
    if (currentQuote === null) return;
    void checkout.start({
      product: selectedProduct,
      price_cents: currentQuote.price_cents,
      price_currency: currentQuote.price_currency,
    });
  };

  const onReset = (): void => {
    copyGenerationRef.current += 1;
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = null;
    setCopyState('idle');
    if (checkout.lockedArgs !== null) setProduct(checkout.lockedArgs.product);
    checkout.reset();
  };

  const copyAddress = (addr: string): void => {
    // The payment address is the highest-stakes copy in the app — a truncated hand-select
    // loses funds. Give one-click copy + a transient confirm (audit 2026-07-08).
    if (
      copyState === 'copying' ||
      activePaymentAddressRef.current !== addr ||
      activePaymentDeadlineRef.current === null ||
      activePaymentDeadlineRef.current <= Date.now()
    ) {
      return;
    }
    const generation = ++copyGenerationRef.current;
    setCopyState('copying');
    void writeClipboardText(addr).then(
      () => {
        if (generation !== copyGenerationRef.current) return;
        setCopyState('copied');
        // Clear any in-flight reset before arming a fresh one so rapid copies don't stack timers.
        if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = window.setTimeout(() => {
          if (generation !== copyGenerationRef.current) return;
          copiedTimerRef.current = null;
          setCopyState('idle');
        }, 2000);
      },
      () => {
        if (generation !== copyGenerationRef.current) return;
        setCopyState('failed');
      },
    );
  };

  return (
    <div className="flex flex-col gap-4 p-6">
      <header>
        <h2 className="text-lg font-semibold">Crypto checkout</h2>
      </header>

      {/* Step 1: product picker + quote */}
      <section className="rounded-md border border-surface-divider p-4">
        <label className="flex items-center gap-3 text-sm">
          <span className="text-ink-secondary">Product</span>
          <select
            value={selectedProduct}
            onChange={(e) => setProduct(e.target.value)}
            disabled={checkout.state.kind !== 'idle'}
            className="rounded border border-surface-divider bg-surface-inset px-2 py-1"
          >
            {SUPPORTED_PRODUCTS.map((p) => (
              <option key={p} value={p}>
                {formatProduct(p)}
              </option>
            ))}
          </select>
        </label>
        <div className="mt-3 text-sm">
          {(quote.state.kind === 'loading' ||
            (quote.state.kind === 'ready' && currentQuote === null)) && (
            <span className="text-ink-secondary">Loading quote…</span>
          )}
          {quote.state.kind === 'error' && (
            <ErrorBanner message={quote.state.message} onDismiss={() => void quote.refetch()} />
          )}
          {currentQuote !== null && (
            <span>
              Price:{' '}
              <strong>{formatCents(currentQuote.price_cents, currentQuote.price_currency)}</strong>
            </span>
          )}
        </div>
      </section>

      {/* Step 2: start-checkout button + result */}
      <section className="rounded-md border border-surface-divider p-4">
        {checkout.state.kind === 'idle' && (
          <button
            type="button"
            onClick={onStart}
            disabled={currentQuote === null}
            className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
          >
            Start checkout
          </button>
        )}
        {checkout.state.kind === 'loading' && (
          <span className="text-sm text-ink-secondary">Confirming checkout…</span>
        )}
        {checkout.state.kind === 'error' && (
          <ErrorBanner message={checkout.state.message} onDismiss={onReset} />
        )}
        {checkout.state.kind === 'outcome_unknown' && (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 p-3 text-sm"
          >
            <p>{checkout.state.message}</p>
            <p className="text-xs text-ink-secondary">
              {checkout.state.retryable
                ? 'Don’t start a new checkout. Retry safely reuses the original request instead of minting a second order.'
                : 'Do not start another checkout until Orders or billing support confirms this one.'}
            </p>
            {checkout.state.retryable && (
              <button
                type="button"
                onClick={() => void checkout.retry()}
                className="self-start rounded border border-surface-divider bg-surface-raised px-2 py-1 text-xs font-medium text-ink-primary transition-colors hover:bg-surface-inset"
              >
                Retry same checkout
              </button>
            )}
          </div>
        )}
        {checkout.state.kind === 'ready' &&
          (() => {
            const { order, replayed } = checkout.state;
            const payment = activePaymentContext;
            const addr = payment?.address ?? null;
            const priceChanged =
              currentQuote !== null &&
              (currentQuote.price_cents !== order.price_cents ||
                currentQuote.price_currency !== order.price_currency);
            return (
              <div className="flex flex-col gap-2 text-sm">
                <div>
                  Order id: <span className="font-mono text-xs">{order.order_id}</span>
                </div>
                <div>
                  Checkout amount:{' '}
                  <strong>{formatCents(order.price_cents, order.price_currency)}</strong>
                </div>
                {priceChanged && (
                  <div role="status" className="text-xs text-status-warning">
                    Price updated before checkout. The amount above is the authoritative charge.
                  </div>
                )}
                {replayed && (
                  <div
                    role="status"
                    className="rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs text-ink-secondary"
                  >
                    Restored from your earlier attempt (no duplicate order minted).
                  </div>
                )}
                {payment !== null && (
                  <>
                    <div>
                      Send exactly:{' '}
                      <strong className="font-mono">
                        {formatCryptoAmount(payment.amount)} {payment.currency.toUpperCase()}
                      </strong>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-ink-secondary">Send to:</span>
                      <span className="min-w-0 flex-1 break-all font-mono text-xs">{addr}</span>
                      <button
                        type="button"
                        aria-label={
                          copyState === 'copying'
                            ? 'Copying payment address'
                            : copyState === 'failed'
                              ? 'Retry copying payment address'
                              : 'Copy payment address'
                        }
                        onClick={() => copyAddress(payment.address)}
                        disabled={copyState === 'copying'}
                        aria-busy={copyState === 'copying'}
                        className="shrink-0 rounded border border-surface-divider bg-surface-inset px-2 py-0.5 text-xs text-ink-secondary transition-colors hover:text-ink-primary"
                      >
                        {copyState === 'copying'
                          ? 'Copying…'
                          : copyState === 'copied'
                            ? 'Copied ✓'
                            : copyState === 'failed'
                              ? 'Retry copy'
                              : 'Copy'}
                      </button>
                    </div>
                  </>
                )}
                {addr !== null && copyState === 'failed' && (
                  <p role="alert" className="text-xs text-status-error">
                    Couldn’t copy the payment address. Check clipboard permission and try again.
                  </p>
                )}
                {order.provider === 'nowpayments' &&
                  effectiveOrderStatus === 'pending' &&
                  currentOrderStatus === null && (
                    <p role="alert" className="text-xs text-status-error">
                      Payment instructions are hidden until the latest order status is confirmed. Do
                      not send funds.
                    </p>
                  )}
                {order.provider === 'nowpayments' &&
                  currentOrderStatus?.status === 'pending' &&
                  !hasOpenPaymentWindow && (
                    <p role="alert" className="text-xs text-status-error">
                      The payment window is unavailable or has expired. Do not send funds; review
                      Orders or contact billing@driftstack.dev.
                    </p>
                  )}
                {order.provider === 'nowpayments' &&
                  hasOpenPaymentWindow &&
                  activePaymentAddress === null && (
                    <p role="alert" className="text-xs text-status-error">
                      Payment instructions are not available yet. Do not send funds; review Orders
                      or contact billing@driftstack.dev.
                    </p>
                  )}
                {effectiveOrderStatus !== 'pending' && (
                  <p role="status" className="text-xs text-ink-secondary">
                    Payment instructions are hidden because this order is {effectiveOrderStatus}. Do
                    not send more funds.
                  </p>
                )}
                {order.provider === 'stub' && effectiveOrderStatus === 'pending' && (
                  <div className="text-ink-secondary">
                    Crypto checkout is unavailable on this server. Use card checkout instead, or
                    contact billing@driftstack.dev.
                  </div>
                )}
                {canStartAnotherCheckout ? (
                  <button
                    type="button"
                    onClick={onReset}
                    className="mt-1 self-start rounded border border-surface-divider px-2 py-0.5 text-xs text-ink-secondary transition-colors hover:text-ink-primary"
                  >
                    Start another checkout
                  </button>
                ) : (
                  <p className="text-xs text-ink-secondary">
                    Review this order in the Orders tab before starting another checkout.
                  </p>
                )}
              </div>
            );
          })()}
      </section>

      {/* Step 3: live order status (polls until terminal) */}
      {orderId !== null && (
        <section className="rounded-md border border-surface-divider p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-ink-secondary">Order status</span>
            {hasCurrentOrderStatus && orderStatus.state.kind === 'ready' && (
              <CryptoOrderStatusBadge
                status={effectiveOrderStatus ?? orderStatus.state.data.status}
                size="sm"
              />
            )}
            {(orderStatus.state.kind === 'loading' ||
              (orderStatus.state.kind === 'ready' && !hasCurrentOrderStatus)) && (
              <span className="text-ink-secondary">Loading…</span>
            )}
          </div>
          {orderStatus.state.kind === 'error' && (
            <div className="mt-2">
              {/* Dismiss re-polls the order status rather than dead-ending on a stale
                  error (a transient poll failure shouldn't strand the customer). */}
              <ErrorBanner
                message={orderStatus.state.message}
                onDismiss={() => void orderStatus.refetch()}
              />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
