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
  const { events, connection, dismiss } = useNotifications();
  // Render the overlay only when there's something to show. The
  // 'closed' state surfaces only IF events are queued (the customer
  // saw something then we dropped — worth a hint). 'closed' with
  // zero events stays hidden so sign-out doesn't spam a banner.
  if (events.length === 0 && connection !== 'reconnecting') {
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
          className="pointer-events-auto rounded border border-amber-700/40 bg-amber-50/95 px-3 py-2 text-xs text-amber-900 shadow"
        >
          Notification stream reconnecting…
        </div>
      )}
      {connection === 'closed' && events.length > 0 && (
        <div
          data-testid="notification-connection-banner"
          className="pointer-events-auto rounded border border-rose-700/40 bg-rose-50/95 px-3 py-2 text-xs text-rose-900 shadow"
        >
          Notification stream closed — open Settings to reconnect.
        </div>
      )}
      {events.map((event, idx) => {
        const { title, body } = describe(event);
        return (
          <article
            key={`${event.kind}-${event.at}-${idx.toString()}`}
            data-testid="notification-toast"
            data-notification-kind={event.kind}
            className="pointer-events-auto rounded border border-glow-red/40 bg-surface-base/95 p-3 shadow-lg"
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
              {new Date(event.at).toLocaleTimeString()}
            </footer>
          </article>
        );
      })}
    </aside>
  );
}
