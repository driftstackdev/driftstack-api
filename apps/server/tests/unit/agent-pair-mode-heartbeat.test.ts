// Arc 4 Wave 2.B sub-slice 8.13b (v2-#8) — heartbeat tracker tests.

import { describe, expect, it } from 'vitest';
import {
  InMemoryPairModeHeartbeatTracker,
  PAIR_MODE_HEARTBEAT_TTL_MS,
} from '../../src/services/agent-pair-mode-heartbeat.js';

const T0 = new Date('2026-05-18T12:00:00Z');
const T_PLUS_29S = new Date(T0.getTime() + 29_000);
const T_PLUS_30S = new Date(T0.getTime() + 30_000);
const T_PLUS_31S = new Date(T0.getTime() + 31_000);

describe('Arc 4 Wave 2.B sub-slice 8.13b InMemoryPairModeHeartbeatTracker', () => {
  it('recordHeartbeat stores the timestamp; getLastHeartbeatAt round-trips', () => {
    const t = new InMemoryPairModeHeartbeatTracker();
    t.recordHeartbeat({ sessionId: 'agt_x', at: T0 });
    expect(t.getLastHeartbeatAt('agt_x')).toEqual(T0);
  });

  it('getLastHeartbeatAt returns null for unknown sessions', () => {
    const t = new InMemoryPairModeHeartbeatTracker();
    expect(t.getLastHeartbeatAt('agt_unknown')).toBeNull();
  });

  it('recordHeartbeat is idempotent — second call overwrites the timestamp', () => {
    const t = new InMemoryPairModeHeartbeatTracker();
    t.recordHeartbeat({ sessionId: 'agt_x', at: T0 });
    t.recordHeartbeat({ sessionId: 'agt_x', at: T_PLUS_29S });
    expect(t.getLastHeartbeatAt('agt_x')).toEqual(T_PLUS_29S);
  });

  it('forget removes the session entry', () => {
    const t = new InMemoryPairModeHeartbeatTracker();
    t.recordHeartbeat({ sessionId: 'agt_x', at: T0 });
    t.forget('agt_x');
    expect(t.getLastHeartbeatAt('agt_x')).toBeNull();
  });

  it('forget on an unknown session is a no-op (does not throw)', () => {
    const t = new InMemoryPairModeHeartbeatTracker();
    expect(() => t.forget('agt_unknown')).not.toThrow();
  });

  it('findStaleSessions returns empty when no sessions exist', () => {
    const t = new InMemoryPairModeHeartbeatTracker();
    expect(t.findStaleSessions({ now: T_PLUS_30S, ttlMs: 30_000 })).toEqual([]);
  });

  it('findStaleSessions returns empty when all heartbeats are within ttl', () => {
    const t = new InMemoryPairModeHeartbeatTracker();
    t.recordHeartbeat({ sessionId: 'agt_a', at: T0 });
    t.recordHeartbeat({ sessionId: 'agt_b', at: T_PLUS_29S });
    // now = T_PLUS_29S, ttl = 30s → cutoff = T0 - 1s; only beats
    // older than T0 - 1s are stale. agt_a is at T0 (newer than
    // cutoff) so it is NOT stale yet.
    expect(t.findStaleSessions({ now: T_PLUS_29S, ttlMs: 30_000 })).toEqual([]);
  });

  it('findStaleSessions flags exactly the sessions whose heartbeat is older than now-ttlMs', () => {
    const t = new InMemoryPairModeHeartbeatTracker();
    t.recordHeartbeat({ sessionId: 'agt_stale', at: T0 });
    t.recordHeartbeat({ sessionId: 'agt_fresh', at: T_PLUS_29S });
    // now = T0 + 31s; cutoff = T0 + 1s. agt_stale (at T0) is < cutoff → stale.
    // agt_fresh (at T0 + 29s) is >= cutoff → fresh.
    expect(t.findStaleSessions({ now: T_PLUS_31S, ttlMs: 30_000 })).toEqual(['agt_stale']);
  });

  it('findStaleSessions sorts oldest-first so the sweep handles the most-stuck sessions first', () => {
    const t = new InMemoryPairModeHeartbeatTracker();
    t.recordHeartbeat({ sessionId: 'agt_middle', at: new Date(T0.getTime() + 5_000) });
    t.recordHeartbeat({ sessionId: 'agt_oldest', at: T0 });
    t.recordHeartbeat({ sessionId: 'agt_newer', at: new Date(T0.getTime() + 10_000) });
    // All three are well past a 1s ttl from T0 + 60s.
    const now = new Date(T0.getTime() + 60_000);
    expect(t.findStaleSessions({ now, ttlMs: 1_000 })).toEqual([
      'agt_oldest',
      'agt_middle',
      'agt_newer',
    ]);
  });

  it('PAIR_MODE_HEARTBEAT_TTL_MS is 30 seconds (matches the 8.13 founder verdict)', () => {
    expect(PAIR_MODE_HEARTBEAT_TTL_MS).toBe(30_000);
  });

  it('findStaleSessions with the production ttl constant flags a 31s-old heartbeat as stale', () => {
    const t = new InMemoryPairModeHeartbeatTracker();
    t.recordHeartbeat({ sessionId: 'agt_x', at: T0 });
    const stale = t.findStaleSessions({
      now: T_PLUS_31S,
      ttlMs: PAIR_MODE_HEARTBEAT_TTL_MS,
    });
    expect(stale).toEqual(['agt_x']);
  });

  it('findStaleSessions with the production ttl constant does NOT flag a 29s-old heartbeat as stale', () => {
    const t = new InMemoryPairModeHeartbeatTracker();
    t.recordHeartbeat({ sessionId: 'agt_x', at: T0 });
    const stale = t.findStaleSessions({
      now: T_PLUS_29S,
      ttlMs: PAIR_MODE_HEARTBEAT_TTL_MS,
    });
    expect(stale).toEqual([]);
  });
});
