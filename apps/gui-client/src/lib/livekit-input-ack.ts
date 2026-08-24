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
}

export const INPUT_RECEIPT_DEADLINE_MS = 5_000;

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
  noteMissedAck(state, oldest[1].sequence);
}

export function registerInputReceipt(
  room: Room,
  id: string,
  deadlineMs = INPUT_RECEIPT_DEADLINE_MS,
): void {
  if (!INPUT_ID.test(id) || !Number.isFinite(deadlineMs) || deadlineMs <= 0) return;
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
  }, deadlineMs);
  state.pending.set(id, { sequence, timer });
}

export function cancelInputReceipt(room: Room, id: string): void {
  const state = states.get(room);
  const pending = state?.pending.get(id);
  if (state === undefined || pending === undefined) return;
  clearTimeout(pending.timer);
  state.pending.delete(id);
}

export function handleInputAck(room: Room, value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== 'inputAck') return false;
  if (
    Object.keys(record).length !== 3 ||
    typeof record.id !== 'string' ||
    !INPUT_ID.test(record.id) ||
    (record.status !== 'applied' && record.status !== 'dropped' && record.status !== 'failed')
  ) {
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

export function resetInputReceipts(room: Room): void {
  const state = stateFor(room);
  for (const pending of state.pending.values()) clearTimeout(pending.timer);
  state.pending.clear();
  state.timedOut.clear();
  state.nextSequence = 0;
  state.settledSequence = 0;
  state.issue = null;
  state.missedAcks = 0;
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
