import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/lib/client';
import {
  bucketSessions,
  diffSessionSnapshots,
  subscribeSessionEvents,
} from '../../src/lib/session-events';

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    id: overrides.id,
    account_id: 'acc_test',
    api_key_id: 'key_test',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    status: 'ready',
    purpose: 'production_customer',
    label: null,
    metadata: null,
    created_at: '2026-05-11T00:00:00.000Z',
    updated_at: '2026-05-11T00:00:00.000Z',
    last_state_at: null,
    destroyed_at: null,
    ...overrides,
  };
}

describe('V-534.C diffSessionSnapshots — added', () => {
  it('emits added when a new session appears', () => {
    const next = [makeSession({ id: 'sess_a' })];
    const events = diffSessionSnapshots([], next);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('added');
    expect(events[0]?.sessionId).toBe('sess_a');
  });

  it('emits no events when snapshots are identical', () => {
    const snap = [makeSession({ id: 'sess_a' }), makeSession({ id: 'sess_b' })];
    expect(diffSessionSnapshots(snap, snap)).toEqual([]);
  });
});

describe('V-534.C diffSessionSnapshots — state-changed', () => {
  it('emits state-changed for ready → busy', () => {
    const prev = [makeSession({ id: 'sess_a', status: 'ready' })];
    const next = [makeSession({ id: 'sess_a', status: 'busy' })];
    const events = diffSessionSnapshots(prev, next);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('state-changed');
    expect(events[0]?.previousStatus).toBe('ready');
    expect(events[0]?.session.status).toBe('busy');
  });

  it('does NOT emit state-changed when status is identical', () => {
    const prev = [makeSession({ id: 'sess_a', status: 'ready' })];
    const next = [makeSession({ id: 'sess_a', status: 'ready' })];
    expect(diffSessionSnapshots(prev, next)).toEqual([]);
  });
});

describe('V-534.C diffSessionSnapshots — terminated', () => {
  it('emits terminated when ready → destroyed', () => {
    const prev = [makeSession({ id: 'sess_a', status: 'ready' })];
    const next = [makeSession({ id: 'sess_a', status: 'destroyed' })];
    const events = diffSessionSnapshots(prev, next);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('terminated');
    expect(events[0]?.previousStatus).toBe('ready');
  });

  it('emits terminated when busy → errored', () => {
    const prev = [makeSession({ id: 'sess_a', status: 'busy' })];
    const next = [makeSession({ id: 'sess_a', status: 'errored' })];
    const events = diffSessionSnapshots(prev, next);
    expect(events[0]?.kind).toBe('terminated');
  });

  it('does NOT emit terminated when destroyed → still destroyed', () => {
    const prev = [makeSession({ id: 'sess_a', status: 'destroyed' })];
    const next = [makeSession({ id: 'sess_a', status: 'destroyed' })];
    expect(diffSessionSnapshots(prev, next)).toEqual([]);
  });
});

describe('V-534.C diffSessionSnapshots — removed', () => {
  it('emits removed when a session is no longer in the snapshot', () => {
    const prev = [makeSession({ id: 'sess_a' })];
    const next: Session[] = [];
    const events = diffSessionSnapshots(prev, next);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('removed');
    expect(events[0]?.session.id).toBe('sess_a');
  });
});

describe('V-534.C diffSessionSnapshots — ordering', () => {
  it('events are sorted by sessionId', () => {
    const prev: Session[] = [];
    const next = [
      makeSession({ id: 'sess_z' }),
      makeSession({ id: 'sess_a' }),
      makeSession({ id: 'sess_m' }),
    ];
    const events = diffSessionSnapshots(prev, next);
    expect(events.map((e) => e.sessionId)).toEqual(['sess_a', 'sess_m', 'sess_z']);
  });

  it('mixed event kinds in one diff', () => {
    const prev = [
      makeSession({ id: 'sess_a', status: 'ready' }),
      makeSession({ id: 'sess_b', status: 'busy' }),
    ];
    const next = [
      makeSession({ id: 'sess_a', status: 'destroyed' }), // terminated
      makeSession({ id: 'sess_c', status: 'creating' }), // added
      // sess_b removed
    ];
    const events = diffSessionSnapshots(prev, next);
    const kinds = events.map((e) => ({ id: e.sessionId, kind: e.kind }));
    expect(kinds).toEqual([
      { id: 'sess_a', kind: 'terminated' },
      { id: 'sess_b', kind: 'removed' },
      { id: 'sess_c', kind: 'added' },
    ]);
  });
});

