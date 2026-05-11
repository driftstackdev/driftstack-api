// V-534.F — cost-panel formatter + threshold helpers for the gui-client.
//
// The customer-facing GUI doesn't expose admin cost endpoints, but
// the same shape will be reused for the customer "your spend this
// month" panel against /v1/account/cost (V-541.D follow-up). This
// module is pure presentation logic — formats centsand classifies
// threshold colours — so the React panel can stay declarative.

export type ThresholdTone = 'ok' | 'warn' | 'alert';

export interface CostBreakdownInput {
  computeCents: number;
  storageCents: number;
  egressCents: number;
  emailCents: number;
  llmCents: number;
  totalCents: number;
  thresholdState: 'under-soft' | 'between-soft-and-hard' | 'over-hard';
}

export interface FormattedCostBreakdown {
  rows: ReadonlyArray<{ label: string; formatted: string; cents: number }>;
  total: { formatted: string; cents: number };
  tone: ThresholdTone;
  toneCopy: string;
}

const COMPONENT_LABELS: Record<
  keyof Omit<CostBreakdownInput, 'totalCents' | 'thresholdState'>,
  string
> = {
  computeCents: 'Compute (session-minutes)',
  storageCents: 'Storage (R2 GB-months)',
  egressCents: 'Egress (TURN GB)',
  emailCents: 'Email (Postmark sends)',
  llmCents: 'LLM tokens',
};

/**
 * Format a cents integer as a localised currency string. `currency`
 * defaults to EUR (V-541 design decision); customer-facing variants
 * may pass 'USD'. We don't round — every cent is shown.
 */
export function formatCents(
  cents: number,
  currency: 'EUR' | 'USD' = 'EUR',
  locale = 'en-US',
): string {
  const value = cents / 100;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(value);
}

export function classifyTone(state: CostBreakdownInput['thresholdState']): ThresholdTone {
  switch (state) {
    case 'over-hard':
      return 'alert';
    case 'between-soft-and-hard':
      return 'warn';
    case 'under-soft':
      return 'ok';
  }
}

const TONE_COPY: Record<ThresholdTone, string> = {
  ok: 'On track for this billing cycle.',
  warn: 'Approaching the configured spend threshold for this account.',
  alert: 'Over the configured hard threshold. Investigate or raise the cap.',
};

export function formatCostBreakdown(
  input: CostBreakdownInput,
  opts: { currency?: 'EUR' | 'USD'; locale?: string } = {},
): FormattedCostBreakdown {
  const currency = opts.currency ?? 'EUR';
  const locale = opts.locale ?? 'en-US';
  const tone = classifyTone(input.thresholdState);
  return {
    rows: (['computeCents', 'storageCents', 'egressCents', 'emailCents', 'llmCents'] as const).map(
      (key) => ({
        label: COMPONENT_LABELS[key],
        formatted: formatCents(input[key], currency, locale),
        cents: input[key],
      }),
    ),
    total: {
      formatted: formatCents(input.totalCents, currency, locale),
      cents: input.totalCents,
    },
    tone,
    toneCopy: TONE_COPY[tone],
  };
}
