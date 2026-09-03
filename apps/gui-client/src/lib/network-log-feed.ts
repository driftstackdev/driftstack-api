// Network drawer pane (T-9 GUI half) — the poll → store → subscribe plumbing plus
// the protocol closed-set validation for the simulator's devtools-style Network
// panel. Mirrors the Cookies feed shape (lib/agent-session-control cookie poll +
// CookiesListSubscriber store), but lives in its OWN isolated module on purpose:
//
//   N-1 rule — SimulatorWindow's ~17 unit suites hand-list vi.mock factories for
//   the modules SimulatorWindow imports. Any NEW export added to one of those
//   widely-mocked modules (e.g. agent-session-control) is `undefined` under every
//   one of those factories. So the request fetch does NOT live in
//   agent-session-control; it lives here, reaching the shared control-plane
//   transport through a DYNAMIC import inside the fetch body (never a static
//   import — a static import would make this module carry a runtime dependency on
//   the mocked module). The only compile-time link to agent-session-control is a
//   TYPE import, which is erased and creates no runtime edge.
//
//   N-2 rule — `protocol` is a CLOSED set { h1, h2, h3 }. Anything else (an older
//   node, a typo, a future value the badge doesn't understand) must render
//   NEUTRAL, never a green HTTP/3 badge. cleanMeasuredProtocol is that gate.
//
// A3 has NOT wired the harness emission yet, so in production today the server
// relay ring is legitimately EMPTY: a healthy poll returns `{ entries: [],
// next_after: null }` and the pane shows an honest "No requests captured yet"
// empty state. Everything here is ready to receive the moment emission lands.

// The auth shape only — a `import type` is erased at compile, so this creates NO
// runtime dependency on the widely-mocked agent-session-control module (N-1).
import type { ControlAuth } from './agent-session-control';

/** The measured application protocol of a single request. A CLOSED set: the badge
 *  greens ONLY `h3`; every value outside this set renders neutral (N-2). */
export type MeasuredProtocol = 'h1' | 'h2' | 'h3';

/** The exact closed set, in one place, so the validator and any future consumer
 *  share a single source of truth. */
export const MEASURED_PROTOCOLS: readonly MeasuredProtocol[] = ['h1', 'h2', 'h3'] as const;

/** Closed-set validator (N-2). Returns the value ONLY when it is exactly one of
 *  h1 / h2 / h3; every other input — an unknown string, a number, null, an object
 *  — maps to `null` (the neutral marker). It NEVER upgrades an unknown value to
 *  h3: an unrecognised protocol must never earn the green HTTP/3 badge. Pure and
 *  exported for the unit guard. */
export function cleanMeasuredProtocol(value: unknown): MeasuredProtocol | null {
  return typeof value === 'string' && (MEASURED_PROTOCOLS as readonly string[]).includes(value)
    ? (value as MeasuredProtocol)
    : null;
}

/** One captured request as it arrives on the wire. `protocol` is kept as the RAW
 *  string (not narrowed to MeasuredProtocol) precisely because it is untrusted:
 *  the renderer runs it through cleanMeasuredProtocol so an unknown value can be
 *  shown neutral rather than silently dropped or mis-greened. */
export interface NetworkRequestEntry {
  id: string;
  url: string;
  method: string;
  status: number;
  protocol: string;
  alpn?: string;
  type?: string;
  size_bytes?: number;
  started_at: number;
  duration_ms?: number;
  from_cache?: boolean;
  initiator?: string;
}

/** The `after` cursor round-tripped with the ring. A request id (string) in
 *  practice; kept permissive (string | number | null) so a numeric server cursor
 *  still flows. */
export type NetworkCursor = string | number | null;

/** One page of the ring, exactly the wire contract:
 *    GET /v1/agent-sessions/:id/network?after=<id> -> { entries, next_after }. */
export interface NetworkLogPage {
  entries: NetworkRequestEntry[];
  next_after: NetworkCursor;
}

/** Server ring bound (wire contract): the session ring holds at most this many
 *  entries; the local accumulated view is capped to match so a long-running
 *  session can never grow the pane without bound. */
export const NETWORK_RING_CAP = 2000;

/** Narrow one untrusted wire object to a NetworkRequestEntry, or `null` to drop
 *  it. Only the always-present fields are required; the optional fields are copied
 *  through when well-typed and omitted otherwise. `protocol` is copied verbatim
 *  (validation is a RENDER concern — dropping an unknown protocol here would hide
 *  the request entirely, when the contract says render it neutral). */
