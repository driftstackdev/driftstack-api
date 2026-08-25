// 2026-05-20 — visible surface for the v0 NotificationEventBus.
//
// Mounts at the App.tsx shell level (above the view router so toasts
// overlay any view). Stacks the most-recent events from
// useNotifications() as oxblood-bordered cards in the top-right.
// Customer-action: click "Clear all" (header, shown when >1 queued) or a
// single card's "Dismiss" to clear the ring; click a card
// to navigate to the relevant surface (cost panel for cost.threshold_
// alert, etc. — wired in a v0.2 follow-up once nav targets settle).
//
// Distinct from <ErrorBanner /> (request-scoped errors mid-view) and
// the AgentSession transcript log (per-session activity feed) —
// notifications are panel-level, account-scoped, and meant to be
// glanceable. Connection state (reconnecting / closed) surfaces as a
// small text hint in the empty state, not a separate alert.

import type { UseNotificationsResult } from '../lib/use-notifications';
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

/** Visual tone for a toast, derived from kind + severity. Drives the card
 *  border/accent so a benign 'recovered' or low-severity event doesn't read as
 *  a red error like every other card. (audit #12) */
type ToastTone = 'error' | 'warn' | 'success' | 'neutral';

function toneOf(event: NotificationEvent): ToastTone {
  switch (event.kind) {
    case 'cost.threshold_alert':
      return event.severity === 'resolved'
        ? 'success'
        : event.severity === 'critical'
          ? 'error'
          : 'warn';
    case 'incident.broadcast':
      return event.severity === 'outage'
        ? 'error'
        : event.severity === 'major'
          ? 'warn'
          : 'neutral';
    case 'audit.high_severity':
      return 'neutral';
    case 'session.errored':
      return 'error';
  }
}

/** Static Tailwind class map for each tone — must be full literal class strings
 *  so the Tailwind JIT can see them (dynamically-built names never compile). */
const TONE_BORDER: Record<ToastTone, string> = {
  error: 'border-status-error/40',
  warn: 'border-status-busy/40',
  success: 'border-status-ready/40',
  neutral: 'border-status-idle/40',
};

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

/**
 * ⛔ V-1611 #18 — takes the feed as PROPS rather than calling
 * `useNotifications()` itself.
 *
 * That hook opens an SSE subscription on mount, so every component calling it
 * gets its OWN connection. Adding a notification bell that called it again
 * would have opened a second stream to the same account for the same events —
 * invisible in the UI and obvious in the server logs.
 *
 * One call site (App) now owns the subscription and passes it to both readers.
 * An optional prop with a hook fallback was the tempting alternative and is
 * worse: two code paths, one of which only tests ever take.
 *
 * The props type is the hook's own exported `UseNotificationsResult` — I added
 * a second name for it before grepping and removed that again; one shape should
 * not have two names.
 */
export function NotificationToastStack({
  events,
  connection,
  dismiss,
  reconnect,
}: UseNotificationsResult): JSX.Element | null {
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
      {events.length > 1 && (
        <div className="pointer-events-auto flex items-center justify-between px-1">
          <span className="text-[10px] font-medium uppercase tracking-wide text-ink-muted">
            {events.length} notifications
          </span>
          <button
            type="button"
            onClick={dismiss}
            className="text-xs text-ink-muted hover:text-ink-primary"
            aria-label="Clear all notifications"
          >
            Clear all
          </button>
        </div>
      )}
      {events.map((event, idx) => {
        const { title, body } = describe(event);
        const tone = toneOf(event);
        return (
          <article
            key={`${event.kind}-${event.at}-${idx.toString()}`}
            data-testid="notification-toast"
            data-notification-kind={event.kind}
            data-notification-tone={tone}
            className={`pointer-events-auto rounded border ${TONE_BORDER[tone]} bg-surface-base/95 p-3 shadow-lg`}
          >
            <header className="flex items-start justify-between gap-2">
              <h3 className="text-sm font-medium text-ink-primary">{title}</h3>
              {events.length === 1 && (
                <button
                  type="button"
                  onClick={dismiss}
                  className="text-xs text-ink-muted hover:text-ink-primary"
                  aria-label="Dismiss notification"
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
