// Unit tests for SessionLivenessStore (A2 W2679): latest-worker-liveness-per-
// agent-session, fed by Heartbeat.activeSessionStates. The load-bearing
// invariants are (1) per-node absence eviction, (2) NO cross-node eviction
// (anti-poison), (3) the beatAt staleness guard, (4) the bounded maxEntries cap.

import { describe, expect, it } from 'vitest';
import {
  SessionLivenessStore,
  SESSION_LIVENESS_TTL_MS,
} from '../../src/services/session-liveness-store.js';

describe('SessionLivenessStore', () => {
  it('get returns null for an unknown session', () => {
    const store = new SessionLivenessStore();
    expect(store.get('agt_unknown')).toBeNull();
  });

  it('recordBeat stores per-session state + owning node + beatAt', () => {
    const store = new SessionLivenessStore();
    store.recordBeat('node-1', { agt_a: 'active', agt_b: 'provisioning' }, 1000);
    expect(store.get('agt_a')).toEqual({ state: 'active', nodeId: 'node-1', beatAt: 1000 });
    expect(store.get('agt_b')).toEqual({ state: 'provisioning', nodeId: 'node-1', beatAt: 1000 });
  });

  it('a later beat updates the state + beatAt for a still-present session', () => {
    const store = new SessionLivenessStore();
    store.recordBeat('node-1', { agt_a: 'provisioning' }, 1000);
    store.recordBeat('node-1', { agt_a: 'active' }, 2000);
    expect(store.get('agt_a')).toEqual({ state: 'active', nodeId: 'node-1', beatAt: 2000 });
  });

  it('per-node absence eviction — a session absent from its OWNING node’s next beat is evicted (ended/orphaned)', () => {
    const store = new SessionLivenessStore();
    store.recordBeat('node-1', { agt_a: 'active', agt_b: 'active' }, 1000);
    // node-1 beats again WITHOUT agt_b → agt_b has ended on node-1.
    store.recordBeat('node-1', { agt_a: 'active' }, 2000);
    expect(store.get('agt_a')).not.toBeNull();
    expect(store.get('agt_b')).toBeNull();
  });

  it('cross-node NON-eviction — a DIFFERENT node’s beat must NEVER evict another node’s sessions', () => {
    const store = new SessionLivenessStore();
    store.recordBeat('node-1', { agt_a: 'active' }, 1000);
    // node-2 beats (it knows nothing about agt_a) → agt_a stays live on node-1.
    store.recordBeat('node-2', { agt_z: 'active' }, 1100);
    expect(store.get('agt_a')).toEqual({ state: 'active', nodeId: 'node-1', beatAt: 1000 });
    expect(store.get('agt_z')).toEqual({ state: 'active', nodeId: 'node-2', beatAt: 1100 });
  });

  it('a session that migrates to a new node is re-owned (the new node’s beat wins; the old node no longer evicts it)', () => {
    const store = new SessionLivenessStore();
    store.recordBeat('node-1', { agt_a: 'active' }, 1000);
    store.recordBeat('node-2', { agt_a: 'active' }, 1100); // re-homed to node-2
    expect(store.get('agt_a')).toEqual({ state: 'active', nodeId: 'node-2', beatAt: 1100 });
    // node-1 beating without it must NOT evict it now (node-2 owns it).
    store.recordBeat('node-1', {}, 1200);
    expect(store.get('agt_a')).toEqual({ state: 'active', nodeId: 'node-2', beatAt: 1100 });
  });

  it('isFresh — an entry within the TTL is fresh, a stale (silent-node) entry is not', () => {
    const store = new SessionLivenessStore();
    store.recordBeat('node-1', { agt_a: 'active' }, 1000);
    const entry = store.get('agt_a');
    expect(entry).not.toBeNull();
    if (entry === null) return;
    // within TTL.
    expect(store.isFresh(entry, SESSION_LIVENESS_TTL_MS, 1000 + SESSION_LIVENESS_TTL_MS)).toBe(
      true,
    );
    // one ms past TTL → stale → fall back to "unknown".
    expect(store.isFresh(entry, SESSION_LIVENESS_TTL_MS, 1000 + SESSION_LIVENESS_TTL_MS + 1)).toBe(
      false,
    );
  });

  it('is bounded — evicts the oldest entry past maxEntries (no unbounded growth from dead sessions)', () => {
    const store = new SessionLivenessStore(3);
    store.recordBeat('node-1', { agt_1: 'active' }, 1000);
    store.recordBeat('node-2', { agt_2: 'active' }, 1000);
    store.recordBeat('node-3', { agt_3: 'active' }, 1000);
    expect(store.size).toBe(3);
    store.recordBeat('node-4', { agt_4: 'active' }, 1000); // evicts agt_1 (oldest)
    expect(store.size).toBe(3);
    expect(store.get('agt_1')).toBeNull();
    expect(store.get('agt_4')).not.toBeNull();
  });

  it('delete drops a session entry (e.g. on session end)', () => {
    const store = new SessionLivenessStore();
    store.recordBeat('node-1', { agt_a: 'active' }, 1000);
    store.delete('agt_a');
    expect(store.get('agt_a')).toBeNull();
  });
});
