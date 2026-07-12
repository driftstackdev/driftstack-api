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

export function CryptoCheckoutFlowView(props: CryptoCheckoutFlowViewProps): JSX.Element {
  const [product, setProduct] = useState<string>(props.defaultProduct);
  const quote = useCryptoQuote({ product });
  const checkout = useCryptoCheckout();
  const orderId = checkout.state.kind === 'ready' ? checkout.state.order.order_id : null;
  const order = useCryptoOrder(orderId, { pollIntervalMs: 5_000 });
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  // Track the "Copied ✓" reset timer so a torn-down address block (Start-another-checkout
  // unmounts the copy button) or a rapid re-copy can't update stale copy state
  // or stack overlapping timers (audit 2026-07-08 #19).
  const copiedTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const onStart = (): void => {
    if (quote.state.kind !== 'ready') return;
    void checkout.start({
      product,
      price_cents: quote.state.data.price_cents,
      price_currency: quote.state.data.price_currency,
    });
  };

  const onReset = (): void => {
    checkout.reset();
  };

  const copyAddress = (addr: string): void => {
    // The payment address is the highest-stakes copy in the app — a truncated hand-select
    // loses funds. Give one-click copy + a transient confirm (audit 2026-07-08).
    if (copyState === 'copying') return;
    setCopyState('copying');
    void navigator.clipboard.writeText(addr).then(
      () => {
        setCopyState('copied');
        // Clear any in-flight reset before arming a fresh one so rapid copies don't stack timers.
        if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = window.setTimeout(() => {
          copiedTimerRef.current = null;
          setCopyState('idle');
        }, 2000);
      },
      () => {
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
            value={product}
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
          {quote.state.kind === 'loading' && (
            <span className="text-ink-secondary">Loading quote…</span>
          )}
          {quote.state.kind === 'error' && (
            <ErrorBanner message={quote.state.message} onDismiss={() => void quote.refetch()} />
          )}
          {quote.state.kind === 'ready' && (
            <span>
              Price:{' '}
              <strong>
                {formatCents(quote.state.data.price_cents, quote.state.data.price_currency)}
              </strong>
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
            disabled={quote.state.kind !== 'ready'}
            className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
          >
            Start checkout
          </button>
        )}
        {checkout.state.kind === 'loading' && (
          <span className="text-sm text-ink-secondary">Minting order…</span>
        )}
        {checkout.state.kind === 'error' && (
          <ErrorBanner message={checkout.state.message} onDismiss={onReset} />
        )}
        {checkout.state.kind === 'ready' &&
          (() => {
            const { order, replayed } = checkout.state;
            const addr = order.payment_address;
            return (
              <div className="flex flex-col gap-2 text-sm">
                <div>
                  Order id: <span className="font-mono text-xs">{order.order_id}</span>
                </div>
                {replayed && (
                  <div
                    role="status"
                    className="rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs text-ink-secondary"
                  >
                    Restored from your earlier attempt (no duplicate order minted).
                  </div>
                )}
                {addr !== null && (
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
                      onClick={() => copyAddress(addr)}
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
                )}
                {addr !== null && copyState === 'failed' && (
                  <p role="alert" className="text-xs text-status-error">
                    Couldn’t copy the payment address. Check clipboard permission and try again.
                  </p>
                )}
                {order.provider === 'stub' && (
                  <div className="text-ink-secondary">
                    Payment provider is in stub mode. Contact support to receive a real payment
                    address.
                  </div>
                )}
                {/* Don't dead-end after minting: the product select locks once an order exists,
                    so offer a way back to idle to buy a different tier / retry (audit 2026-07-08). */}
                <button
                  type="button"
                  onClick={onReset}
                  className="mt-1 self-start rounded border border-surface-divider px-2 py-0.5 text-xs text-ink-secondary transition-colors hover:text-ink-primary"
                >
                  Start another checkout
                </button>
              </div>
            );
          })()}
      </section>

      {/* Step 3: live order status (polls until terminal) */}
      {orderId !== null && (
        <section className="rounded-md border border-surface-divider p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-ink-secondary">Order status</span>
            {order.state.kind === 'ready' && (
              <CryptoOrderStatusBadge status={order.state.data.status} size="sm" />
            )}
            {order.state.kind === 'loading' && <span className="text-ink-secondary">Loading…</span>}
          </div>
          {order.state.kind === 'error' && (
            <div className="mt-2">
              {/* Dismiss re-polls the order status rather than dead-ending on a stale
                  error (a transient poll failure shouldn't strand the customer). */}
              <ErrorBanner message={order.state.message} onDismiss={() => void order.refetch()} />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
