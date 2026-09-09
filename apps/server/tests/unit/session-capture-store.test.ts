// #7 — SessionCaptureStore: the bounded per-session screenshot store the executor
// writes and GET /v1/agent-sessions/:id/captures/:id reads. Every bound is
// asserted (per-session cap, cross-session LRU, TTL sweep) because the whole
// point of the store is that a live, capture-heavy session cannot grow memory
// unbounded, and a server-minted id is what addresses the (attacker-influenceable)
// bytes.

import { describe, expect, it } from 'vitest';
import { SessionCaptureStore } from '../../src/services/session-capture-store.js';

// A deterministic store: a controllable clock + a monotonic id minter, so TTL
// math and eviction order are exact rather than time/UUID dependent.
function makeStore(over: { maxSessions?: number; perSession?: number; ttlMs?: number } = {}) {
  let now = 1_000_000;
  let n = 0;
  const store = new SessionCaptureStore(
    over.maxSessions ?? 3,
    over.perSession ?? 2,
    over.ttlMs ?? 10_000,
    () => now,
    () => `cap_${(n += 1).toString()}`,
  );
  return { store, advance: (ms: number) => (now += ms) };
}

describe('SessionCaptureStore', () => {
  it('put mints a captureId and get round-trips the bytes + format', () => {
    const { store } = makeStore();
    const id = store.put('ses_1', 'AAAA', 'png');
    expect(id).toBe('cap_1');
    expect(store.get('ses_1', id)).toEqual({
      captureId: 'cap_1',
      bytesB64: 'AAAA',
      format: 'png',
      at: 1_000_000,
    });
  });

  it('a miss (unknown session or captureId) returns undefined, never throws', () => {
    const { store } = makeStore();
    store.put('ses_1', 'AAAA', 'png');
    expect(store.get('ses_1', 'cap_nope')).toBeUndefined();
    expect(store.get('ses_other', 'cap_1')).toBeUndefined();
  });

  it('per-session cap evicts the OLDEST captureId once past the ceiling', () => {
    const { store } = makeStore({ perSession: 2 });
    const a = store.put('ses_1', 'A', 'png');
    const b = store.put('ses_1', 'B', 'png');
    const c = store.put('ses_1', 'C', 'png'); // pushes past 2 → 'a' evicted
    expect(store.get('ses_1', a)).toBeUndefined();
    expect(store.get('ses_1', b)?.bytesB64).toBe('B');
    expect(store.get('ses_1', c)?.bytesB64).toBe('C');
  });

  it('LRU-caps the session map — the stalest session is evicted on overflow', () => {
    const { store } = makeStore({ maxSessions: 2 });
    store.put('ses_1', 'A', 'png');
    store.put('ses_2', 'B', 'png');
    store.put('ses_3', 'C', 'png'); // 3rd session → ses_1 (stalest) evicted
    expect(store.get('ses_1', 'cap_1')).toBeUndefined();
    expect(store.size).toBe(2);
    expect(store.get('ses_2', 'cap_2')?.bytesB64).toBe('B');
    expect(store.get('ses_3', 'cap_3')?.bytesB64).toBe('C');
  });

  it('a re-put on a session refreshes its LRU position (it is no longer stalest)', () => {
    const { store } = makeStore({ maxSessions: 2 });
    store.put('ses_1', 'A', 'png');
    store.put('ses_2', 'B', 'png');
    store.put('ses_1', 'A2', 'png'); // ses_1 is now newest
    store.put('ses_3', 'C', 'png'); // overflow → ses_2 (now stalest) evicted, ses_1 kept
    expect(store.get('ses_2', 'cap_2')).toBeUndefined();
    expect(store.size).toBe(2);
    expect(store.get('ses_1', 'cap_1')?.bytesB64).toBe('A');
  });

  it('TTL sweep drops a session idle past the window on the next put', () => {
    const { store, advance } = makeStore({ ttlMs: 10_000 });
    store.put('ses_old', 'A', 'png');
    advance(10_001);
    store.put('ses_new', 'B', 'png'); // the put's sweep drops ses_old
    expect(store.get('ses_old', 'cap_1')).toBeUndefined();
    expect(store.get('ses_new', 'cap_2')?.bytesB64).toBe('B');
  });

  it('delete drops a session immediately', () => {
    const { store } = makeStore();
    store.put('ses_1', 'A', 'png');
    store.delete('ses_1');
    expect(store.get('ses_1', 'cap_1')).toBeUndefined();
    expect(store.size).toBe(0);
  });
});