describe('V-534.C bucketSessions', () => {
  it('puts ready + busy into active', () => {
    const b = bucketSessions([
      makeSession({ id: 'a', status: 'ready' }),
      makeSession({ id: 'b', status: 'busy' }),
    ]);
    expect(b.active.map((s) => s.id)).toEqual(['a', 'b']);
    expect(b.pending).toEqual([]);
    expect(b.terminated).toEqual([]);
  });

  it('puts creating into pending', () => {
    const b = bucketSessions([makeSession({ id: 'a', status: 'creating' })]);
    expect(b.pending.map((s) => s.id)).toEqual(['a']);
    expect(b.active).toEqual([]);
  });

  it('puts destroyed + errored into terminated', () => {
    const b = bucketSessions([
      makeSession({ id: 'a', status: 'destroyed' }),
      makeSession({ id: 'b', status: 'errored' }),
    ]);
    expect(b.terminated.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('V-534.C subscribeSessionEvents', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onEvents with the initial-load events', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValueOnce([makeSession({ id: 'sess_a' })]);
    const onEvents = vi.fn();
    const unsubscribe = subscribeSessionEvents({
      fetchSnapshot,
      onEvents,
      intervalMs: 1000,
    });
    await vi.runOnlyPendingTimersAsync();
    expect(onEvents).toHaveBeenCalledTimes(1);
    expect(onEvents.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ kind: 'added', sessionId: 'sess_a' }),
    ]);
    unsubscribe();
  });

  it('detects state changes across successive snapshots', async () => {
    const fetchSnapshot = vi
      .fn()
      .mockResolvedValueOnce([makeSession({ id: 'sess_a', status: 'ready' })])
      .mockResolvedValueOnce([makeSession({ id: 'sess_a', status: 'busy' })]);
    const onEvents = vi.fn();
    const unsubscribe = subscribeSessionEvents({
      fetchSnapshot,
      onEvents,
      intervalMs: 100,
    });
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(100);
    await vi.runOnlyPendingTimersAsync();
    expect(onEvents).toHaveBeenCalledTimes(2);
    const secondCall = onEvents.mock.calls[1]?.[0] as
      | ReadonlyArray<{ kind: string; previousStatus?: string }>
      | undefined;
    expect(secondCall?.[0]?.kind).toBe('state-changed');
    expect(secondCall?.[0]?.previousStatus).toBe('ready');
    unsubscribe();
  });

  it('unsubscribe stops the polling loop', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue([makeSession({ id: 'sess_a' })]);
    const onEvents = vi.fn();
    const unsubscribe = subscribeSessionEvents({
      fetchSnapshot,
      onEvents,
      intervalMs: 1000,
    });
    await vi.runOnlyPendingTimersAsync();
    unsubscribe();
    const callsBeforeAdvance = fetchSnapshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSnapshot.mock.calls.length).toBe(callsBeforeAdvance);
  });

  it('onError fires when fetchSnapshot throws; loop continues', async () => {
    const fetchSnapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([makeSession({ id: 'sess_a' })]);
    const onEvents = vi.fn();
    const onError = vi.fn();
    const unsubscribe = subscribeSessionEvents({
      fetchSnapshot,
      onEvents,
      onError,
      intervalMs: 100,
    });
    await vi.runOnlyPendingTimersAsync();
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    await vi.runOnlyPendingTimersAsync();
    expect(onEvents).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
