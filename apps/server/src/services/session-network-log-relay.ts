// T-9 — ownership-gated live networkRequests consumer.
//
// Like the pageState / capabilityReport relays, this writes only to an in-memory
// store, but it must STILL verify the reporting node owns the session before
// appending — otherwise a buggy/rogue node could inject fabricated request rows
// (with an arbitrary protocol/URL) into another customer's live Network pane
// (the customer reads their OWN session's log, so a spoofed append reaches them).
//
// It mirrors makeSessionPageStateRelay / makeSessionCapabilityReportRelay in
// structure: the ownership check + write run on the shared bounded-node-latest
// work queue (fire-and-forget off the synchronous receive loop, per-node
// bounded). A failed lookup is logged, never thrown.
//
// ⛔ IT DIVERGES FROM THEM IN ONE PLACE, AND THAT DIVERGENCE IS THE POINT.
// This is an APPEND feed, not a state feed. pageState/capabilityReport frames
// each carry the session's whole CURRENT state, so the primitive's default
// "a queued frame is replaced by its successor" discards only redundancy. Here
// every frame carries DIFFERENT rows, and the queued frame is the ONLY copy
// they ever had: under that default a 3-frame burst dropped the middle frame's
// rows outright, with no counter and no log line (`onOverflow` fires only for
// distinct-session overflow), so the pane rendered a SHORT list that looked
// complete. This header used to acknowledge that hazard and accept it —
// "ephemeral, the fork re-emits" is false for an append feed: the fork emits
// the NEXT requests, never the lost ones.
//
// So this relay opts into the primitive's `coalesce` hook and CONCATENATES the
// queued frame's entries with its successor's. Preserving the entries, not the
// frame, is what keeps the feed honest. The merge is bounded in BOTH dimensions
// — NETWORK_LOG_MAX_QUEUED_ENTRIES rows and NETWORK_LOG_ENTRY_MAX_BYTES per row
// — because a row bound alone caps the COUNT of queued entries and not their
// COST, and `entries` is `z.array(z.unknown())` on the wire.
//
// ⛔ WHERE THE FOLD REPORTS, AND WHY IT IS NOT WHERE IT DROPS. `coalesce` runs
// on the synchronous RECEIVE path, BEFORE `process` performs the ownership
// lookup, so any log line it writes itself is one an unowning node can drive at
// will — the same log amplification that kept the per-entry safeParse behind the
// gate. So the fold is SILENT: every entry either bound discards is COUNTED onto
// the frame (`coalesceDropped`) and ridden through the gate, and the count is
// reported once from `process`, with the session id and a count (never a URL),
// in the same register as the per-entry drop warn. An incomplete pane stays
// diagnosable, and a node that owns nothing still gets the gate's zero-cost
// rejection. The one drop the fold cannot ride through the gate — the primitive
// discarding the queued frame when the fold throws — is reported from `onError`
// below, also as a count and a session id.

import type { Logger } from '../lib/logger.js';
import type {
  NetworkRequestsFrame,
  NetworkRequestEntry,
} from '../schemas/harness-control-protocol.js';
import {
  NETWORK_LOG_ENTRY_MAX_BYTES,
  NETWORK_LOG_FRAME_HARD_MAX_ENTRIES,
  NETWORK_LOG_MAX_ENTRIES_PER_FRAME,
  NetworkRequestEntrySchema,
} from '../schemas/harness-control-protocol.js';
import { makeBoundedNodeLatestRelay } from './bounded-node-latest-relay.js';
import type { SessionNetworkLogStore } from './session-network-log-store.js';

