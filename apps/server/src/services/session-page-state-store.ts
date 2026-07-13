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
//
// Audit 2026-07-01 (MEDIUM) — the LRU cap above bounds MEMORY, but not
// CORRECTNESS: a session that ends via a path OTHER than the customer DELETE
// (crash / worker-disconnect grace / the 12h orphan backstop) never gets a
// corrective final pageState frame, so its LAST reported state — which could
// be 'stalled', the exact frozen-renderer signal this feature exists to
// detect — would otherwise be served by GET /:id/page-state indefinitely (or
// until LRU pushout, which at maxEntries=5000 could be a long time). Two
// independent backstops close this:
//   1. Precise eviction threaded into every termination path that has a
//      cheap, known session id at hand (session-page-state-store.delete(),
//      called from the DELETE route AND agent-session-terminal-close.ts).
//   2. An age bound (`getFresh`, below) so a still-cached entry can never
//      outlive the harness that reported it by more than `maxAgeMs` — this is
//      the one that also covers the two BULK closers (worker-disconnect-
//      reaper.ts / agent-session-orphan-sweeper.ts), which close sessions by
//      nodeId / wall-clock cutoff and only get back a row COUNT from the repo
//      (closeActiveByNode / reapOrphanedActiveBefore), never the affected
//      session ids — so they cannot cheaply call delete(sessionId) themselves
//      without a repo API change (out of scope here; see the comments in
//      those two files). GET /:id/page-state (routes/agent-sessions.ts) is
//      the actual authoritative backstop for THOSE two paths — AND for the
//      narrower async race described in session-page-state-relay.ts (a
//      pageState frame in flight during a close can resolve its owning-node
//      lookup and land — repopulating the store — after delete() already
//      ran): it cross-checks the session's live `status` (every closer, bulk
//      or not, already flips the SAME column, synchronously, before this
//      store could possibly be repopulated) before ever consulting this
//      store, so a dead session never reaches `getFresh` regardless of a
//      same-instant repopulation (which would get a FRESH `receivedAt` and so
//      would NOT be caught by the age bound alone). `getFresh`'s age bound is
//      instead independent defense-in-depth: it bounds a still-'active'/
//      'paused' session's cached entry so it can't go stale for some OTHER
//      reason (a dropped final frame, a future closer that forgets to flip
//      `status` promptly, …) without needing the store to know why.

import type { PageStateFrame } from '../schemas/harness-control-protocol.js';
import { customerSafeNodeDiagnostic } from './scrub-node-diagnostics.js';

/** The customer-facing slice of a pageState frame (drop the wire-routing
 *  `type`/`sessionId`; keep what the overlay renders). */
export interface SessionPageState {
  state: PageStateFrame['state'];
  url: string | null;
  // The page title as the box last reported it; lets the GUI address bar
  // self-heal the title from a title-only change frame (the box may emit `title`
  // on ANY state, not just 'loaded'). null when no frame has carried one yet.
  title: string | null;
  // Forward-compat: the tab this frame is attributed to (A3 contract pending —
  // see harness-control-protocol PageStateFrameSchema). Carried through so the
  // GUI can eventually key live state per tab; null until the box sends it. The
  // store stays a per-session record for now (no per-tab Map restructure yet).
  tabId: string | null;
  error: PageStateFrame['error'];
}

/** Internal record shape — the customer-facing slice plus the wall-clock time
 *  it was received, so `getFresh` can bound how long an entry may outlive the
 *  harness that reported it. `receivedAt` is intentionally NOT part of
 *  {@link SessionPageState} (the wire/customer-facing shape) — it is stripped
 *  before returning from either read method. */
interface StoredSessionPageState extends SessionPageState {
  receivedAt: number;
}

const DEFAULT_MAX_AGE_SECONDS = 120;

/**
 * Read the pageState max-age (in seconds) from the environment, falling back
 * to a 120s default (mirroring the worker-disconnect grace window — a value
 * already established in this codebase as a reasonable staleness bound for an
 * agent session's live control-plane signal). A non-finite / non-positive
 * value falls back too, so a fat-fingered env var can never disable the bound
 * (which would let a dead session's cached entry read as live forever).
 */
export function resolvePageStateMaxAgeSeconds(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.DRIFTSTACK_AGENT_SESSION_PAGE_STATE_MAX_AGE_SECONDS;
  if (raw === undefined) return DEFAULT_MAX_AGE_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_AGE_SECONDS;
  return parsed;
}

export class SessionPageStateStore {
  private readonly map = new Map<string, StoredSessionPageState>();

  constructor(
    private readonly maxEntries = 5_000,
    /** Clock seam (ms epoch) — overridden in tests for deterministic age math. */
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** Record the latest pageState for an agent session. */
  set(frame: PageStateFrame): void {
    // delete+set moves the key to newest in the Map's insertion order, so the
    // size-cap eviction below drops the genuinely-stalest session.
    this.map.delete(frame.sessionId);
    // url/title/tabId/error are OMITTED on some frames (reload omits url; non-error
    // states omit error; title/tabId only when the box sends them) → normalize the
    // absent key to null for a stable customer-facing shape.
    this.map.set(frame.sessionId, {
      state: frame.state,
      url: frame.url ?? null,
      title: frame.title ?? null,
      tabId: frame.tabId ?? null,
      error:
        frame.error === undefined || frame.error === null
          ? null
          : {
              ...frame.error,
              message: customerSafeNodeDiagnostic(frame.error.message),
            },
      receivedAt: this.clock(),
    });
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  /** Latest pageState for an agent session, or null if none reported yet.
   *  UNBOUNDED by age — callers that care whether the cached entry might have
   *  outlived a now-dead session should use {@link getFresh} instead (this is
   *  kept as-is for existing callers/tests that intentionally read the raw
   *  latest value regardless of age). */
  get(sessionId: string): SessionPageState | null {
    const entry = this.map.get(sessionId);
    return entry === undefined ? null : stripReceivedAt(entry);
  }

  /**
   * Age-bounded read: like {@link get}, but an entry received more than
   * `maxAgeMs` ago is treated as stale — evicted from the map and returned as
   * null — rather than served forever. See the module header (audit
   * 2026-07-01) for why this exists: a session that ends via a path that
   * never emits a corrective final frame would otherwise leave its last
   * (possibly 'stalled') state cached indefinitely.
   */
  getFresh(sessionId: string, maxAgeMs: number): SessionPageState | null {
    const entry = this.map.get(sessionId);
    if (entry === undefined) return null;
    if (this.clock() - entry.receivedAt > maxAgeMs) {
      this.map.delete(sessionId);
      return null;
    }
    return stripReceivedAt(entry);
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

function stripReceivedAt(entry: StoredSessionPageState): SessionPageState {
  const { receivedAt: _receivedAt, ...rest } = entry;
  return rest;
}
