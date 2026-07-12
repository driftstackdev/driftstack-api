// V-534.I — billing cost view.
//
// Wires the V-534.G CostPanel component to the V-534.H useAccountCost
// hook. Provides a billing-cycle picker (current month + last three
// months) and renders loading/error/ready states.

import { useMemo, useState } from 'react';
import { CostPanel } from '../components/CostPanel';
import { Skeleton, SkeletonRegion } from '../components/Skeleton';
import { useAccountCost } from '../lib/use-account-cost';

/**
 * Build the picker options: current YYYY-MM plus the three preceding
 * months. Pre-computed so the picker is deterministic — formatting
 * stays in the view, not the hook.
 */
function buildBillingCycleOptions(now: Date): string[] {
  const out: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const yyyy = d.getUTCFullYear().toString();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    out.push(`${yyyy}-${mm}`);
  }
  return out;
}

/**
 * Human-readable label for a YYYY-MM billing-cycle code — e.g.
 * '2026-07' → 'July 2026'. The <option> value stays the raw code
 * (the hook + server expect YYYY-MM); only the visible label changes.
 * Falls back to the raw code if it isn't a parseable YYYY-MM.
 */
function formatBillingCycleLabel(code: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(code);
  if (m === null) return code;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return code;
  const d = new Date(Date.UTC(year, month - 1, 1));
  return d.toLocaleString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export interface BillingCostViewProps {
  /** Test seam — defaults to `new Date()`. */
  nowFn?: () => Date;
}

export function BillingCostView(props: BillingCostViewProps = {}): JSX.Element {
  const now = props.nowFn ? props.nowFn() : new Date();
  const cycles = useMemo(() => buildBillingCycleOptions(now), [now]);
  const [selectedCycle, setSelectedCycle] = useState<string>(cycles[0] ?? '');
  const { state, refetch } = useAccountCost({ billingCycle: selectedCycle });

  return (
    <div className="flex h-full flex-col gap-4 p-6" aria-labelledby="billing-cost-heading">
      <header className="flex items-start justify-between gap-4">
        <div>
          <span className="section-label">Billing</span>
          <h2
            id="billing-cost-heading"
            className="mt-1 text-lg font-medium tracking-tight text-ink-primary"
          >
            Usage & cost
          </h2>
          <p className="mt-1 text-xs text-ink-muted">
            Metered usage and spend for the selected billing cycle.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="billing-cycle-picker" className="text-sm text-ink-secondary">
            Billing cycle
          </label>
          <select
            id="billing-cycle-picker"
            value={selectedCycle}
            onChange={(e) => setSelectedCycle(e.target.value)}
            className="rounded border border-surface-divider bg-surface-inset px-2 py-1 text-sm text-ink-primary"
          >
            {cycles.map((c) => (
              <option key={c} value={c}>
                {formatBillingCycleLabel(c)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void refetch()}
            disabled={state.kind === 'loading'}
          >
            {state.kind === 'loading' ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {state.kind === 'loading' && <CostPanelSkeleton />}
      {state.kind === 'idle' && (
        <p className="text-sm text-ink-secondary">Select a billing cycle to load the breakdown.</p>
      )}
      {state.kind === 'error' && (
        <div
          role="alert"
          className="rounded border border-status-error/60 bg-status-error/10 p-3 text-sm text-status-error"
        >
          Could not load cost data: {state.message}
        </div>
      )}
      {state.kind === 'ready' && (
        <CostPanel breakdown={state.data.breakdown} billingCycle={state.data.billing_cycle} />
      )}
    </div>
  );
}

/** First-load silhouette aligned with CostPanel's header, five rows, and total. */
function CostPanelSkeleton(): JSX.Element {
  const rows = [
    ['compute', 'w-44'],
    ['storage', 'w-40'],
    ['egress', 'w-32'],
    ['email', 'w-40'],
    ['llm', 'w-24'],
  ] as const;

  return (
    <SkeletonRegion label="Loading cost breakdown…">
      <section
        data-component="cost-panel-skeleton"
        className="rounded border border-surface-divider bg-surface-raised p-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-5 w-24" />
          </div>
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>

        <Skeleton className="mt-3 h-3 w-64 max-w-full" />

        <div className="mt-4 grid gap-x-4 gap-y-2">
          {rows.map(([key, width]) => (
            <div
              key={key}
              data-component="cost-panel-skeleton-row"
              className="flex items-center justify-between gap-3"
            >
              <Skeleton className={`h-3 max-w-[65%] ${width}`} />
              <Skeleton className="h-3 w-16" />
            </div>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between gap-3 border-t border-surface-divider pt-3">
          <Skeleton className="h-3.5 w-12" />
          <Skeleton className="h-4 w-20" />
        </div>
      </section>
    </SkeletonRegion>
  );
}
