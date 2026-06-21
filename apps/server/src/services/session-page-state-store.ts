// In-memory latest-pageState-per-AGENT-session store (W650 / A3 W1254).
//
// The harness emits HarnessOutbound.pageState keyed by the AGENT session id
// (== the sessionAssign.sessionId we dispatch — A3 W1254 verified there is NO
// driver `ses_` id on the wire) on every agent-initiated navigate
// (loading → loaded | errored). The fleet-control-registry's onPageState
// consumer writes the latest here; GET /v1/agent-sessions/:id/page-state reads
// it so the GUI loading-bar / error-overlay (W615/W616) can poll the AGENT
// session it's driving (the existing GET /v1/sessions/:id/state.page_state is a
// DIFFERENT — driver — session type the harness never emits pageState for).
//
// Bounded (oldest-evicted) so dead sessions can't grow it unbounded: pageState
// is live + ephemeral (re-emitted on the next navigate), so dropping a stale
// entry is safe — at worst the overlay shows nothing until the next navigate.

import type { PageStateFrame } from '../schemas/harness-control-protocol.js';

/** The customer-facing slice of a pageState frame (drop the wire-routing
 *  `type`/`sessionId`; keep what the overlay renders). */
export interface SessionPageState {
  state: PageStateFrame['state'];
  url: string | null;
  error: PageStateFrame['error'];
}

export class SessionPageStateStore {
  private readonly map = new Map<string, SessionPageState>();

  constructor(private readonly maxEntries = 5_000) {}

  /** Record the latest pageState for an agent session. */
  set(frame: PageStateFrame): void {
    // delete+set moves the key to newest in the Map's insertion order, so the
    // size-cap eviction below drops the genuinely-stalest session.
    this.map.delete(frame.sessionId);
    // url/error are OMITTED on some frames (reload omits url; non-error states omit
    // error) → normalize the absent key to null for a stable customer-facing shape.
    this.map.set(frame.sessionId, {
      state: frame.state,
      url: frame.url ?? null,
      error: frame.error ?? null,
    });
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  /** Latest pageState for an agent session, or null if none reported yet. */
  get(sessionId: string): SessionPageState | null {
    return this.map.get(sessionId) ?? null;
  }

  /** Drop a session's entry (e.g. on session end). */
  delete(sessionId: string): void {
    this.map.delete(sessionId);
  }

  /** Active entry count — for tests + size assertions. */
  get size(): number {
    return this.map.size;
  }
}
