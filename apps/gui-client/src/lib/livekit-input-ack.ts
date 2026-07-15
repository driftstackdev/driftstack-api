import type { Room } from 'livekit-client';

export type InputReceiptIssue = 'timeout' | 'dropped' | 'failed' | null;

type Listener = (issue: InputReceiptIssue) => void;

interface ReceiptState {
  pending: Map<string, { sequence: number; timer: ReturnType<typeof setTimeout> }>;
  listeners: Set<Listener>;
  issue: InputReceiptIssue;
  nextSequence: number;
  settledSequence: number;
}

export const INPUT_RECEIPT_DEADLINE_MS = 5_000;
export const MAX_PENDING_INPUT_RECEIPTS = 128;

const states = new WeakMap<Room, ReceiptState>();
const INPUT_ID = /^[A-Za-z0-9_-]{1,64}$/u;

function stateFor(room: Room): ReceiptState {
  let state = states.get(room);
  if (state === undefined) {
    state = {
      pending: new Map(),
      listeners: new Set(),
      issue: null,
      nextSequence: 0,
      settledSequence: 0,
    };
    states.set(room, state);
  }
  return state;
}

function publish(state: ReceiptState, issue: InputReceiptIssue, sequence: number): void {
  if (sequence < state.settledSequence) return;
  state.settledSequence = sequence;
  state.issue = issue;
  for (const listener of state.listeners) listener(issue);
}

function expireOldest(state: ReceiptState): void {
  const oldest = state.pending.entries().next().value;
  if (oldest === undefined) return;
  clearTimeout(oldest[1].timer);
  state.pending.delete(oldest[0]);
  publish(state, 'timeout', oldest[1].sequence);
}

export function registerInputReceipt(
  room: Room,
  id: string,
  deadlineMs = INPUT_RECEIPT_DEADLINE_MS,
): void {
  if (!INPUT_ID.test(id) || !Number.isFinite(deadlineMs) || deadlineMs <= 0) return;
  const state = stateFor(room);
  const prior = state.pending.get(id);
  if (prior !== undefined) {
    clearTimeout(prior.timer);
    state.pending.delete(id);
  } else if (state.pending.size >= MAX_PENDING_INPUT_RECEIPTS) expireOldest(state);
  const sequence = ++state.nextSequence;
  const timer = setTimeout(() => {
    if (state.pending.get(id)?.timer !== timer) return;
    state.pending.delete(id);
    publish(state, 'timeout', sequence);
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
  const pending = state?.pending.get(record.id);
  if (state === undefined || pending === undefined) return true;
  clearTimeout(pending.timer);
  state.pending.delete(record.id);
  publish(state, record.status === 'applied' ? null : record.status, pending.sequence);
  return true;
}

export function resetInputReceipts(room: Room): void {
  const state = stateFor(room);
  for (const pending of state.pending.values()) clearTimeout(pending.timer);
  state.pending.clear();
  state.nextSequence = 0;
  state.settledSequence = 0;
  state.issue = null;
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
