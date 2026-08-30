import type { Room } from 'livekit-client';

export type InputReceiptIssue = 'timeout' | 'dropped' | 'failed' | null;

type Listener = (issue: InputReceiptIssue) => void;

interface ReceiptState {
  pending: Map<string, { sequence: number; timer: ReturnType<typeof setTimeout> }>;
  /**
   * Receipts whose deadline elapsed, id -> the sequence their timeout was published at.
   *
   * A timeout is a PREDICTION that the device will never answer, and the device is free
   * to disprove it by answering late. Without this, the ack that disproves it arrives to
   * find no pending entry and is consumed inertly, so the banner keeps saying "did not
   * confirm" about an input the device confirmed. On a device whose round trip is simply
   * slower than the deadline that is every input, and the badge never clears.
   */
  timedOut: Map<string, number>;
  listeners: Set<Listener>;
  issue: InputReceiptIssue;
  nextSequence: number;
  settledSequence: number;
  /** Consecutive unanswered receipts; reset by any ack that arrives. */
  missedAcks: number;
  /**
   * Epoch-ms of the most recent miss, or 0 if none. Misses DECAY: two losses far
   * apart are background noise, not a broken device, and without this the
   * counter only ever reset on an ack or a full reset — so unrelated losses
   * minutes apart still stacked to the alarm threshold.
   */
  lastMissAt: number;
  /**
   * Why inputAck frames were REJECTED, reason -> count. The rejection itself is
   * deliberate (see `handleInputAck`); what was wrong is that it was SILENT.
   *
   * A rejected ack never settles its receipt, so the receipt times out and the
   * badge says "did not confirm" about an input the device DID confirm. If the
   * cause is a protocol change rather than a bad frame, that is every ack, and
   * the badge is permanent with nothing anywhere saying why.
   */
  rejectedAcks: Map<string, number>;
  /** Reasons already warned about, so a per-frame fault cannot spam the console. */
  warnedReasons: Set<string>;
}

export const INPUT_RECEIPT_DEADLINE_MS = 5_000;

/**
 * How much of the receipt budget is spent on the network rather than on the
 * device applying the input. A tap's ack makes a full round trip (publish →
 * apply → ack), so the link cost is at least one RTT; 3× leaves headroom for
 * jitter and the second leg without turning one slow sample into a minute of
 * silence.
 */
const RTT_DEADLINE_MULTIPLIER = 3;

/** Time budgeted for the DEVICE itself, on top of the link cost. */
const DEVICE_APPLY_BUDGET_MS = 2_000;

/**
 * Ceiling on the adaptive deadline. Past this the badge stops being a latency
 * report and starts being a way to never say anything, which is the failure the
 * badge exists to prevent.
 */
export const INPUT_RECEIPT_MAX_DEADLINE_MS = 30_000;

/**
 * The receipt deadline for a link whose measured round trip is `rttMs`.
 *
 * ⛔ MONOTONE UPWARD — never returns less than the flat budget. A proxied mobile
 * session is the product's ordinary case, not its bad case, and a fixed 5s
 * declares a healthy 1.5s-RTT link dead: "Device did not confirm the last
 * input" for input the device applied. Shortening the budget on a fast link
 * would trade that false alarm for a new one, so a fast link simply keeps the
 * flat deadline it already had.
 *
 * `null` (no fresh sample — the ping is stale or the room just connected) also
 * keeps the flat budget: an unmeasured link is not evidence of a slow one.
 */
export function receiptDeadlineForRtt(rttMs: number | null): number {
  if (rttMs === null || !Number.isFinite(rttMs) || rttMs <= 0) {
    return INPUT_RECEIPT_DEADLINE_MS;
  }
  const adaptive = rttMs * RTT_DEADLINE_MULTIPLIER + DEVICE_APPLY_BUDGET_MS;
  return Math.min(
    INPUT_RECEIPT_MAX_DEADLINE_MS,
    Math.max(INPUT_RECEIPT_DEADLINE_MS, Math.round(adaptive)),
  );
}

/**
 * Latest RTT per room, written by the latency ping and read when a receipt is
 * registered. A module-level map rather than a parameter because the measurement
 * lives in a React hook and the publish path is plain module code — threading it
 * through every caller would put a UI concern in the wire layer.
 *
 * Keyed by Room so two rooms cannot borrow each other's link quality, and it is
 * a WeakMap so a closed room's sample cannot keep the room object alive.
 */