/**
 * Ceiling on a COALESCED frame, in ENTRIES — half of the bound the primitive's
 * `coalesce` contract requires this caller to own. The other half is
 * NETWORK_LOG_ENTRY_MAX_BYTES, applied per entry inside the fold.
 *
 * ⛔ THE ROW CEILING ALONE IS NOT A MEMORY BOUND, and reading it as one is the
 * mistake this note exists to prevent. It is deliberately EQUAL to the hard
 * ceiling a SINGLE wire frame may carry, so the ENTRY COUNT a fold can queue is
 * one wire frame's worth — but an entry is `z.unknown()` until `process` runs,
 * so N rows folded from N separate frames, each up to FLEET_WS_MAX_PAYLOAD_BYTES
 * (96 MiB), is a bounded COUNT of unbounded COST. The fold therefore also drops
 * entries over NETWORK_LOG_ENTRY_MAX_BYTES before merging them, which loses
 * nothing (`process` discards exactly those rows, at exactly that threshold) and
 * makes the two bounds together a real ceiling: the queued slot holds at most
 * NETWORK_LOG_MAX_QUEUED_ENTRIES * NETWORK_LOG_ENTRY_MAX_BYTES ≈ 5 MiB, less
 * than the single unfolded wire frame the slot held before coalescing existed.
 *
 * The row bound still absorbs five full NETWORK_LOG_MAX_ENTRIES_PER_FRAME frames
 * (or 1000 typical rows) behind one in-flight ownership lookup, orders of
 * magnitude more than a real burst, since the lookup is a single local-DB read
 * and the queue drains as soon as it resolves.
 *
 * Entries past the row bound are dropped from the TAIL — the same direction as
 * the existing per-frame truncation — so a fold never retroactively discards
 * rows that were already queued, and each merged frame reaches the ring in
 * producer order. ⛔ That is NOT a claim that the ring holds a contiguous prefix
 * of the session's whole stream: the producer keeps emitting while a saturated
 * window sheds its tail, and the next frames append AFTER the surviving prefix,
 * so the ring can hold a sequence with a HOLE in the middle. Neither the store's
 * server `seq` (contiguous by construction) nor the producer's entry `id`
 * exposes that hole, and the route body carries no drop count today — the log
 * line below is the only signal, which is why it must never be silent.
 */
export const NETWORK_LOG_MAX_QUEUED_ENTRIES = NETWORK_LOG_FRAME_HARD_MAX_ENTRIES;

/**
 * A frame as this relay QUEUES it: the wire frame plus the bookkeeping `coalesce`
 * maintains. No field below crosses the wire, is read from a node, or reaches the
 * ring — they exist so `process` can apply the per-frame policy to the RIGHT
 * number of frames and report what the queue bounds discarded.
 */
type QueuedNetworkRequestsFrame = NetworkRequestsFrame & {
  /** Wire frames folded into this one. Absent = 1, an unfolded wire frame. */
  readonly coalescedFrames?: number;
  /** Entries the queue bounds — rows AND bytes — discarded while folding.
   *  Absent = 0. Reported post-gate as `queueDropped`. */
  readonly coalesceDropped?: number;
  /** True once every entry in `entries` has cleared the fold's byte filter, so a
   *  later merge re-measures only rows it has not seen and one entry is
   *  serialized at most once however many times the slot is folded into. Absent
   *  on a raw wire frame, which has never been measured. */
  readonly oversizeFiltered?: boolean;
};

/** Narrow structural dep — the real agent-sessions repo satisfies this. */
interface NetworkLogRelaySessions {
  get(id: string): Promise<{ nodeId: string | null; status: string } | null>;
}

/**
 * Build the gated `onNetworkRequests` consumer wired into FleetControlRegistry.
 * Looks up the session's owning node and appends only for an exact, still-live
 * owner match. Unknown sessions, NULL-node sessions, a foreign reporting node,
 * and closed sessions all fail closed: none can have a legitimate live fleet
 * producer, so retaining their attacker-controlled entries only creates memory
 * pressure without a customer-visible use.
 *
 * Each accepted frame is defensively re-bounded before it reaches the ring:
 *   - entries larger than NETWORK_LOG_ENTRY_MAX_BYTES (serialized) are dropped,
 *     so a max-length URL + max-length metadata cannot compose an oversized row;
 *   - at most NETWORK_LOG_MAX_ENTRIES_PER_FRAME entries are kept (the schema
 *     admits up to the higher HARD ceiling so an over-cap frame is TRUNCATED
 *     here rather than rejected at parse and dropped whole).
 */
