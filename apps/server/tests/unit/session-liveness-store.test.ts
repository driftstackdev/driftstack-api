// Unit tests for SessionLivenessStore (A2 W2679): latest-worker-liveness-per-
// agent-session, fed by Heartbeat.activeSessionStates. The load-bearing
// invariants are (1) per-node absence eviction, (2) NO cross-node eviction
// (anti-poison), (3) the beatAt staleness guard, (4) the bounded maxEntries cap
// — SCOPED PER-NODE (security-audit hardening, 2026-06-30): the size-cap
// eviction path used to evict the GLOBAL-oldest entry regardless of owning
// node, which is a separate cross-node-poison hole from (2)'s per-node
// absence-evict logic — a single node's oversized beat could evict every
// OTHER node's real liveness entries. Now a node's beat only ever evicts ITS
// OWN oldest entries, once its own share of the map exceeds its fair
// allocation (maxEntries split across the distinct nodes present).

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

  it('is bounded PER-NODE — a single node sending more than maxEntries in one beat self-evicts its OWN oldest (no unbounded growth from one node)', () => {
    const store = new SessionLivenessStore(3);
    store.recordBeat(
      'node-1',
      { agt_1: 'active', agt_2: 'active', agt_3: 'active', agt_4: 'active' },
      1000,
    );
    expect(store.size).toBe(3);
    expect(store.get('agt_1')).toBeNull(); // oldest self-evicted
    expect(store.get('agt_4')).not.toBeNull();
  });

  it('size-cap eviction is SCOPED PER-NODE — a different node’s beat pushing the map past maxEntries must NEVER evict another node’s entries (anti cross-node-poison)', () => {
    const store = new SessionLivenessStore(3);
    store.recordBeat('node-1', { agt_a: 'active', agt_b: 'active', agt_c: 'active' }, 1000);
    expect(store.size).toBe(3);
    // node-2 beats with ONE new session — pushes total past maxEntries, but
    // node-2's own share (1) is within its fair allocation, so NOTHING is
    // evicted from node-1's real sessions (the prior bug: the global-oldest
    // path would have evicted agt_a here even though node-2 owns none of it).
    store.recordBeat('node-2', { agt_z: 'active' }, 1100);
    expect(store.get('agt_a')).not.toBeNull();
    expect(store.get('agt_b')).not.toBeNull();
    expect(store.get('agt_c')).not.toBeNull();
    expect(store.get('agt_z')).not.toBeNull();
    // Over maxEntries — an accepted trade-off: never poison another node's
    // liveness view just to shave the shared map back under its soft cap.
    expect(store.size).toBe(4);
  });

  it('a rogue node fabricating many session ids in one beat is capped to its OWN fair share — self-evicts its own oldest fabrications, never another node’s real entries', () => {
    const store = new SessionLivenessStore(4);
    store.recordBeat('node-1', { agt_a: 'active', agt_b: 'active' }, 1000);
    // node-2 (rogue) reports 4 fabricated sessions in one heartbeat.
    store.recordBeat('node-2', { r1: 'active', r2: 'active', r3: 'active', r4: 'active' }, 1100);
    // node-1's legit entries survive untouched.
    expect(store.get('agt_a')).not.toBeNull();
    expect(store.get('agt_b')).not.toBeNull();
    // node-2's fair share (maxEntries=4 / 2 nodes = 2) self-trims its own
    // oldest fabricated entries rather than growing past its allocation.
    expect(store.get('r1')).toBeNull();
    expect(store.get('r2')).toBeNull();
    expect(store.get('r3')).not.toBeNull();
    expect(store.get('r4')).not.toBeNull();
  });

  it('delete drops a session entry (e.g. on session end)', () => {
    const store = new SessionLivenessStore();
    store.recordBeat('node-1', { agt_a: 'active' }, 1000);
    store.delete('agt_a');
    expect(store.get('agt_a')).toBeNull();
  });
});