const roomRtt = new WeakMap<Room, number>();

/** Record the newest RTT sample for `room`. `null` clears it (stale / dead). */
export function noteRoomRtt(room: Room, rttMs: number | null): void {
  if (rttMs === null || !Number.isFinite(rttMs) || rttMs <= 0) {
    roomRtt.delete(room);
    return;
  }
  roomRtt.set(room, rttMs);
}

/** The deadline a receipt on `room` gets when the caller names none. */
export function currentReceiptDeadline(room: Room): number {
  return receiptDeadlineForRtt(roomRtt.get(room) ?? null);
}

/**
 * How many receipts in a row must go unanswered before we accuse the device.
 *
 * A missing ack is NOT a failed input: the harness injects first and acks
 * after, so by the time we could time out the tap has already been applied.
 * And the ack itself can be lost in transit without anyone noticing —
 * `publishInputAck` sends via `try? await publishData(...)`, which silently
 * discards both a not-connected error and a bounded-publish timeout (the
 * LiveKit SDK's publish can hang; that hang is converted to a throw and then
 * dropped on the floor).
 *
 * So ONE unanswered receipt is weak evidence of anything, and raising a badge
 * on it means telling the customer their device is broken every time a single
 * ack goes missing. Two in a row is a pattern worth surfacing. This calibrates
 * the alarm to the evidence; it does not hide a real outage, which produces an
 * unbroken run of misses and still trips on the second one.
 */
export const MISSED_ACKS_BEFORE_ALARM = 2;

/**
 * How long a miss stays "recent". Beyond this the counter starts over, so the
 * alarm means "misses arrived together" rather than "two misses have happened
 * since this session began".
 *
 * 30s is four deadlines' worth of the flat 5s receipt budget: long enough that
 * a genuinely wedged control link still trips it on consecutive inputs, short
 * enough that unrelated losses minutes apart never accumulate.
 */
const MISS_DECAY_MS = 30_000;
export const MAX_PENDING_INPUT_RECEIPTS = 128;

const states = new WeakMap<Room, ReceiptState>();
const INPUT_ID = /^[A-Za-z0-9_-]{1,64}$/u;

function stateFor(room: Room): ReceiptState {
  let state = states.get(room);
  if (state === undefined) {
    state = {
      pending: new Map(),
      timedOut: new Map(),
      listeners: new Set(),
      issue: null,
      nextSequence: 0,
      settledSequence: 0,
      missedAcks: 0,
      lastMissAt: 0,
      rejectedAcks: new Map(),
      warnedReasons: new Set(),
    };
    states.set(room, state);
  }
  return state;
}

/**
 * Record one unanswered receipt, and raise the alarm only once enough of them
 * have stacked up without an ack in between.
 */
function noteMissedAck(state: ReceiptState, sequence: number): void {
  // V-1611 — misses DECAY. The counter used to reset only on an ack or a full
  // reset, so two lost acks minutes apart still stacked to the threshold. The
  // harness swallows both not-connected errors and publish timeouts on its
  // side, so an isolated lost ack is expected background rather than a signal;
  // what indicates a broken device is misses arriving CLOSE TOGETHER.
  const now = Date.now();
  if (state.lastMissAt !== 0 && now - state.lastMissAt > MISS_DECAY_MS) {
    state.missedAcks = 0;
  }
  state.lastMissAt = now;
  state.missedAcks += 1;
  if (state.missedAcks < MISSED_ACKS_BEFORE_ALARM) return;
  publish(state, 'timeout', sequence);
}

function publish(state: ReceiptState, issue: InputReceiptIssue, sequence: number): void {
  if (sequence < state.settledSequence) return;
  state.settledSequence = sequence;
  state.issue = issue;
  for (const listener of state.listeners) listener(issue);
}

/**
 * Remember a timed-out receipt so a late ack can still settle it, bounded exactly like
 * `pending` so a device that never answers cannot grow this without limit.
 */
function rememberTimeout(state: ReceiptState, id: string, sequence: number): void {
  if (state.timedOut.size >= MAX_PENDING_INPUT_RECEIPTS) {
    const oldest = state.timedOut.keys().next().value;
    if (oldest !== undefined) state.timedOut.delete(oldest);
  }
  state.timedOut.set(id, sequence);
}

