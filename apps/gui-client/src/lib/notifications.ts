// 2026-05-20 — GUI panel notification subscriber.
//
// Opens an EventSource against GET /v1/account/me/notifications
// (server-side route: apps/server/src/routes/account-notifications.ts,
// design doc: docs/internal/driftstack-telemetry-event-schema-for-
// gui-panel.md). Each SSE frame's `event:` header carries the
// discriminator (`cost.threshold_alert` / `incident.broadcast` /
// `audit.high_severity` / `session.errored`); the `data:` line is
// the JSON-encoded NotificationEvent matching the server union.
//
// Authentication note: native EventSource lacks header support, so
// this lib accepts an explicit `url` (caller-built). The server route
// authenticates via requireAuthEventSource, which reads the bearer
// from a `?ds_token=` query param (EventSource can't set an
// Authorization header). The call site builds that URL via
// notificationStreamUrl() (lib/notification-stream-url.ts).
//
// Reconnect: the browser-native EventSource auto-reconnects on
// transient drops (default 3s backoff). For a v0.2 follow-up we'll
// add bounded reconnect-with-jitter + a max-retries-then-fail signal
// once a customer concretely needs it; v0.1 piggybacks on the
// platform behavior so a Mac sleep/wake cycle resumes the stream
// without app-level glue.

export type NotificationEvent =
  | {
      kind: 'cost.threshold_alert';
      accountId: string;
      severity: 'warn' | 'critical' | 'resolved';
      billingCycle: string;
      previousState: 'under-soft' | 'between-soft-and-hard' | 'over-hard' | null;
      currentState: 'under-soft' | 'between-soft-and-hard' | 'over-hard';
      totalCents: number;
      thresholdSoftCents: number;
      thresholdHardCents: number;
      at: string;
    }
  | {
      kind: 'incident.broadcast';
      accountId: string;
      incidentId: string;
      severity: 'minor' | 'major' | 'outage';
      title: string;
      at: string;
    }
  | {
      kind: 'audit.high_severity';
      accountId: string;
      action: string;
      actorType: 'customer' | 'admin' | 'system';
      targetResourceId: string | null;
      at: string;
    }
  | {
      kind: 'session.errored';
      accountId: string;
      sessionId: string;
      errorClass: string;
      at: string;
    };

export type NotificationEventKind = NotificationEvent['kind'];

/** All v0 event kinds. Pinned so a refactor that widens the union
 *  on the server can be caught by the GUI side's content-parity test. */
export const NOTIFICATION_EVENT_KINDS: readonly NotificationEventKind[] = [
  'cost.threshold_alert',
  'incident.broadcast',
  'audit.high_severity',
  'session.errored',
] as const;

export interface SubscribeOpts {
  /** Fully-built SSE URL — auth threading is the caller's concern
   *  (see header doc). The lib only opens the connection + parses
   *  frames. */
  url: string;
  /** Per-event handler. */
  onEvent: (event: NotificationEvent) => void;
  /** Optional connection-state callback for the UI to surface
   *  reconnect / degraded banners. */
  onState?: (state: 'connecting' | 'open' | 'reconnecting' | 'closed') => void;
  /** Optional error handler. Default: silent. */
  onError?: (err: unknown) => void;
  /** EventSource constructor override for tests. */
  eventSourceFactory?: typeof EventSource;
}

/** Open an EventSource and dispatch parsed events. Returns a
 *  close handle the caller MUST invoke on unmount. */
export function subscribeNotifications(opts: SubscribeOpts): () => void {
  const Ctor =
    opts.eventSourceFactory ?? (typeof EventSource !== 'undefined' ? EventSource : undefined);
  if (Ctor === undefined) {
    // Non-browser / non-Tauri runtime — no SSE transport available.
    // Treat as already-closed so the caller's onState reflects it.
    opts.onState?.('closed');
    return () => undefined;
  }
  opts.onState?.('connecting');
  const es = new Ctor(opts.url);

  // Bounded reconnect — a server that's reachable at TCP level but keeps
  // 5xx-ing / dropping (proxy, expired token) makes native EventSource retry
  // FOREVER, so the banner reads "reconnecting…" permanently and never resolves
  // to the actionable "closed — open Settings" state. Count consecutive errors;
  // after the cap, give up: close the source and report 'closed' so the user
  // gets the Settings affordance. A successful 'open' resets the counter.
  const MAX_CONSECUTIVE_ERRORS = 6;
  let consecutiveErrors = 0;

  const handleOpen = (): void => {
    consecutiveErrors = 0;
    opts.onState?.('open');
  };
  const handleError = (err: Event): void => {
    // EventSource fires 'error' on transient disconnect AND on hard
    // close. readyState distinguishes: CONNECTING (0) → reconnect in
    // progress; CLOSED (2) → terminal.
    // readyState 2 === CLOSED per the WHATWG EventSource spec. We
    // compare against the literal (not `EventSource.CLOSED`) so the
    // module is safe to import in non-browser environments (tests,
    // SSR pre-render, etc.) where the global `EventSource` may be
    // undefined.
    if (es.readyState === 2) {
      opts.onState?.('closed');
    } else {
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        // Give up retrying — close the flapping source and surface the terminal
        // 'closed' state so the user gets the "open Settings" affordance instead
        // of a permanent "reconnecting…".
        es.close();
        opts.onState?.('closed');
      } else {
        opts.onState?.('reconnecting');
      }
    }
    opts.onError?.(err);
  };
  es.addEventListener('open', handleOpen);
  es.addEventListener('error', handleError);

  // Wire one listener per kind so the EventSource native event-name
  // routing fires the right handler. We re-dispatch through a single
  // typed callback so the consumer only writes one onEvent. Keep a
  // reference to each handler so cleanup can remove it symmetrically
  // with the open/error handlers above, rather than relying on GC of
  // the closed EventSource — this keeps the returned handle a complete
  // teardown per its contract.
  const kindHandlers: Array<[string, (raw: Event) => void]> = [];
  for (const kind of NOTIFICATION_EVENT_KINDS) {
    const handler = (raw: Event): void => {
      const evt = raw as MessageEvent<string>;
      try {
        const parsed = JSON.parse(evt.data) as NotificationEvent;
        if (parsed.kind === kind) {
          opts.onEvent(parsed);
        }
      } catch (err) {
        opts.onError?.(err);
      }
    };
    kindHandlers.push([kind, handler]);
    es.addEventListener(kind, handler);
  }

  return () => {
    es.removeEventListener('open', handleOpen);
    es.removeEventListener('error', handleError);
    for (const [kind, handler] of kindHandlers) {
      es.removeEventListener(kind, handler);
    }
    es.close();
    opts.onState?.('closed');
  };
}
