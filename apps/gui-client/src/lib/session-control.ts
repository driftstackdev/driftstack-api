// V-534.D — session control surface.
//
// Sits on top of V-534.C `subscribeSessionEvents` and provides the
// imperative actions a UI surface needs: destroy a session, force a
// refresh, swap polling cadence. Holds the latest snapshot internally
// so consumers don't have to wire their own state cache.
//
// Pure TypeScript (no React); the UI component layer wraps this in a
// hook. Keeping the controller plain TS makes it testable in vitest
// without a DOM.

import {
  bucketSessions,
  diffSessionSnapshots,
  subscribeSessionEvents,
  type SessionBuckets,
  type SessionEvent,
} from './session-events';
import type { Session } from './client';

export type ControllerListener = (state: ControllerState) => void;

export interface ControllerState {
  /** Latest snapshot from the server. */
  sessions: readonly Session[];
  /** Bucketed view for tabbed UIs. */
  buckets: SessionBuckets;
  /** Per-session in-flight destroy. UI uses this for spinner state. */
  destroying: ReadonlySet<string>;
  /** Most recent error from the polling loop or a destroy call. */
  lastError: { kind: 'fetch' | 'destroy'; sessionId?: string; error: unknown } | null;
  /** Most recent diff against the prior snapshot. */
  lastEvents: readonly SessionEvent[];
}

export interface SessionControllerDeps {
  /** Source of session snapshots; typically `() => client.sessions.list({}).then(p => p.data)`. */
  fetchSnapshot: () => Promise<readonly Session[]>;
  /** Imperative destroy; typically `(id) => client.sessions.destroy(id)`. */
  destroySession: (sessionId: string) => Promise<void>;
  /** Polling cadence (ms). Default 2000. */
  intervalMs?: number;
}

export interface SessionController {
  /** Subscribe to state changes; returns an unsubscribe fn. */
  subscribe(listener: ControllerListener): () => void;
  /** Current state snapshot. */
  getState(): ControllerState;
  /** Trigger a destroy. Optimistic — the controller marks the session
   *  as 'destroying' immediately, fires the API call, then waits for
   *  the next poll-tick to confirm the terminal status. */
  destroy(sessionId: string): Promise<void>;
  /** Force-poll the snapshot source. */
  refresh(): Promise<void>;
  /** Tear down the polling loop + listener set. */
  stop(): void;
}

const EMPTY_STATE: ControllerState = {
  sessions: [],
  buckets: { active: [], pending: [], terminated: [] },
  destroying: new Set(),
  lastError: null,
  lastEvents: [],
};

export function createSessionController(deps: SessionControllerDeps): SessionController {
  let state: ControllerState = EMPTY_STATE;
  const listeners = new Set<ControllerListener>();

  function publish(next: ControllerState): void {
    state = next;
    for (const l of listeners) l(state);
  }

  const unsubscribePoll = subscribeSessionEvents({
    fetchSnapshot: async () => {
      const next = await deps.fetchSnapshot();
      // Recompute buckets + clear destroying for any session that
      // landed in a terminal status.
      const buckets = bucketSessions(next);
      const stillDestroying = new Set<string>();
      const terminalIds = new Set(buckets.terminated.map((s) => s.id));
      for (const id of state.destroying) {
        if (!terminalIds.has(id) && next.some((s) => s.id === id)) {
          stillDestroying.add(id);
        }
      }
      const events = diffSessionSnapshots(state.sessions, next);
      publish({
        sessions: next,
        buckets,
        destroying: stillDestroying,
        lastError: state.lastError,
        lastEvents: events,
      });
      return next;
    },
    onEvents: () => {
      // Events are already reflected in publish() above; the callback
      // exists so subscribeSessionEvents doesn't drop them silently.
    },
    onError: (err) => {
      publish({ ...state, lastError: { kind: 'fetch', error: err } });
    },
    intervalMs: deps.intervalMs ?? 2000,
  });

  return {
    subscribe(listener) {
      listeners.add(listener);
      // Fire current state once so consumers can prime their UI.
      listener(state);
      return () => listeners.delete(listener);
    },
    getState() {
      return state;
    },
    async destroy(sessionId) {
      const optimistic = new Set(state.destroying);
      optimistic.add(sessionId);
      publish({ ...state, destroying: optimistic });
      try {
        await deps.destroySession(sessionId);
      } catch (err) {
        const remaining = new Set(state.destroying);
        remaining.delete(sessionId);
        publish({
          ...state,
          destroying: remaining,
          lastError: { kind: 'destroy', sessionId, error: err },
        });
        throw err;
      }
    },
    async refresh() {
      try {
        const next = await deps.fetchSnapshot();
        const buckets = bucketSessions(next);
        const events = diffSessionSnapshots(state.sessions, next);
        const terminalIds = new Set(buckets.terminated.map((s) => s.id));
        const stillDestroying = new Set<string>();
        for (const id of state.destroying) {
          if (!terminalIds.has(id) && next.some((s) => s.id === id)) {
            stillDestroying.add(id);
          }
        }
        publish({
          sessions: next,
          buckets,
          destroying: stillDestroying,
          lastError: state.lastError,
          lastEvents: events,
        });
      } catch (err) {
        publish({ ...state, lastError: { kind: 'fetch', error: err } });
      }
    },
    stop() {
      unsubscribePoll();
      listeners.clear();
    },
  };
}