function expireOldest(state: ReceiptState): void {
  const oldest = state.pending.entries().next().value;
  if (oldest === undefined) return;
  clearTimeout(oldest[1].timer);
  state.pending.delete(oldest[0]);
  rememberTimeout(state, oldest[0], oldest[1].sequence);
  // ⚠️ V-1611 — I removed this call and put it back. Recording why, so the next
  // reader does not spend the same hour.
  //
  // The argument for removing it: eviction drops a receipt that is STILL IN
  // FLIGHT, and nothing has said it failed, so counting it as a miss looks like
  // accusing the device of our own bookkeeping limit.
  //
  // Why that argument is wrong: receipts are removed from `pending` on ACK, so
  // reaching MAX_PENDING_INPUT_RECEIPTS means 128 receipts are outstanding
  // SIMULTANEOUSLY, none of them answered. That is not a fast typist — it is a
  // device that has stopped acknowledging inside its own deadline, which is
  // exactly what the badge exists to report. `bounds pending cardinality and
  // fails visibly instead of growing without limit` pins this on purpose: a
  // silent eviction means the table overflowed and nobody was told.
  noteMissedAck(state, oldest[1].sequence);
}

export function registerInputReceipt(
  room: Room,
  id: string,
  /** Omit to get the link-adaptive budget; pass one to override it (bulk text
   *  scales with character count and must not be shortened by a fast link). */
  deadlineMs?: number,
): void {
  const effectiveDeadline = deadlineMs ?? currentReceiptDeadline(room);
  if (!INPUT_ID.test(id) || !Number.isFinite(effectiveDeadline) || effectiveDeadline <= 0) return;
  const state = stateFor(room);
  const prior = state.pending.get(id);
  // A re-registered id supersedes any earlier verdict about it, including a timeout we
  // are still holding open for a late ack.
  state.timedOut.delete(id);
  if (prior !== undefined) {
    clearTimeout(prior.timer);
    state.pending.delete(id);
  } else if (state.pending.size >= MAX_PENDING_INPUT_RECEIPTS) expireOldest(state);
  const sequence = ++state.nextSequence;
  const timer = setTimeout(() => {
    if (state.pending.get(id)?.timer !== timer) return;
    state.pending.delete(id);
    rememberTimeout(state, id, sequence);
    noteMissedAck(state, sequence);
  }, effectiveDeadline);
  state.pending.set(id, { sequence, timer });
}

export function cancelInputReceipt(room: Room, id: string): void {
  const state = states.get(room);
  const pending = state?.pending.get(id);
  if (state === undefined || pending === undefined) return;
  clearTimeout(pending.timer);
  state.pending.delete(id);
}

function classifyRejection(record: Record<string, unknown>): string {
  if (Object.keys(record).length !== 3) return 'unexpected-fields';
  if (typeof record.id !== 'string' || !INPUT_ID.test(record.id)) return 'bad-id';
  return 'bad-status';
}

function noteRejectedAck(
  state: ReceiptState,
  reason: string,
  record: Record<string, unknown>,
): void {
  state.rejectedAcks.set(reason, (state.rejectedAcks.get(reason) ?? 0) + 1);
  if (state.warnedReasons.has(reason)) return;
  state.warnedReasons.add(reason);
  // `unexpected-fields` is the one that means PROTOCOL DRIFT rather than a bad
  // frame, so name the keys — that is the whole diagnostic a future reader needs.
  const detail =
    reason === 'unexpected-fields' ? ` keys=[${Object.keys(record).sort().join(',')}]` : '';
  console.warn(`[input-ack] rejected inputAck frame: ${reason}${detail}`);
}

/** Rejected-ack counts by reason. Diagnostic surface; empty when nothing was rejected. */
export function rejectedInputAckCounts(room: Room): Record<string, number> {
  const state = states.get(room);
  if (state === undefined) return {};
  return Object.fromEntries(state.rejectedAcks);
}

