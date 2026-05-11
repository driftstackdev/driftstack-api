// V-534.N — SessionStatusBadge presentational component.
//
// Mirrors V-534.M TierBadge for session statuses. Maps a session
// status to a label + tone so views (FleetView, LiveSessionView,
// SessionsHistoryView) can render a consistent chip without
// duplicating the mapping.

export type SessionStatus = 'creating' | 'ready' | 'busy' | 'destroyed' | 'errored';

export interface SessionStatusBadgeProps {
  /** Accepts any string for forward-compat with future statuses. */
  status: string;
  size?: 'sm' | 'md';
}

const STATUS_LABEL: Record<string, string> = {
  creating: 'Creating',
  ready: 'Ready',
  busy: 'Busy',
  destroyed: 'Destroyed',
  errored: 'Errored',
};

type Tone = 'neutral' | 'success' | 'busy' | 'warning' | 'error';

const STATUS_TONE: Record<string, Tone> = {
  creating: 'neutral',
  ready: 'success',
  busy: 'busy',
  destroyed: 'warning',
  errored: 'error',
};

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-surface-inset text-ink-secondary border-surface-divider',
  success: 'bg-status-success/15 text-status-success border-status-success/30',
  busy: 'bg-status-info/15 text-status-info border-status-info/30',
  warning: 'bg-status-warning/15 text-status-warning border-status-warning/30',
  error: 'bg-status-error/15 text-status-error border-status-error/30',
};

const SIZE_CLASSES: Record<NonNullable<SessionStatusBadgeProps['size']>, string> = {
  sm: 'px-1.5 py-0.5 text-xs',
  md: 'px-2 py-0.5 text-sm',
};

export function sessionStatusLabelFor(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

export function sessionStatusToneFor(status: string): Tone {
  return STATUS_TONE[status] ?? 'neutral';
}

export function SessionStatusBadge(props: SessionStatusBadgeProps): JSX.Element {
  const tone = sessionStatusToneFor(props.status);
  const size = props.size ?? 'md';
  const label = sessionStatusLabelFor(props.status);
  return (
    <span
      role="status"
      aria-label={`Session status: ${label}`}
      className={`inline-flex items-center gap-1 rounded-full border font-medium ${TONE_CLASSES[tone]} ${SIZE_CLASSES[size]}`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          tone === 'success'
            ? 'bg-status-success'
            : tone === 'busy'
              ? 'bg-status-info animate-pulse'
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
