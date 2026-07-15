import type { Room } from 'livekit-client';

export type InputReceiptIssue = 'timeout' | 'dropped' | 'failed' | null;

type Listener = (issue: InputReceiptIssue) => void;

interface ReceiptState {
  pending: Map<string, ReturnType<typeof setTimeout>>;
  listeners: Set<Listener>;
  issue: InputReceiptIssue;
}

export const INPUT_RECEIPT_DEADLINE_MS = 5_000;
export const MAX_PENDING_INPUT_RECEIPTS = 128;

const states = new WeakMap<Room, ReceiptState>();
const INPUT_ID = /^[A-Za-z0-9_-]{1,64}$/u;

function stateFor(room: Room): ReceiptState {
  let state = states.get(room);
  if (state === undefined) {
    state = { pending: new Map(), listeners: new Set(), issue: null };
    states.set(room, state);
  }
  return state;
}

function publish(state: ReceiptState, issue: InputReceiptIssue): void {
  state.issue = issue;
  for (const listener of state.listeners) listener(issue);
}

function expireOldest(state: ReceiptState): void {
  const oldest = state.pending.entries().next().value;
  if (oldest === undefined) return;
  clearTimeout(oldest[1]);
  state.pending.delete(oldest[0]);
  publish(state, 'timeout');
}

export function registerInputReceipt(
  room: Room,
  id: string,
  deadlineMs = INPUT_RECEIPT_DEADLINE_MS,
): void {
  if (!INPUT_ID.test(id) || !Number.isFinite(deadlineMs) || deadlineMs <= 0) return;
  const state = stateFor(room);
  const prior = state.pending.get(id);
  if (prior !== undefined) clearTimeout(prior);
  else if (state.pending.size >= MAX_PENDING_INPUT_RECEIPTS) expireOldest(state);
  const timer = setTimeout(() => {
    if (state.pending.get(id) !== timer) return;
    state.pending.delete(id);
    publish(state, 'timeout');
  }, deadlineMs);
  state.pending.set(id, timer);
}

export function cancelInputReceipt(room: Room, id: string): void {
  const state = states.get(room);
  const timer = state?.pending.get(id);
  if (state === undefined || timer === undefined) return;
  clearTimeout(timer);
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
  const timer = state?.pending.get(record.id);
  if (state === undefined || timer === undefined) return true;
  clearTimeout(timer);
  state.pending.delete(record.id);
  publish(state, record.status === 'applied' ? null : record.status);
  return true;
}

export function resetInputReceipts(room: Room): void {
  const state = stateFor(room);
  for (const timer of state.pending.values()) clearTimeout(timer);
  state.pending.clear();
  publish(state, null);
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