function cleanEntry(raw: unknown): NetworkRequestEntry | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== 'string' ||
    typeof r.url !== 'string' ||
    typeof r.method !== 'string' ||
    typeof r.status !== 'number' ||
    typeof r.started_at !== 'number'
  ) {
    return null;
  }
  const entry: NetworkRequestEntry = {
    id: r.id,
    url: r.url,
    method: r.method,
    status: r.status,
    protocol: typeof r.protocol === 'string' ? r.protocol : '',
    started_at: r.started_at,
  };
  if (typeof r.alpn === 'string') entry.alpn = r.alpn;
  if (typeof r.type === 'string') entry.type = r.type;
  if (typeof r.size_bytes === 'number') entry.size_bytes = r.size_bytes;
  if (typeof r.duration_ms === 'number') entry.duration_ms = r.duration_ms;
  if (typeof r.from_cache === 'boolean') entry.from_cache = r.from_cache;
  if (typeof r.initiator === 'string') entry.initiator = r.initiator;
  return entry;
}

/** Coerce the wire `next_after` to a NetworkCursor; anything else → null (stop). */
function normalizeCursor(raw: unknown): NetworkCursor {
  return typeof raw === 'string' || typeof raw === 'number' ? raw : null;
}

/**
 * Fetch one page of the request ring over the control plane, gated by the control
 * key OR account auth (exactly like the page-state route). Throws (via the shared
 * transport's authedResponse) on any non-2xx — the gated 503 / a 404 / a 401-403
 * expired credential — so the caller's poll `.catch` maps that to a calm pending
 * note, mirroring the cookies / page-state polls. A 200 always carries
 * `{ entries, next_after }`.
 *
 * The transport is reached through a DYNAMIC import (N-1): a static import would
 * give this module a runtime edge to the widely-mocked agent-session-control and
 * defeat the isolation. The import only resolves when the Network pane actually
 * polls (never in the ~17 mocked simulator suites, where the pane is inactive).
 */
export async function fetchAgentSessionNetwork(
  id: string,
  after: NetworkCursor = null,
  auth: ControlAuth = null,
): Promise<NetworkLogPage> {
  const { authedResponse } = await import('./agent-session-control');
  const { readBoundedApiJson } = await import('./read-bounded-json');
  const query =
    after === null || after === undefined ? '' : `?after=${encodeURIComponent(String(after))}`;
  const res = await authedResponse(
    `/v1/agent-sessions/${encodeURIComponent(id)}/network${query}`,
    { method: 'GET' },
    auth,
  );
  const body = await readBoundedApiJson<{ entries?: unknown; next_after?: unknown }>(res);
  const entries = Array.isArray(body.entries)
    ? body.entries.map(cleanEntry).filter((e): e is NetworkRequestEntry => e !== null)
    : [];
  return { entries, next_after: normalizeCursor(body.next_after) };
}

/** External store for the Network pane — mirrors the Cookies list store so only the
 *  open pane repaints when a fresh page lands, never the live video/browser host.
 *  `getSnapshot`: null before the first successful poll (→ a calm "connecting"
 *  note); [] after an empty ok (→ the honest "No requests captured yet" state);
 *  a populated array once entries arrive. */
export interface NetworkLogStore {
  getSnapshot: () => NetworkRequestEntry[] | null;
  subscribe: (listener: () => void) => () => void;
  /** The cursor the next poll should pass as `?after=`. */
  getCursor: () => NetworkCursor;
  /** Merge one freshly-fetched page: append its entries (capped to the ring bound)
   *  and advance the cursor. The first append flips a null snapshot to a real
   *  array, so an empty ok still surfaces the honest empty state. */
  append: (entries: NetworkRequestEntry[], nextAfter: NetworkCursor) => void;
  /** "Clear" button — empty the LOCAL view only. The cursor is retained so the
   *  server ring is untouched and already-seen entries are not re-pulled. */
  clearView: () => void;
  /** New/terminal session — drop everything AND the cursor so a fresh session
   *  starts from the beginning of its own ring. */
  reset: () => void;
}

export function createNetworkLogStore(): NetworkLogStore {
  let value: NetworkRequestEntry[] | null = null;
  let cursor: NetworkCursor = null;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getCursor: () => cursor,
    append: (entries, nextAfter) => {
      const base = value ?? [];
      const merged = entries.length === 0 ? base : [...base, ...entries];
      // Cap to the ring bound — evict the OLDEST (front) so the newest requests
      // stay visible, matching the server ring's oldest-evicted policy.
      value =
        merged.length > NETWORK_RING_CAP ? merged.slice(merged.length - NETWORK_RING_CAP) : merged;
      cursor = nextAfter;
      emit();
    },
    clearView: () => {
      value = [];
      emit();
    },
    reset: () => {
      value = null;
      cursor = null;
      emit();
    },
  };
}