export function handleInputAck(room: Room, value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== 'inputAck') return false;
  // ⛔ The strict shape is INTENTIONAL and stays. `type` alone does not identify a
  // frame: a `tabListUpdate` field riding on a frame that CLAIMS `type: 'inputAck'`
  // would otherwise settle a receipt from a frame that is not one, which
  // `must-not-be-accepted` in the unit test pins on purpose.
  //
  // ⚠️ What was wrong here was not the rejection, it was the SILENCE. A rejected
  // ack leaves its receipt pending until the deadline, so it reads to the customer
  // as "Device did not confirm the last input" — and if the cause is the harness
  // adding a field rather than one bad frame, it is EVERY ack, forever, with no
  // diagnostic anywhere. Same signature as the three defects fixed on 2026-08-26:
  // a value refused, a frame dropped, and nothing said. So: still reject, but say so.
  if (
    Object.keys(record).length !== 3 ||
    typeof record.id !== 'string' ||
    !INPUT_ID.test(record.id) ||
    (record.status !== 'applied' && record.status !== 'dropped' && record.status !== 'failed')
  ) {
    noteRejectedAck(stateFor(room), classifyRejection(record), record);
    return true;
  }
  const state = states.get(room);
  if (state === undefined) return true;
  const pending = state.pending.get(record.id);
  if (pending === undefined) {
    // A LATE ack for a receipt we already gave up on. The device answered after all, so
    // the timeout was a wrong prediction and this is the correction — settle it at the
    // sequence the timeout was published at, which leaves `publish` to discard it if a
    // NEWER input has settled since. Anything else keeps a stale "did not confirm" on
    // screen for an input that was confirmed.
    const timedOutSequence = state.timedOut.get(record.id);
    if (timedOutSequence === undefined) return true;
    state.timedOut.delete(record.id);
    state.missedAcks = 0;
    publish(state, record.status === 'applied' ? null : record.status, timedOutSequence);
    return true;
  }
  clearTimeout(pending.timer);
  state.pending.delete(record.id);
  // Any answer at all -- applied, dropped or failed -- proves the ack path is
  // alive, so the consecutive-miss run restarts. `dropped`/`failed` still
  // publish their own issue below; they are a device verdict, not silence.
  state.missedAcks = 0;
  publish(state, record.status === 'applied' ? null : record.status, pending.sequence);
  return true;
}

/**
 * The device proved it is alive — clear a stale "did not confirm" warning.
 *
 * ⛔ THE DISTINCTION THIS RESTS ON: `timeout` is a PREDICTION that the device will
 * never answer. `dropped` and `failed` are VERDICTS the device itself returned
 * about a specific input. Evidence of liveness refutes a prediction; it says
 * nothing about a verdict, so only `timeout` is cleared here.
 *
 * ⚠️ Why this exists: the only two places that published a clear were both inside
 * `handleInputAck`, so the badge could ONLY clear when an ack arrived — and an ack
 * only arrives in response to input the customer sends. After a lag recovered, the
 * warning sat on screen until they happened to tap something, saying the device had
 * not confirmed while the device was demonstrably answering. Owner-reported:
 * "it's already back live working, so it becomes useless to show".
 *
 * Any inbound frame from the device is sufficient evidence. It does not have to be
 * an ack — the claim being retracted is "we cannot reach the device", and one
 * frame refutes exactly that.
 */
export function noteDeviceLiveness(room: Room): void {
  const state = states.get(room);
  if (state === undefined || state.issue !== 'timeout') return;
  // Nothing outstanding to be pessimistic about: a receipt still pending has its
  // own deadline and may legitimately re-raise this.
  state.missedAcks = 0;
  state.lastMissAt = 0;
  publish(state, null, state.nextSequence);
}

export function resetInputReceipts(room: Room): void {
  const state = stateFor(room);
  for (const pending of state.pending.values()) clearTimeout(pending.timer);
  state.pending.clear();
  state.timedOut.clear();
  state.nextSequence = 0;
  state.settledSequence = 0;
  state.issue = null;
  state.missedAcks = 0;
  // Clear the decay clock with the counter. A stale timestamp means the FIRST
  // miss after a reset compares against a pre-reset instant, decays immediately,
  // and quietly raises the alarm threshold from two to three.
  state.lastMissAt = 0;
  for (const listener of state.listeners) listener(null);
}

export function subscribeInputReceiptIssues(room: Room, listener: Listener): () => void {
  const state = stateFor(room);
  state.listeners.add(listener);
  listener(state.issue);
  return () => state.listeners.delete(listener);
}

export function pendingInputReceiptCount(room: Room): number {
  return states.get(room)?.pending.size ?? 0;
}

/**
 * How many timed-out receipts are still settleable by a late ack.
 *
 * Exported so the bound on that map is testable. It is fed by a device that is NOT
 * answering, which is exactly the condition under which unbounded growth would go
 * unnoticed, so "it is capped" needs to be an assertion rather than a comment.
 */
export function timedOutInputReceiptCount(room: Room): number {
  return states.get(room)?.timedOut.size ?? 0;
}
