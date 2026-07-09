// V-534.AG — admin crypto-orders view.
// V-534.AL — adds inline internal-note editor (admin-only field, never
//            shown to the customer).
// V-534.AM — clicking an order row opens a detail drawer with the full
//            envelope; action buttons stop propagation so they don't
//            also open the drawer.
// V-534.AW — wires the V-666.AM cursor pagination: when the server
//            returns next_cursor, a "Load more" button appears below
//            the table and appends the next page in place.
// V-534.AX — adds a "Download CSV" button that hits
//            /v1/admin/crypto-orders.csv (V-666.AC) with the current
//            status + search filters and triggers a browser download
//            via blob + synthesized anchor.
// V-534.BC — adds an exact-match payment_id input (V-666.AS) used by
//            support to reverse-look-up an order from a NowPayments
//            payment id the customer sent over.
//
// Admin-only counterpart to CryptoOrdersHistoryView. Calls
// /v1/admin/crypto-orders (V-666.D + V-666.T) and renders the full
// cross-account list with status + free-text-search filter controls.
// Caller must hold an API key with the `driftstack_internal_admin`
// scope; without it the API returns 403 which surfaces as an error
// banner.
//
// V-666.D returns account_id in the public envelope so each row
// surfaces the owning account (helpful for support drilling into a
// customer's order).
//
// Crypto payments are non-refundable. The view intentionally does
// NOT surface refund actions; customer cancellation stops future
// billing periods but does not refund the current period.

import { useEffect, useRef, useState } from 'react';
import { CryptoOrderAdminDetailDrawer } from '../components/CryptoOrderAdminDetailDrawer';
import { CryptoOrderStatusBadge } from '../components/CryptoOrderStatusBadge';
import { ErrorBanner } from '../components/ErrorBanner';
import { formatCents, formatRelative } from '../lib/crypto-format';
import {
  useAdminCryptoOrdersList,
  type AdminCryptoOrder,
} from '../lib/use-admin-crypto-orders-list';
import { useAdminCsvExport } from '../lib/use-admin-csv-export';
import { useAdminInternalNote } from '../lib/use-admin-internal-note';

