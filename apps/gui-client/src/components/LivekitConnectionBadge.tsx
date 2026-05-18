// LK.6.c — connection-state badge for the AgentSessionPanel chrome.
//
// Consumes a LivekitConnectionState (the same value the panel emits
// via onStateChange) and renders a colored pill + status label.
// Sized to sit above the video element without competing for
// real estate.
//
// Auto-reconnect: livekit-client handles transient drops itself
// (RoomEvent.Reconnecting / .Reconnected fire automatically; the
// panel's effect tracks both). When a customer-side reconnect is
// needed (e.g. the WS reaches its hard timeout), the parent view
// can remount the panel.

import type { LivekitConnectionState } from '../lib/livekit';

export interface LivekitConnectionBadgeProps {
  state: LivekitConnectionState;
  /** Optional click handler for the manual reconnect affordance.
   *  Only invoked when state.kind === 'disconnected' OR 'error'. */
  onReconnect?: () => void;
}

interface BadgeShape {
  label: string;
  /** Background + text Tailwind classes. */
  className: string;
  /** Whether the spinner-dot pulse animation applies. */
  pulse: boolean;
}

function shapeFor(state: LivekitConnectionState): BadgeShape {
  switch (state.kind) {
    case 'idle':
      return { label: 'Idle', className: 'bg-white/10 text-ink-secondary', pulse: false };
    case 'connecting':
      return {
        label: 'Connecting…',
        className: 'bg-amber-500/20 text-amber-300',
        pulse: true,
      };
    case 'connected':
      return {
        label: 'Live',
        className: 'bg-emerald-500/20 text-emerald-300',
        pulse: false,
      };
    case 'reconnecting':
      return {
        label: 'Reconnecting…',
        className: 'bg-amber-500/20 text-amber-300',
        pulse: true,
      };
    case 'disconnected':
      return {
        label: 'Disconnected',
        className: 'bg-white/10 text-ink-secondary',
        pulse: false,
      };
    case 'error':
      return { label: 'Error', className: 'bg-rose-500/20 text-rose-300', pulse: false };
  }
}

export function LivekitConnectionBadge({
  state,
  onReconnect,
}: LivekitConnectionBadgeProps): JSX.Element {
  const shape = shapeFor(state);
  const reconnectable = state.kind === 'disconnected' || state.kind === 'error';
  return (
    <div
      data-component="livekit-connection-badge"
      className="flex items-center gap-2"
      role="status"
      aria-live="polite"
    >
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${shape.className}`}
        data-state={state.kind}
      >
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full bg-current ${
            shape.pulse ? 'animate-pulse' : ''
          }`}
          aria-hidden="true"
        />
        {shape.label}
      </span>
      {state.kind === 'error' && (
        <span className="text-xs text-ink-muted" data-field="error-message">
          {state.message}
        </span>
      )}
      {reconnectable && onReconnect !== undefined && (
        <button
          type="button"
          onClick={onReconnect}
          className="rounded-md border border-white/15 px-2.5 py-1 text-xs font-medium text-ink-primary hover:bg-white/5"
          data-action="reconnect"
        >
          Reconnect
        </button>
      )}
    </div>
  );
}
