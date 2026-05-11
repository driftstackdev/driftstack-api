// V-534.AH — admin daily-breakdown view for crypto orders.
//
// Companion to V-534.AG admin list. Renders the (date, status, count)
// rows returned by /v1/admin/crypto-orders/daily as a pivoted table
// (rows = dates, columns = statuses). Days with no orders are
// omitted by the server; we keep that posture client-side and skip
// the zero-fill — caller can widen `days` if they want a denser view.

import { useMemo, useState } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
import {
  useAdminCryptoDaily,
  type AdminDailyRow,
  type AdminDailyStatus,
} from '../lib/use-admin-crypto-daily';

const STATUS_COLUMNS: AdminDailyStatus[] = [
  'pending',
  'confirming',
  'paid',
  'failed',
  'partial',
  'cancelled',
];

const DAYS_OPTIONS = [7, 14, 30, 60, 90];

interface PivotRow {
  date: string;
  counts: Record<AdminDailyStatus, number>;
  total: number;
}

function pivot(rows: AdminDailyRow[]): PivotRow[] {
  const byDate = new Map<string, PivotRow>();
  for (const r of rows) {
    let row = byDate.get(r.date);
    if (!row) {
      row = {
        date: r.date,
        counts: {
          pending: 0,
          confirming: 0,
          paid: 0,
          failed: 0,
          partial: 0,
          cancelled: 0,
        },
        total: 0,
      };
      byDate.set(r.date, row);
    }
    row.counts[r.status] += r.count;
    row.total += r.count;
  }
  // Newest day first.
  return Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function CryptoOrdersDailyBreakdownView(): JSX.Element {
  const [days, setDays] = useState<number>(7);
  const { state, refetch } = useAdminCryptoDaily({ days });
  const pivoted = useMemo(() => (state.kind === 'ready' ? pivot(state.data.rows) : []), [state]);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Crypto orders — daily breakdown</h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            Days
            <select
              value={days}
              onChange={(e) => setDays(Number.parseInt(e.target.value, 10))}
              className="rounded border border-surface-divider bg-surface-base px-2 py-1 text-sm"
            >
              {DAYS_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
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

      {state.kind === 'error' && (
        <ErrorBanner message={state.message} onDismiss={() => void refetch()} />
      )}

      {state.kind === 'ready' && state.data.truncated && (
        <p className="text-xs text-status-warning">
          Window was truncated server-side. Some older days may be missing — widen the analytics
          pipeline if this becomes routine.
        </p>
      )}

      {state.kind === 'ready' && pivoted.length === 0 && (
        <div className="rounded-md border border-surface-divider bg-surface-inset p-6 text-center text-sm text-ink-secondary">
          No orders in the selected window.
        </div>
      )}

      {state.kind === 'ready' && pivoted.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-left text-ink-secondary">
            <tr>
              <th className="py-2 pr-4 font-medium">Date</th>
              {STATUS_COLUMNS.map((s) => (
                <th key={s} className="py-2 pr-4 font-medium capitalize">
                  {s}
                </th>
              ))}
              <th className="py-2 pr-4 font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {pivoted.map((row) => (
              <tr key={row.date} className="border-t border-surface-divider">
                <td className="py-2 pr-4 font-mono text-xs">{row.date}</td>
                {STATUS_COLUMNS.map((s) => (
                  <td key={s} className="py-2 pr-4 text-ink-secondary">
                    {row.counts[s] === 0 ? '—' : row.counts[s]}
                  </td>
                ))}
                <td className="py-2 pr-4 font-semibold">{row.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
