// V-534.AG — admin crypto-orders view.
// V-534.AK — adds inline refund-request action with confirmation modal.
// V-534.AL — adds inline internal-note editor (admin-only field, never
//            shown to the customer).
// V-534.AM — clicking an order row opens a detail drawer with the full
//            envelope; action buttons stop propagation so they don't
//            also open the drawer.
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

import { useEffect, useState } from 'react';
import { CryptoOrderAdminDetailDrawer } from '../components/CryptoOrderAdminDetailDrawer';
import { CryptoOrderStatusBadge } from '../components/CryptoOrderStatusBadge';
import { ErrorBanner } from '../components/ErrorBanner';
import { formatCents, formatRelative } from '../lib/crypto-format';
import {
  useAdminCryptoOrdersList,
  type AdminCryptoOrder,
} from '../lib/use-admin-crypto-orders-list';
import { useAdminInternalNote } from '../lib/use-admin-internal-note';
import { useAdminRequestRefund } from '../lib/use-admin-request-refund';

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
  const [refundTarget, setRefundTarget] = useState<AdminCryptoOrder | null>(null);
  const [reasonInput, setReasonInput] = useState<string>('');
  const [noteTarget, setNoteTarget] = useState<AdminCryptoOrder | null>(null);
  const [noteInput, setNoteInput] = useState<string>('');
  const [detailOrder, setDetailOrder] = useState<AdminCryptoOrder | null>(null);
  const { state, refetch } = useAdminCryptoOrdersList({
    status: status === '' ? null : status,
    search,
  });
  const refund = useAdminRequestRefund();
  const internalNote = useAdminInternalNote();

  useEffect(() => {
    if (refund.state.kind === 'succeeded') {
      void refetch().then(() => {
        refund.reset();
        setRefundTarget(null);
        setReasonInput('');
      });
    }
  }, [refund.state, refund, refetch]);

  useEffect(() => {
    if (internalNote.state.kind === 'succeeded') {
      void refetch().then(() => {
        internalNote.reset();
        setNoteTarget(null);
        setNoteInput('');
      });
    }
  }, [internalNote.state, internalNote, refetch]);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Crypto orders (admin)</h2>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={state.kind === 'loading'}
          className="rounded-md border border-surface-divider bg-surface-inset px-3 py-1 text-sm font-medium disabled:opacity-50"
        >
          {state.kind === 'loading' ? 'Loading…' : 'Refresh'}
        </button>
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
      </div>

      {state.kind === 'error' && (
        <ErrorBanner message={state.message} onDismiss={() => void refetch()} />
      )}

      {state.kind === 'ready' && state.data.orders.length === 0 && (
        <div className="rounded-md border border-surface-divider bg-surface-inset p-6 text-center text-sm text-ink-secondary">
          No orders match the current filters.
        </div>
      )}

      {state.kind === 'ready' && state.data.orders.length > 0 && (
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
            {state.data.orders.map((o) => {
              const refundOutstanding = o.refund_requested_at != null;
              const isPaid = o.status === 'paid';
              const isCancellingHere =
                refund.state.kind === 'submitting' && refund.state.orderId === o.order_id;
              return (
                <tr
                  key={o.order_id}
                  onClick={() => setDetailOrder(o)}
                  aria-selected={detailOrder?.order_id === o.order_id}
                  className={`cursor-pointer border-t border-surface-divider hover:bg-surface-inset ${
                    detailOrder?.order_id === o.order_id ? 'bg-surface-inset' : ''
                  }`}
                >
                  <td className="py-2 pr-4 font-mono text-xs">{o.order_id}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{o.account_id ?? '—'}</td>
                  <td className="py-2 pr-4">{o.product}</td>
                  <td className="py-2 pr-4">{formatCents(o.price_cents, o.price_currency)}</td>
                  <td className="py-2 pr-4">
                    <CryptoOrderStatusBadge status={o.status} size="sm" />
                    {refundOutstanding && (
                      <span
                        className="ml-1 inline-flex items-center rounded-full border border-status-warning/40 bg-status-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-status-warning"
                        title={o.refund_reason ?? ''}
                      >
                        Refund pending
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-ink-secondary">{formatRelative(o.created_at)}</td>
                  <td className="py-2 pr-4">
                    <div className="flex flex-wrap items-center gap-1">
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
                      {isPaid && !refundOutstanding && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRefundTarget(o);
                            setReasonInput('');
                          }}
                          className="rounded border border-surface-divider px-2 py-1 text-xs font-medium hover:bg-surface-inset"
                        >
                          Request refund
                        </button>
                      )}
                      {refundOutstanding && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void refund.cancel(o.order_id);
                          }}
                          disabled={isCancellingHere}
                          className="rounded border border-status-warning/40 px-2 py-1 text-xs font-medium text-status-warning hover:bg-status-warning/10 disabled:opacity-50"
                          aria-label={`Cancel refund request for ${o.order_id}`}
                        >
                          {isCancellingHere ? 'Clearing…' : 'Clear refund'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {refund.state.kind === 'failed' && (
        <ErrorBanner message={refund.state.message} onDismiss={() => refund.reset()} />
      )}

      {internalNote.state.kind === 'failed' && (
        <ErrorBanner message={internalNote.state.message} onDismiss={() => internalNote.reset()} />
      )}

      {refundTarget !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm refund request"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="flex w-full max-w-md flex-col gap-4 rounded-md border border-surface-divider bg-surface-base p-6">
            <h3 className="text-base font-semibold">Request refund</h3>
            <p className="text-sm text-ink-secondary">
              You're about to record a refund intent for{' '}
              <span className="font-mono text-xs">{refundTarget.order_id}</span>. This does not fire
              an on-chain refund — it marks the order as refund-requested so support can process it
              through the NowPayments dashboard.
            </p>
            <label className="flex flex-col gap-1 text-sm">
              Reason
              <textarea
                value={reasonInput}
                onChange={(e) => setReasonInput(e.target.value)}
                rows={3}
                maxLength={500}
                placeholder="Charged in error / duplicate payment / customer requested…"
                className="rounded border border-surface-divider bg-surface-inset p-2 text-sm"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setRefundTarget(null);
                  setReasonInput('');
                }}
                className="rounded border border-surface-divider px-3 py-1 text-sm hover:bg-surface-inset"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void refund.request(refundTarget.order_id, reasonInput);
                }}
                disabled={reasonInput.trim().length === 0 || refund.state.kind === 'submitting'}
                className="rounded border border-status-error/40 bg-status-error/10 px-3 py-1 text-sm font-medium text-status-error hover:bg-status-error/20 disabled:opacity-50"
              >
                {refund.state.kind === 'submitting' ? 'Submitting…' : 'Confirm refund'}
              </button>
            </div>
          </div>
        </div>
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
        <CryptoOrderAdminDetailDrawer order={detailOrder} onClose={() => setDetailOrder(null)} />
      )}
    </div>
  );
}
