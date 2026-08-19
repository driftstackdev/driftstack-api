// V-534.U — CryptoOrderStatusBadge presentational component.
//
// Maps a crypto-order status to a label + tone for the checkout-confirmation
// view. All six statuses in CryptoOrderStatusSchema are covered.
//
// V-1056 — this header used to list five, omitting 'cancelled', while the
// STATUS_LABEL and STATUS_TONE maps below have always carried it. The union
// below was five values for the same reason. Nothing imported the union, so the
// divergence from the canonical six-value schema was invisible.

export type CryptoOrderStatus =
  | 'pending'
  | 'confirming'
  | 'paid'
  | 'failed'
  | 'partial'
  | 'cancelled';

export interface CryptoOrderStatusBadgeProps {
  status: string;
  size?: 'sm' | 'md';
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Awaiting payment',
  confirming: 'Confirming on-chain',
  paid: 'Paid',
  failed: 'Failed',
  partial: 'Partial — contact support',
  cancelled: 'Cancelled',
};

type Tone = 'neutral' | 'success' | 'busy' | 'warning' | 'error';

const STATUS_TONE: Record<string, Tone> = {
  pending: 'neutral',
  confirming: 'busy',
  paid: 'success',
  failed: 'error',
  partial: 'warning',
  cancelled: 'neutral',
};

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-surface-inset text-ink-secondary border-surface-divider',
  success: 'bg-status-success/15 text-status-success border-status-success/30',
  busy: 'bg-status-busy/15 text-status-busy border-status-busy/30',
  warning: 'bg-status-warning/15 text-status-warning border-status-warning/30',
  error: 'bg-status-error/15 text-status-error border-status-error/30',
};

const SIZE_CLASSES: Record<NonNullable<CryptoOrderStatusBadgeProps['size']>, string> = {
  sm: 'px-1.5 py-0.5 text-xs',
  md: 'px-2 py-0.5 text-sm',
};

export function cryptoOrderStatusLabelFor(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

export function cryptoOrderStatusToneFor(status: string): Tone {
  return STATUS_TONE[status] ?? 'neutral';
}

/**
 * Terminal means the order cannot move again.
 *
 * V-1056 — this returned true for 'paid' and 'failed' only, which contradicts
 * the rule the server enforces: isTerminalForward in services/crypto-orders.ts
 * refuses to move an order out of 'paid', 'failed' OR 'cancelled', so that a
 * late-arriving IPN payment cannot revive an abandoned order. Two other places
 * already agreed with the server and not with this helper —
 * lib/use-crypto-order.ts and the dashboard's select-tier page both build
 * {paid, failed, cancelled} by hand.
 *
 * The pin that froze the two-value form justified it as the set the polling
 * hook stops on. That was not so: the hook has never imported this helper, and
 * its own set is the three-value one plus 'partial'.
 *
 * 'partial' is deliberately NOT terminal here. The server treats it as
 * semi-terminal — 'paid' and 'failed' still override it — so an order sitting
 * at 'partial' can still move. The polling hook stops on it anyway, because a
 * partial payment needs the customer to act, and that is a separate question
 * from whether the status is final.
 */
export function isTerminalCryptoOrderStatus(status: string): boolean {
  return status === 'paid' || status === 'failed' || status === 'cancelled';
}

export function CryptoOrderStatusBadge(props: CryptoOrderStatusBadgeProps): JSX.Element {
  const tone = cryptoOrderStatusToneFor(props.status);
  const size = props.size ?? 'md';
  const label = cryptoOrderStatusLabelFor(props.status);
  return (
    <span
      role="status"
      aria-label={`Crypto order status: ${label}`}
      className={`inline-flex items-center gap-1 rounded-full border font-medium ${TONE_CLASSES[tone]} ${SIZE_CLASSES[size]}`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          tone === 'success'
            ? 'bg-status-success'
            : tone === 'busy'
              ? 'bg-status-busy animate-pulse'
              : tone === 'warning'
                ? 'bg-status-warning'
                : tone === 'error'
                  ? 'bg-status-error'
                  : 'bg-ink-muted'
        }`}
      />
      {label}
    </span>
  );
}
