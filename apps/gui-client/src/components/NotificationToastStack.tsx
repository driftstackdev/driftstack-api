// 2026-05-20 — visible surface for the v0 NotificationEventBus.
//
// Mounts at the App.tsx shell level (above the view router so toasts
// overlay any view). Stacks the most-recent events from
// useNotifications() as oxblood-bordered cards in the top-right.
// Customer-action: click "Dismiss" to clear the ring; click a card
// to navigate to the relevant surface (cost panel for cost.threshold_
// alert, etc. — wired in a v0.2 follow-up once nav targets settle).
//
// Distinct from <ErrorBanner /> (request-scoped errors mid-view) and
// the AgentSession transcript log (per-session activity feed) —
// notifications are panel-level, account-scoped, and meant to be
// glanceable. Connection state (reconnecting / closed) surfaces as a
// small text hint in the empty state, not a separate alert.

import { useNotifications } from '../lib/use-notifications';
import type { NotificationEvent } from '../lib/notifications';

function formatTotalCents(cents: number): string {
  const dollars = cents / 100;
  return dollars.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

/** Format the toast timestamp, guarding a malformed `at` so the footer shows ''
 *  instead of a literal "Invalid Date". (audit) */
function formatToastTime(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

function describe(event: NotificationEvent): { title: string; body: string } {
  switch (event.kind) {
    case 'cost.threshold_alert': {
      const total = formatTotalCents(event.totalCents);
      const hard = formatTotalCents(event.thresholdHardCents);
      const soft = formatTotalCents(event.thresholdSoftCents);
      const sev =
        event.severity === 'resolved'
          ? 'recovered'
          : event.severity === 'critical'
            ? 'critical'
            : 'warn';
      const title = `Cost ${sev}: ${total} / ${hard}`;
      const body =
        event.severity === 'resolved'
          ? `Spend dropped back below ${soft} for billing cycle ${event.billingCycle}.`
          : `Billing cycle ${event.billingCycle} crossed the ${event.currentState} threshold.`;
      return { title, body };
    }
    case 'incident.broadcast':
      return {
        title: `Incident: ${event.title}`,
        body: `Severity ${event.severity} — incident ${event.incidentId}.`,
      };
    case 'audit.high_severity':
      return {
        title: `Account event: ${event.action}`,
        body: `Actor ${event.actorType}${event.targetResourceId !== null ? ` · target ${event.targetResourceId}` : ''}.`,
      };
    case 'session.errored':
      return {
        title: 'Session error',
        body: `Session ${event.sessionId} hit ${event.errorClass}.`,
      };
  }
}

export function NotificationToastStack(): JSX.Element | null {
  const { events, connection, dismiss, reconnect } = useNotifications();
  // Render the overlay when there's something to show OR the stream needs
  // attention. 'closed' now surfaces even with zero queued events: the
  // subscriber latches 'closed' only after it actively gave up retrying (the
  // bounded-error give-up), which is a real degraded state the customer should
  // see and be able to fix — NOT the silent sign-out case ('idle'). So a
  // closed stream is always visible with a working Reconnect button, instead
  // of dying silently whenever the event ring happens to be empty.
  if (events.length === 0 && connection !== 'reconnecting' && connection !== 'closed') {
    return null;
  }
  return (
    <aside
      data-testid="notification-toast-stack"
      className="pointer-events-none fixed right-4 top-16 z-50 flex w-80 flex-col gap-2"
      aria-live="polite"
      aria-label="Notifications"
    >
      {connection === 'reconnecting' && (
        <div
          data-testid="notification-connection-banner"
          className="pointer-events-auto rounded border border-status-busy/40 bg-status-busy/10 px-3 py-2 text-xs text-status-busy shadow"
        >
          Notification stream reconnecting…
        </div>
      )}
      {connection === 'closed' && (
        <div
          data-testid="notification-connection-banner"
          className="pointer-events-auto flex items-center justify-between gap-2 rounded border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-status-error shadow"
        >
          <span>Notification stream disconnected.</span>
          <button
            type="button"
            onClick={reconnect}
            data-testid="notification-reconnect"
            className="shrink-0 rounded border border-status-error/40 px-2 py-0.5 font-medium hover:bg-status-error/15"
          >
            Reconnect
          </button>
        </div>
      )}
      {events.map((event, idx) => {
        const { title, body } = describe(event);
        return (
          <article
            key={`${event.kind}-${event.at}-${idx.toString()}`}
            data-testid="notification-toast"
            data-notification-kind={event.kind}
            className="pointer-events-auto rounded border border-status-error/40 bg-surface-base/95 p-3 shadow-lg"
          >
            <header className="flex items-start justify-between gap-2">
              <h3 className="text-sm font-medium text-ink-primary">{title}</h3>
              {idx === 0 && (
                <button
                  type="button"
                  onClick={dismiss}
                  className="text-xs text-ink-muted hover:text-ink-primary"
                  aria-label="Dismiss all notifications"
                >
                  Dismiss
                </button>
              )}
            </header>
            <p className="mt-1 text-xs text-ink-secondary">{body}</p>
            <footer className="mt-1 font-mono text-[10px] text-ink-muted">
              {formatToastTime(event.at)}
            </footer>
          </article>
        );
      })}
    </aside>
  );
}
