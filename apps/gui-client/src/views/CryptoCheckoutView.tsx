// V-534.K — crypto-checkout view.
//
// Wraps the V-534.J `useCryptoCheckout` hook with a tier picker +
// "Pay with crypto" button + a result panel rendered when the order
// mints. Pre-merchant-account posture: the result panel surfaces a
// "support will reach out" notice instead of a deposit address (the
// route's stubbed `provider: 'stub'` response).
//
// Inputs: the parent supplies the supported tiers + prices so the
// view stays presentation-only.

import { useState } from 'react';
import { useCryptoCheckout } from '../lib/use-crypto-checkout';

export interface CryptoCheckoutOption {
  product: string;
  label: string;
  price_cents: number;
  price_currency: string;
}

export interface CryptoCheckoutViewProps {
  options: readonly CryptoCheckoutOption[];
}

export function CryptoCheckoutView(props: CryptoCheckoutViewProps): JSX.Element {
  const { state, start, reset } = useCryptoCheckout();
  const [selectedProduct, setSelectedProduct] = useState<string>(props.options[0]?.product ?? '');
  const selected = props.options.find((o) => o.product === selectedProduct);

  async function onPay(): Promise<void> {
    if (!selected) return;
    await start({
      product: selected.product,
      price_cents: selected.price_cents,
      price_currency: selected.price_currency,
    });
  }

  return (
    <section className="space-y-4 p-4" aria-labelledby="crypto-checkout-heading">
      <header>
        <h2 id="crypto-checkout-heading" className="text-lg font-semibold text-ink-primary">
          Pay with crypto
        </h2>
        <p className="text-sm text-ink-secondary">
          We support BTC, ETH, and major stablecoins. Your account upgrades automatically once your
          transfer settles on-chain.
        </p>
      </header>

      {state.kind !== 'ready' && (
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="crypto-product-picker" className="text-sm text-ink-secondary">
            Product
          </label>
          <select
            id="crypto-product-picker"
            value={selectedProduct}
            onChange={(e) => setSelectedProduct(e.target.value)}
            className="rounded border border-surface-divider bg-surface-input px-2 py-1 text-sm text-ink-primary"
            disabled={state.kind === 'loading'}
          >
            {props.options.map((o) => (
              <option key={o.product} value={o.product}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void onPay()}
            disabled={state.kind === 'loading' || !selected}
            className="rounded border border-accent bg-accent px-3 py-1 text-sm font-medium text-on-accent hover:bg-accent-strong disabled:opacity-50"
          >
            {state.kind === 'loading' ? 'Minting order…' : 'Pay with crypto'}
          </button>
        </div>
      )}

      {state.kind === 'error' && (
        <div
          role="alert"
          className="rounded border border-status-error/60 bg-status-error/10 p-3 text-sm text-status-error"
        >
          Could not create the order: {state.message}
        </div>
      )}

      {state.kind === 'ready' && (
        <div
          role="status"
          aria-label="Crypto order ready"
          className="rounded border border-status-success/40 bg-surface-raised p-4 space-y-2"
        >
          <p className="text-sm text-ink-secondary">Order created</p>
          <p className="font-mono text-base text-ink-primary">{state.order.order_id}</p>
          {state.order.provider === 'stub' ? (
            <p className="text-sm text-ink-secondary">
              We&apos;ll email you a payment address within one business day. Quote your order id
              when you reply.
            </p>
          ) : (
            <>
              <p className="text-xs text-ink-secondary">Send</p>
              <p className="font-mono text-sm text-ink-primary">
                {state.order.payment_address ?? 'pending…'}
              </p>
            </>
          )}
          <button type="button" onClick={() => reset()} className="text-sm text-accent underline">
            Start another order
          </button>
        </div>
      )}
    </section>
  );
}
