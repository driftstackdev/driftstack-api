// V-534.I — billing cost view.
//
// Wires the V-534.G CostPanel component to the V-534.H useAccountCost
// hook. Provides a billing-cycle picker (current month + last three
// months) and renders loading/error/ready states.

import { useMemo, useState } from 'react';
import { CostPanel } from '../components/CostPanel';
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
    <section className="space-y-4 p-4" aria-labelledby="billing-cost-heading">
      <header className="flex items-center justify-between gap-3">
        <h2
          id="billing-cost-heading"
          className="text-lg font-semibold tracking-tight text-ink-primary"
        >
          Usage & cost
        </h2>
        <div className="flex items-center gap-2">
          <label htmlFor="billing-cycle-picker" className="text-sm text-ink-secondary">
            Billing cycle
          </label>
          <select
            id="billing-cycle-picker"
            value={selectedCycle}
            onChange={(e) => setSelectedCycle(e.target.value)}
            className="rounded border border-surface-divider bg-surface-input px-2 py-1 text-sm text-ink-primary"
          >
            {cycles.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void refetch()}
            className="rounded border border-surface-divider px-2 py-1 text-sm text-ink-primary hover:bg-surface-hover"
          >
            Refresh
          </button>
        </div>
      </header>

      {state.kind === 'loading' && (
        <p className="text-sm text-ink-secondary" role="status">
          Loading cost breakdown…
        </p>
      )}
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
    </section>
  );
}
