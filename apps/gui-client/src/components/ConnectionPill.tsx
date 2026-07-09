// 2026-05-20 — connection status pill for the TitleBar.
//
// Renders a colored dot + label that reflects the live state from
// useConnectionStatus. Tooltip on hover surfaces the underlying error
// (if offline) or the last-ok timestamp (if connected) so the customer
// can self-diagnose without opening Settings.
//
// Click target: opens Settings via deep-link-style navigation. The
// onClick callback is the parent's responsibility — the TitleBar wires
// it through to App.tsx's route hook.

import type { ConnectionStatus } from '../lib/use-connection-status';

const COLOR: Record<ConnectionStatus['state'], string> = {
  connecting: 'bg-status-busy',
  connected: 'bg-status-ready',
  offline: 'bg-status-error',
};

const LABEL: Record<ConnectionStatus['state'], string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  offline: 'Offline',
};

function formatLastOk(ms: number | null): string {
  if (ms === null) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds.toString()}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes.toString()}m ago`;
}

interface Props {
  status: ConnectionStatus;
  baseUrl: string;
  onClick?: () => void;
}

export function ConnectionPill({ status, baseUrl, onClick }: Props): JSX.Element {
  const tooltip =
    status.state === 'connected'
      ? `Last ok ${formatLastOk(status.lastOkAt)} · ${baseUrl}`
      : status.state === 'offline'
        ? `${status.lastError ?? 'Unknown error'} · ${baseUrl}`
        : `Probing ${baseUrl}…`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={tooltip}
      // The dot is aria-hidden and the detail lives only in the hover title,
      // so expose both the state and the diagnostic (last-ok / error) to
      // screen-reader + keyboard users who never see the tooltip.
      aria-label={`Connection: ${LABEL[status.state]}. ${tooltip}`}
      className="flex items-center gap-1.5 rounded-full border border-surface-divider bg-surface-base/60 px-2.5 py-0.5 text-[11px] text-ink-secondary transition hover:border-status-error/40 hover:text-ink-primary"
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${COLOR[status.state]} ${
          status.state === 'connecting' ? 'animate-pulse' : ''
        }`}
        aria-hidden="true"
      />
      <span>{LABEL[status.state]}</span>
    </button>
  );
}
