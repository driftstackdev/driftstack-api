// Socket-buffer ceilings for the SSE streams.
//
// An SSE response holds a socket open indefinitely. A viewer that stops reading
// — a paused debugger, a wedged proxy, a laptop that slept — does not close the
// connection; it just stops draining, and `reply.raw.writableLength` grows
// without bound until the process is out of memory. Every stream therefore ends
// its own representation past a ceiling. The turn or the event source keeps
// running; only that one viewer's socket is dropped.
//
// The 4 MB ceiling was declared THREE separate times — module scope in
// account-notifications.ts and status-stream.ts, function scope inside
// agent-sessions.ts — with three content-parity tests each pinning its own
// file's copy as a source literal. Every copy was covered; nothing said they had
// to AGREE. Tuning one for a larger payload and updating its pin would have left
// two streams on the old ceiling, which is the failure mode this file removes
// rather than guards.

/**
 * Ceiling for streams carrying real payloads (notifications, status events,
 * agent-session events). Generous enough that a healthy-but-slow reader is
 * never cut, small enough that a wedged one cannot exhaust the heap.
 */
export const MAX_SSE_BUFFER_BYTES = 4_000_000;

/**
 * Tighter ceiling for the agent-message heartbeat lane, and deliberately not
 * the value above.
 *
 * That lane writes only `: heartbeat <iso>` comments — tens of bytes every 15
 * seconds. A reader that is draining at all keeps `writableLength` near zero, so
 * anything approaching even this bound means the viewer is gone. Waiting for
 * 4 MB of heartbeats would hold a dead socket open for weeks.
 */
export const MAX_SSE_HEARTBEAT_BUFFER_BYTES = 64 * 1024;