const STATUS_OPTIONS: Array<{ value: AdminCryptoOrder['status'] | ''; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'confirming', label: 'Confirming' },
  { value: 'paid', label: 'Paid' },
  { value: 'failed', label: 'Failed' },
  { value: 'partial', label: 'Partial' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function CryptoOrdersAdminView(): JSX.Element {
  const [status, setStatus] = useState<AdminCryptoOrder['status'] | ''>('');
  const [search, setSearch] = useState<string>('');
  const [paymentIdFilter, setPaymentIdFilter] = useState<string>('');
  const [createdAfter, setCreatedAfter] = useState<string>('');
  const [createdBefore, setCreatedBefore] = useState<string>('');
  const [noteTarget, setNoteTarget] = useState<AdminCryptoOrder | null>(null);
  const [noteInput, setNoteInput] = useState<string>('');
  const [detailOrder, setDetailOrder] = useState<AdminCryptoOrder | null>(null);
  const { state, refetch, loadMore } = useAdminCryptoOrdersList({
    status: status === '' ? null : status,
    search,
    paymentId: paymentIdFilter.length > 0 ? paymentIdFilter : null,
    createdAfter: createdAfter.length > 0 ? `${createdAfter}T00:00:00Z` : null,
    createdBefore: createdBefore.length > 0 ? `${createdBefore}T00:00:00Z` : null,
  });
  const internalNote = useAdminInternalNote();
  const csvExport = useAdminCsvExport({
    status: status === '' ? null : status,
    search,
    createdAfter: createdAfter.length > 0 ? `${createdAfter}T00:00:00Z` : null,
    createdBefore: createdBefore.length > 0 ? `${createdBefore}T00:00:00Z` : null,
  });

  useEffect(() => {
    if (internalNote.state.kind === 'succeeded') {
      void refetch().then(() => {
        internalNote.reset();
        setNoteTarget(null);
        setNoteInput('');
      });
    }
  }, [internalNote.state, internalNote, refetch]);

  // V-534.BL — modal a11y: escape closes the note dialog; the textarea
  // receives focus on open.
  const noteTextareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (noteTarget === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setNoteTarget(null);
        setNoteInput('');
      }
    };
    window.addEventListener('keydown', onKey);
    noteTextareaRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [noteTarget]);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Crypto orders (admin)</h2>
        <div className="flex items-center gap-2">
          {(status !== '' ||
            search.length > 0 ||
            paymentIdFilter.length > 0 ||
            createdAfter.length > 0 ||
            createdBefore.length > 0) && (
            <button
              type="button"
              onClick={() => {
                setStatus('');
                setSearch('');
                setPaymentIdFilter('');
                setCreatedAfter('');
                setCreatedBefore('');
              }}
              className="rounded-md border border-surface-divider bg-surface-inset px-3 py-1 text-xs font-medium hover:bg-surface-base"
            >
              Reset filters
            </button>
          )}
          <button
            type="button"
            onClick={() => void csvExport.download()}
            disabled={csvExport.state.kind === 'downloading'}
            className="rounded-md border border-surface-divider bg-surface-inset px-3 py-1 text-sm font-medium disabled:opacity-50"
            aria-label="Download CSV of current filter"
          >
            {csvExport.state.kind === 'downloading' ? 'Downloading…' : 'Download CSV'}
          </button>
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={state.kind === 'loading'}
            className="rounded-md border border-surface-divider bg-surface-inset px-3 py-1 text-sm font-medium disabled:opacity-50"
          >
            {state.kind === 'loading' ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          Status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as AdminCryptoOrder['status'] | '')}
            className="rounded border border-surface-divider bg-surface-base px-2 py-1 text-sm"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-1 items-center gap-2 text-sm">
          Search
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="order_id / product / customer note…"
            className="flex-1 rounded border border-surface-divider bg-surface-base px-2 py-1 text-sm"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          Payment ID
          <input
            type="search"
            value={paymentIdFilter}
            onChange={(e) => setPaymentIdFilter(e.target.value)}
            placeholder="np_…"
            aria-label="Filter by NowPayments payment id"
            className="w-40 rounded border border-surface-divider bg-surface-base px-2 py-1 font-mono text-xs"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          From
          <input
            type="date"
            value={createdAfter}
            onChange={(e) => setCreatedAfter(e.target.value)}
            aria-label="Filter by created_at (inclusive lower bound)"
            className="rounded border border-surface-divider bg-surface-base px-2 py-1 text-xs"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          To
          <input
            type="date"
            value={createdBefore}
            onChange={(e) => setCreatedBefore(e.target.value)}
            aria-label="Filter by created_at (exclusive upper bound)"
            className="rounded border border-surface-divider bg-surface-base px-2 py-1 text-xs"
          />
        </label>
      </div>

      {state.kind === 'error' && (
        <ErrorBanner message={state.message} onDismiss={() => void refetch()} />
      )}

      {(state.kind === 'ready' || state.kind === 'loading_more') &&
        state.data.orders.length === 0 && (
          <div className="rounded-md border border-surface-divider bg-surface-inset p-6 text-center text-sm text-ink-secondary">
            No orders match the current filters.
          </div>
        )}

      {(state.kind === 'ready' || state.kind === 'loading_more') &&
        state.data.orders.length > 0 && (
          <>
            <p className="text-xs text-ink-secondary" aria-live="polite">
              Showing {state.data.orders.length.toString()} order
              {state.data.orders.length === 1 ? '' : 's'}
              {state.data.nextCursor !== null ? ' (more available)' : ''}.
            </p>
            <table className="w-full text-sm">
              <thead className="text-left text-ink-secondary">
                <tr>
                  <th className="py-2 pr-4 font-medium">Order</th>
                  <th className="py-2 pr-4 font-medium">Account</th>
                  <th className="py-2 pr-4 font-medium">Product</th>
                  <th className="py-2 pr-4 font-medium">Price</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Created</th>
                  <th className="py-2 pr-4 font-medium" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {state.data.orders.map((o) => (
                  <tr
                    key={o.order_id}
                    // a11y: keyboard-operable row (opens order detail); aria-pressed marks
                    // the selected one — a plain clickable <tr> was mouse-only (audit 2026-07-09).
                    role="button"
                    tabIndex={0}
                    aria-pressed={detailOrder?.order_id === o.order_id}
                    onClick={() => setDetailOrder(o)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setDetailOrder(o);
                      }
                    }}
                    className={`cursor-pointer border-t border-surface-divider hover:bg-surface-inset focus-visible:bg-surface-inset ${
                      detailOrder?.order_id === o.order_id ? 'bg-surface-inset' : ''
                    }`}
                  >
                    <td className="py-2 pr-4 font-mono text-xs">{o.order_id}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{o.account_id ?? '—'}</td>
                    <td className="py-2 pr-4">{o.product}</td>
                    <td className="py-2 pr-4">{formatCents(o.price_cents, o.price_currency)}</td>
                    <td className="py-2 pr-4">
                      <CryptoOrderStatusBadge status={o.status} size="sm" />
                    </td>
                    <td className="py-2 pr-4 text-ink-secondary">{formatRelative(o.created_at)}</td>
                    <td className="py-2 pr-4">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setNoteTarget(o);
                          setNoteInput(o.internal_note ?? '');
                        }}
                        className="rounded border border-surface-divider px-2 py-1 text-xs font-medium hover:bg-surface-inset"
                        aria-label={`Edit internal note for ${o.order_id}`}
                      >
                        {o.internal_note != null && o.internal_note.length > 0
                          ? 'Edit note'
                          : 'Add note'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

      {(state.kind === 'ready' || state.kind === 'loading_more') &&
        state.data.orders.length > 0 &&
        state.data.nextCursor !== null && (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={state.kind === 'loading_more'}
              className="rounded-md border border-surface-divider bg-surface-inset px-4 py-1.5 text-sm font-medium hover:bg-surface-base disabled:opacity-50"
            >
              {state.kind === 'loading_more' ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}

      {internalNote.state.kind === 'failed' && (
        <ErrorBanner message={internalNote.state.message} onDismiss={() => internalNote.reset()} />
      )}

      {csvExport.state.kind === 'failed' && (
        <ErrorBanner
          message={`CSV download failed: ${csvExport.state.message}`}
          onDismiss={() => csvExport.reset()}
        />
      )}

      {noteTarget !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Edit internal note"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="flex w-full max-w-md flex-col gap-4 rounded-md border border-surface-divider bg-surface-base p-6">
            <h3 className="text-base font-semibold">Internal note</h3>
            <p className="text-sm text-ink-secondary">
              Admin-only context for order{' '}
              <span className="font-mono text-xs">{noteTarget.order_id}</span>. This note is never
              shown to the customer. Leave empty + save to clear.
            </p>
            <label className="flex flex-col gap-1 text-sm">
              <span className="sr-only">Internal note</span>
              <textarea
                ref={noteTextareaRef}
                value={noteInput}
                onChange={(e) => setNoteInput(e.target.value)}
                rows={5}
                maxLength={2000}
                placeholder="VIP — manual outreach scheduled / fraud signal / etc."
                className="rounded border border-surface-divider bg-surface-inset p-2 text-sm"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setNoteTarget(null);
                  setNoteInput('');
                }}
                className="rounded border border-surface-divider px-3 py-1 text-sm hover:bg-surface-inset"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const next = noteInput.trim().length === 0 ? null : noteInput;
                  void internalNote.save(noteTarget.order_id, next);
                }}
                disabled={internalNote.state.kind === 'submitting'}
                className="rounded border border-surface-divider bg-surface-inset px-3 py-1 text-sm font-medium hover:bg-surface-base disabled:opacity-50"
              >
                {internalNote.state.kind === 'submitting' ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {detailOrder !== null && (
        <CryptoOrderAdminDetailDrawer
          order={detailOrder}
          onClose={() => setDetailOrder(null)}
          onEditNote={(o) => {
            setNoteTarget(o);
            setNoteInput(o.internal_note ?? '');
            setDetailOrder(null);
          }}
        />
      )}
    </div>
  );
}
