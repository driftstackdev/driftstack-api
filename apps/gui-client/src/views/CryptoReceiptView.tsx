// V-534.AB — Crypto receipt view.
//
// Renders a receipt for a specific order id using useCryptoReceipt
// (V-534.AA). Includes a "Copy to clipboard" button that uses
// formatReceiptForClipboard. Empty / loading / error / ready states
// rendered consistently with the rest of the V-534.* view family.

import { useState } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
import {
  formatReceiptForClipboard,
  useCryptoReceipt,
  type CryptoReceiptData,
} from '../lib/use-crypto-receipt';

interface CryptoReceiptViewProps {
  /** The order id to render. Pass null to show the empty state. */
  orderId: string | null;
}

function formatCents(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

function ReceiptBody({ data }: { data: CryptoReceiptData }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(formatReceiptForClipboard(data));
      setCopied(true);
      // Reset after 2s so the user sees the confirmation but the
      // button returns to its default state.
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      /* clipboard write can fail in iframes / locked-down envs; silent */
    }
  };
  return (
    <div className="flex flex-col gap-4 rounded-md border border-surface-divider bg-surface-inset p-4">
      <header className="flex items-center justify-between">
        <h3 className="text-base font-semibold">Receipt</h3>
        <button
          type="button"
          onClick={() => void onCopy()}
          className="rounded border border-surface-divider px-2 py-1 text-xs font-medium hover:bg-surface-base"
        >
          {copied ? 'Copied' : 'Copy to clipboard'}
        </button>
      </header>
      <dl className="grid grid-cols-2 gap-y-1 text-sm">
        <dt className="text-ink-secondary">Order</dt>
        <dd className="font-mono text-xs">{data.order_id}</dd>
        <dt className="text-ink-secondary">Status</dt>
        <dd>{data.status}</dd>
        <dt className="text-ink-secondary">Product</dt>
        <dd>{data.product}</dd>
        <dt className="text-ink-secondary">Amount</dt>
        <dd>{formatCents(data.price_cents, data.price_currency)}</dd>
        {data.paid_at !== null && (
          <>
            <dt className="text-ink-secondary">Paid at</dt>
            <dd>{data.paid_at}</dd>
          </>
        )}
        {data.payment_id !== null && (
          <>
            <dt className="text-ink-secondary">Payment id</dt>
            <dd className="font-mono text-xs">{data.payment_id}</dd>
          </>
        )}
        <dt className="text-ink-secondary">Issued</dt>
        <dd>{data.issued_at}</dd>
      </dl>
    </div>
  );
}

export function CryptoReceiptView(props: CryptoReceiptViewProps): JSX.Element {
  const { state } = useCryptoReceipt(props.orderId);

  if (props.orderId === null) {
    return (
      <div className="rounded-md border border-surface-divider bg-surface-inset p-4 text-sm text-ink-secondary">
        Pick an order to view its receipt.
      </div>
    );
  }

  if (state.kind === 'loading' || state.kind === 'idle') {
    return (
      <div className="rounded-md border border-surface-divider bg-surface-inset p-4 text-sm text-ink-secondary">
        Loading receipt…
      </div>
    );
  }

  if (state.kind === 'error') {
    return <ErrorBanner message={state.message} onDismiss={() => undefined} />;
  }

  return <ReceiptBody data={state.data} />;
}
