// V-534.G — cost-panel React component. Renders the breakdown
// produced by `lib/cost-panel.ts::formatCostBreakdown`. Pure
// presentation; no data fetching here — caller supplies the
// pre-formatted breakdown.

import { formatCostBreakdown, type CostBreakdownInput } from '../lib/cost-panel';

export interface CostPanelProps {
  /** The raw breakdown from /v1/account/cost (V-541.D) or admin route. */
  breakdown: CostBreakdownInput;
  /** Billing cycle label, e.g. "2026-05". */
  billingCycle: string;
  /** Currency to format in. Default EUR. */
  currency?: 'EUR' | 'USD';
}

const TONE_BORDER: Record<'ok' | 'warn' | 'alert', string> = {
  ok: 'border-status-success/40',
  warn: 'border-status-warning/50',
  alert: 'border-status-error/60',
};

const TONE_CHIP_BG: Record<'ok' | 'warn' | 'alert', string> = {
  ok: 'bg-status-success/15 text-status-success',
  warn: 'bg-status-warning/15 text-status-warning',
  alert: 'bg-status-error/15 text-status-error',
};

const TONE_LABEL: Record<'ok' | 'warn' | 'alert', string> = {
  ok: 'On track',
  warn: 'Approaching limit',
  alert: 'Over hard limit',
};

export function CostPanel(props: CostPanelProps): JSX.Element {
  const formatted = formatCostBreakdown(props.breakdown, { currency: props.currency });
  return (
    <section
      className={`rounded border ${TONE_BORDER[formatted.tone]} bg-surface-raised p-4`}
      aria-label={`Cost breakdown for ${props.billingCycle}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="section-label text-ink-muted">Billing cycle</p>
          <h3 className="mt-0.5 text-base font-semibold text-ink-primary">{props.billingCycle}</h3>
        </div>
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CHIP_BG[formatted.tone]}`}
        >
          {TONE_LABEL[formatted.tone]}
        </span>
      </header>

      <p className="mt-3 text-xs text-ink-secondary">{formatted.toneCopy}</p>

      <dl className="mt-4 grid gap-x-4 gap-y-2 text-sm" role="list">
        {formatted.rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-secondary">{row.label}</dt>
            <dd className="font-mono text-ink-primary">{row.formatted}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-4 flex items-baseline justify-between gap-3 border-t border-surface-divider pt-3">
        <span className="text-sm font-medium text-ink-primary">Total</span>
        <span className="font-mono text-base font-semibold text-ink-primary">
          {formatted.total.formatted}
        </span>
      </div>
    </section>
  );
}
