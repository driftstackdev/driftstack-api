// V-534.AB — Crypto receipt view.
// V-534.BM — adds a "Download PDF" button that fetches
//            /receipt.pdf (V-666.U) as a blob + triggers an anchor
//            click. The endpoint is auth-gated, so a plain link
//            wouldn't work.
// V-534.BN — adds a sibling "Download .txt" button for the
//            plain-text variant (V-666.P).
//
// Renders a receipt for a specific order id using useCryptoReceipt
// (V-534.AA). Includes a "Copy to clipboard" button that uses
// formatReceiptForClipboard. Empty / loading / error / ready states
// rendered consistently with the rest of the V-534.* view family.

import { useEffect, useState } from 'react';
import { CryptoOrderStatusBadge } from '../components/CryptoOrderStatusBadge';
import { ErrorBanner } from '../components/ErrorBanner';
import { formatCents, formatProduct, formatTimestamp } from '../lib/crypto-format';
import {
  formatReceiptForClipboard,
  useCryptoReceipt,
  type CryptoReceiptData,
} from '../lib/use-crypto-receipt';
import { useReceiptPdfDownload } from '../lib/use-receipt-pdf-download';

interface CryptoReceiptViewProps {
  /** The order id to render. Pass null to show the empty state. */
  orderId: string | null;
}

function ReceiptBody({ data }: { data: CryptoReceiptData }): JSX.Element {
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const pdf = useReceiptPdfDownload();

  useEffect(() => {
    if (copyState !== 'copied') return;
    const timer = window.setTimeout(() => setCopyState('idle'), 2_000);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const onCopy = async (): Promise<void> => {
    if (copyState === 'copying') return;
    setCopyState('copying');
    try {
      await navigator.clipboard.writeText(formatReceiptForClipboard(data));
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };
  const downloadingPdf = pdf.state.kind === 'downloading' && pdf.state.format === 'pdf';
  const downloadingText = pdf.state.kind === 'downloading' && pdf.state.format === 'txt';
  return (
    <div className="flex flex-col gap-4 rounded-md border border-surface-divider bg-surface-inset p-4">
      <header className="flex items-center justify-between">
        <h3 className="text-base font-semibold">Receipt</h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void pdf.download(data.order_id, 'pdf')}
            disabled={pdf.state.kind === 'downloading'}
            aria-busy={downloadingPdf}
            className="rounded border border-surface-divider px-2 py-1 text-xs font-medium hover:bg-surface-base disabled:opacity-50"
          >
            {downloadingPdf ? 'Downloading PDF…' : 'Download PDF'}
          </button>
          <button
            type="button"
            onClick={() => void pdf.download(data.order_id, 'txt')}
            disabled={pdf.state.kind === 'downloading'}
            aria-busy={downloadingText}
            className="rounded border border-surface-divider px-2 py-1 text-xs font-medium hover:bg-surface-base disabled:opacity-50"
          >
            {downloadingText ? 'Downloading text…' : 'Download .txt'}
          </button>
          <button
            type="button"
            onClick={() => void onCopy()}
            disabled={copyState === 'copying'}
            aria-busy={copyState === 'copying'}
            className="rounded border border-surface-divider px-2 py-1 text-xs font-medium hover:bg-surface-base"
          >
            {copyState === 'copying'
              ? 'Copying…'
              : copyState === 'copied'
                ? 'Copied'
                : copyState === 'failed'
                  ? 'Retry copy'
                  : 'Copy to clipboard'}
          </button>
        </div>
      </header>
      {pdf.state.kind === 'failed' && (
        <ErrorBanner
          message={`${pdf.state.format === 'pdf' ? 'PDF' : 'Text receipt'} download failed: ${pdf.state.message}`}
          onDismiss={() => pdf.reset()}
        />
      )}
      {copyState === 'failed' && (
        <p role="alert" className="text-xs text-status-error">
          Couldn’t copy the receipt. Check clipboard permission and try again.
        </p>
      )}
      <dl className="grid grid-cols-2 gap-y-1 text-sm">
        <dt className="text-ink-secondary">Order</dt>
        <dd className="font-mono text-xs">{data.order_id}</dd>
        <dt className="text-ink-secondary">Status</dt>
        <dd>
          <CryptoOrderStatusBadge status={data.status} size="sm" />
        </dd>
        <dt className="text-ink-secondary">Product</dt>
        <dd>{formatProduct(data.product)}</dd>
        <dt className="text-ink-secondary">Amount</dt>
        <dd>{formatCents(data.price_cents, data.price_currency)}</dd>
        {data.paid_at !== null && (
          <>
            <dt className="text-ink-secondary">Paid at</dt>
            <dd>{formatTimestamp(data.paid_at)}</dd>
          </>
        )}
        {data.payment_id !== null && (
          <>
            <dt className="text-ink-secondary">Payment id</dt>
            <dd className="font-mono text-xs">{data.payment_id}</dd>
          </>
        )}
        <dt className="text-ink-secondary">Issued</dt>
        <dd>{formatTimestamp(data.issued_at)}</dd>
      </dl>
    </div>
  );
}

export function CryptoReceiptView(props: CryptoReceiptViewProps): JSX.Element {
  const { state, refetch } = useCryptoReceipt(props.orderId);

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
    // Dismiss retries the receipt fetch instead of dead-ending the panel.
    return <ErrorBanner message={state.message} onDismiss={() => void refetch()} />;
  }

  return <ReceiptBody data={state.data} />;
}
