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
// this lib accepts an explicit `url` (caller-built; any auth scheme
// the runtime supports — Tauri's invoke-fetch bridge for the GUI;
// `event-source-polyfill` for plain web). The route on the server
// uses the standard requireAuth Bearer-header preHandler; the GUI
// glue to thread the apiKey into the EventSource handshake lives at
// the call site, not in this lib. v0.2 will pick one bridge once
// the GUI's actual integration shape is concrete.
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

  const handleOpen = (): void => {
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
      opts.onState?.('reconnecting');
    }
    opts.onError?.(err);
  };
  es.addEventListener('open', handleOpen);
  es.addEventListener('error', handleError);

  // Wire one listener per kind so the EventSource native event-name
  // routing fires the right handler. We re-dispatch through a single
  // typed callback so the consumer only writes one onEvent.
  for (const kind of NOTIFICATION_EVENT_KINDS) {
    es.addEventListener(kind, (raw) => {
      const evt = raw as MessageEvent<string>;
      try {
        const parsed = JSON.parse(evt.data) as NotificationEvent;
        if (parsed.kind === kind) {
          opts.onEvent(parsed);
        }
      } catch (err) {
        opts.onError?.(err);
      }
    });
  }

  return () => {
    es.removeEventListener('open', handleOpen);
    es.removeEventListener('error', handleError);
    es.close();
    opts.onState?.('closed');
  };
}