export function makeSessionNetworkLogRelay(
  agentSessions: NetworkLogRelaySessions,
  store: SessionNetworkLogStore,
  logger: Logger,
): (frame: NetworkRequestsFrame, reportingNodeId: string) => void {
  const process = async (
    frame: QueuedNetworkRequestsFrame,
    reportingNodeId: string,
  ): Promise<void> => {
    const session = await agentSessions.get(frame.sessionId);
    if (session === null || session.nodeId !== reportingNodeId || session.status === 'closed') {
      logger.warn(
        {
          component: 'session-network-log-relay',
          sessionId: frame.sessionId,
          ownerNodeId: session?.nodeId ?? null,
          reportingNodeId,
          sessionStatus: session?.status ?? null,
        },
        'dropped networkRequests without an exact live session-owner node match',
      );
      return;
    }
    // T-16 (A1+A3 2026-09-08) — PER-ENTRY validation. The frame schema accepts
    // raw entries (z.array(z.unknown())) precisely so ONE malformed row cannot
    // fail the array parse and drop the WHOLE frame (which would blank the pane
    // and read as "the fork emits nothing"). Validate each row here against the
    // canonical NetworkRequestEntrySchema: keep the valid, DROP + COUNT the
    // invalid. `protocol:""` is the normal steady state (error completions, cache
    // hits, pre-negotiation failures) so mixed frames are expected, not a fault.
    const valid: NetworkRequestEntry[] = [];
    let schemaDropped = 0;
    let firstReject: string | undefined;
    for (const raw of frame.entries) {
      const parsed = NetworkRequestEntrySchema.safeParse(raw);
      if (parsed.success) {
        valid.push(parsed.data);
      } else {
        schemaDropped += 1;
        if (firstReject === undefined) {
          const issue = parsed.error.issues[0];
          firstReject = issue ? `${issue.path.join('.') || '(root)'}:${issue.code}` : 'invalid';
        }
      }
    }
    // Existing defensive re-bounding on the VALID rows: drop over-byte entries and
    // truncate to the semantic per-frame cap. The cap is PER WIRE FRAME, so a
    // frame folded from N of them carries N times the allowance — otherwise
    // coalescing would hand the rows to the ring only for this slice to cut them
    // straight back off, which is the same silent loss wearing a different mask.
    const coalescedFrames = frame.coalescedFrames ?? 1;
    const kept: NetworkRequestEntry[] = valid
      .filter(
        (entry) => Buffer.byteLength(JSON.stringify(entry), 'utf8') <= NETWORK_LOG_ENTRY_MAX_BYTES,
      )
      .slice(0, NETWORK_LOG_MAX_ENTRIES_PER_FRAME * coalescedFrames);
    const reboundDropped = valid.length - kept.length;
    // Carried from the queue: what the fold's row and byte bounds discarded while
    // folding this frame. The fold itself is silent (it runs pre-gate), so THIS
    // is the first and only line those entries are reported on — and one register
    // accounts for every entry the frame lost on its way to the ring.
    const queueDropped = frame.coalesceDropped ?? 0;
    const droppedCount = schemaDropped + reboundDropped + queueDropped;
    if (droppedCount > 0) {
      // LOUD: a drop must be distinguishable downstream from a legitimately-empty
      // ring — otherwise correct-empty and data-loss present identically (A3). Names
      // the field:value of the first reject so "completing" a producer that emits an
      // unmapped protocol (e.g. WebKit's `http/1.1` instead of `h1`) is diagnosable.
      logger.warn(
        {
          component: 'session-network-log-relay',
          sessionId: frame.sessionId,
          droppedCount,
          schemaDropped,
          reboundDropped,
          queueDropped,
          coalescedFrames,
          firstReject,
          kept: kept.length,
        },
        'dropped malformed/over-cap/queue-bounded networkRequests entries; kept the valid rows (a schema-drop is NOT a legitimately-empty ring)',
      );
    }
    store.append(frame.sessionId, kept);
  };

  /**
   * Serialized size of one RAW wire row, or 0 when it cannot be serialized at
   * all. A 0 deliberately KEEPS the row: a value JSON cannot represent is not a
   * valid entry either, so letting it through means `process` drops and counts
   * it as a schema reject — where the count already belongs — instead of having
   * it vanish under the byte bound's counter wearing the wrong label. Neither
   * branch is reachable from the wire, where entries come from JSON.parse.
   */
  const entryBytes = (entry: unknown): number => {
    try {
      const json = JSON.stringify(entry);
      return json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
    } catch {
      return 0;
    }
  };

  /**
   * APPEND-FEED FOLD (the primitive's opt-in hook). `queued` is the OLDER frame,
   * so concatenating in this order preserves the producer's row order exactly.
   * Bounded per the hook's contract in BOTH dimensions, and every entry either
   * bound discards is counted onto the returned frame.
   *
   * ⛔ SILENT BY DESIGN — it does not log. It runs on the RECEIVE path, before
   * `process` has looked the session's owner up, so a line written here is one a
   * node that owns NOTHING can drive per frame with an attacker-chosen sessionId
   * in the structured field (1000 `null` entries are ~5 KB and entirely legal
   * pre-gate). That is the same log amplification that keeps the per-entry
   * safeParse behind the gate, and a pre-gate line cannot honestly claim a pane
   * is incomplete when the gate is about to discard the whole frame and there is
   * no pane. The count rides the frame instead and `process` reports it once, as
   * `queueDropped`, after ownership is known — so nothing is lost for a real
   * session, and a foreign frame costs one rejection line rather than one per
   * frame.
   */
  const coalesce = (
    queued: QueuedNetworkRequestsFrame,
    incoming: QueuedNetworkRequestsFrame,
  ): QueuedNetworkRequestsFrame => {
    // BYTES FIRST, ROWS SECOND. The row cap bounds how MANY entries the one
    // queued slot holds and says nothing about what they cost; each could be
    // drawn from its own FLEET_WS_MAX_PAYLOAD_BYTES frame, which is the
    // unbounded queued work the primitive exists to deny. Dropping the oversized
    // rows here loses NOTHING that would have reached the ring: the re-bound in
    // `process` discards exactly these rows at exactly this threshold, so the
    // filter changes only WHERE they die — before the queue holds them, not
    // after.
    const keepSized = (entries: readonly unknown[]): unknown[] =>
      entries.filter((entry) => entryBytes(entry) <= NETWORK_LOG_ENTRY_MAX_BYTES);
    const queuedEntries =
      queued.oversizeFiltered === true ? queued.entries : keepSized(queued.entries);
    const incomingEntries = keepSized(incoming.entries);
    const oversizeDropped =
      queued.entries.length -
      queuedEntries.length +
      (incoming.entries.length - incomingEntries.length);

    const folded = [...queuedEntries, ...incomingEntries];
    const entries = folded.slice(0, NETWORK_LOG_MAX_QUEUED_ENTRIES);
    const rowsDropped = folded.length - entries.length;
    const coalescedFrames = (queued.coalescedFrames ?? 1) + (incoming.coalescedFrames ?? 1);
    const queueDroppedTotal =
      (queued.coalesceDropped ?? 0) +
      (incoming.coalesceDropped ?? 0) +
      oversizeDropped +
      rowsDropped;
    return {
      ...queued,
      coalescedFrames,
      coalesceDropped: queueDroppedTotal,
      oversizeFiltered: true,
      entries,
    };
  };

  return makeBoundedNodeLatestRelay<QueuedNetworkRequestsFrame>({
    getSessionId: (frame) => frame.sessionId,
    process,
    coalesce,
    onError: ({ discardedQueued, error, sessionId }) => {
      if (discardedQueued !== undefined) {
        // ⛔ THE ONE DROP THE FOLD CANNOT RIDE THROUGH THE GATE. When `coalesce`
        // throws, the primitive falls back to latest-state and destroys the
        // QUEUED frame — up to a whole NETWORK_LOG_MAX_QUEUED_ENTRIES window of
        // rows that exist nowhere else. Reporting only "something failed" would
        // recreate exactly the silent shortening `coalesce` was added to end, so
        // the count goes to the SAME register as every other drop. Counts and a
        // session id only, never a URL — and, since the fold runs before the
        // ownership lookup, no claim about a pane that may not exist.
        const queueDropped =
          discardedQueued.entries.length + (discardedQueued.coalesceDropped ?? 0);
        logger.warn(
          {
            component: 'session-network-log-relay',
            sessionId,
            droppedCount: queueDropped,
            queueDropped,
            coalescedFrames: discardedQueued.coalescedFrames ?? 1,
            err: error,
          },
          'dropped queued networkRequests entries: the coalesce fold threw and its queued frame was discarded',
        );
        return;
      }
      logger.error(
        { component: 'session-network-log-relay', sessionId, err: error },
        'failed to gate/store networkRequests',
      );
    },
    onOverflow: ({ reportingNodeId, sessionBudget, sessionId }) => {
      logger.warn(
        {
          component: 'session-network-log-relay',
          reportingNodeId,
          sessionBudget,
          sessionId,
        },
        'dropped networkRequests because the reporting node exceeded its relay session budget',
      );
    },
  });
}
