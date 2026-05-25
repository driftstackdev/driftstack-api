// V-534.C — session-event detection layer.
//
// Sessions don't yet have a server-side SSE feed; that needs a control-
// plane slice to add a `/v1/sessions/stream` endpoint (sister-tooling
// to the existing /v1/status/stream). Until that lands, the GUI polls
// /v1/sessions and diffs against the previous snapshot. This
// module is the diff layer: caller hands in successive `Session[]`
// snapshots, gets back a typed event list describing what changed.
//
// The diff layer means UI surfaces (V-534.D control panel, V-534.E
// stream view) can subscribe to per-session change events instead of
// re-rendering the entire list every tick. Same shape as a real SSE
// consumer would have, so swapping to a real SSE source later is a
// drop-in replacement.

import type { Session } from './client';

export type SessionEventKind = 'added' | 'state-changed' | 'terminated' | 'removed';

export interface SessionEvent {
  kind: SessionEventKind;
  sessionId: string;
  /** The session row AS OF the snapshot that produced this event.
   *  For 'removed', this is the PRIOR snapshot's row (the session
   *  is no longer in the new snapshot). */
  session: Session;
  /** For 'state-changed': the prior status. Undefined for other kinds. */
  previousStatus?: Session['status'];
}

const TERMINAL_STATUSES: ReadonlyArray<Session['status']> = ['destroyed', 'errored'];

/**
 * Diff two session snapshots; returns the ordered event list describing
 * how the state evolved.
 *
 *   - 'added': session exists in `next` but not `prev`.
 *   - 'state-changed': session exists in both, status differs.
 *   - 'terminated': session moved to a terminal status in this tick.
 *     (Subset of state-changed; surfaced separately for ergonomics —
 *     UIs typically want a distinct hook for "session just ended".)
 *   - 'removed': session existed in `prev` but is missing from `next`.
 *     This happens when the server-side pagination evicted the row
 *     or the customer revoked access; rare in practice.
 *
 * Stable ordering: events are sorted by sessionId so the same input
 * produces the same output regardless of array ordering between calls.
 *
 * Pure function — caller owns snapshot storage.
 */
export function diffSessionSnapshots(
  prev: readonly Session[],
  next: readonly Session[],
): readonly SessionEvent[] {
  const prevById = new Map<string, Session>();
  for (const s of prev) prevById.set(s.id, s);
  const nextById = new Map<string, Session>();
  for (const s of next) nextById.set(s.id, s);

  const events: SessionEvent[] = [];

  for (const [id, session] of nextById) {
    const prior = prevById.get(id);
    if (prior === undefined) {
      events.push({ kind: 'added', sessionId: id, session });
    } else if (prior.status !== session.status) {
      const isTerminating =
        !TERMINAL_STATUSES.includes(prior.status) && TERMINAL_STATUSES.includes(session.status);
      events.push({
        kind: isTerminating ? 'terminated' : 'state-changed',
        sessionId: id,
        session,
        previousStatus: prior.status,
      });
    }
  }

  for (const [id, session] of prevById) {
    if (!nextById.has(id)) {
      events.push({ kind: 'removed', sessionId: id, session });
    }
  }

  events.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return events;
}

/**
 * Bucket a session list into status groups. Convenience for UIs that
 * want the "active / paused / terminated" tabs without re-iterating
 * per render.
 */
export interface SessionBuckets {
  /** Status === 'ready' or 'busy'. The session is running and the
   *  customer can interact with it. */
  active: readonly Session[];
  /** Status === 'creating'. Session is provisioning; not yet
   *  interactive. */
  pending: readonly Session[];
  /** Status === 'destroyed' or 'errored'. Terminal state. */
  terminated: readonly Session[];
}

export function bucketSessions(sessions: readonly Session[]): SessionBuckets {
  const active: Session[] = [];
  const pending: Session[] = [];
  const terminated: Session[] = [];
  for (const s of sessions) {
    if (TERMINAL_STATUSES.includes(s.status)) {
      terminated.push(s);
    } else if (s.status === 'creating') {
      pending.push(s);
    } else {
      active.push(s);
    }
  }
  return { active, pending, terminated };
}

/**
 * Subscribe to session events via a polling loop. Returns an
 * `unsubscribe` function that the caller invokes on unmount. The
 * polling source is injected (a function returning the latest
 * snapshot) so tests can drive deterministic snapshot sequences
 * without depending on a real client.
 *
 * Polling cadence is fixed at `intervalMs`; jitter is the caller's
 * responsibility if they need it. Errors from the snapshot source
 * are reported via `onError`; the loop continues running so a
 * transient failure doesn't kill the subscription.
 */
export interface SubscribeOpts {
  /** Source of session snapshots — typically a wrapper around
   *  `client.sessions.list()`. */
  fetchSnapshot: () => Promise<readonly Session[]>;
  /** Event callback. Receives the diff against the prior snapshot. */
  onEvents: (events: readonly SessionEvent[]) => void;
  /** Polling interval (ms). Default 2000. */
  intervalMs?: number;
  /** Error callback. Receives any thrown error from fetchSnapshot. */
  onError?: (error: unknown) => void;
}

export function subscribeSessionEvents(opts: SubscribeOpts): () => void {
  const interval = opts.intervalMs ?? 2000;
  let previousSnapshot: readonly Session[] = [];
  let stopped = false;
  let handle: ReturnType<typeof setTimeout> | null = null;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const next = await opts.fetchSnapshot();
      if (stopped) return;
      const events = diffSessionSnapshots(previousSnapshot, next);
      previousSnapshot = next;
      if (events.length > 0) opts.onEvents(events);
    } catch (err) {
      opts.onError?.(err);
    }
    if (!stopped) {
      handle = setTimeout(() => {
        void tick();
      }, interval);
    }
  }

  void tick();
  return () => {
    stopped = true;
    if (handle !== null) clearTimeout(handle);
  };
}
