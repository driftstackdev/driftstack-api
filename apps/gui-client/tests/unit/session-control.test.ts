// V-534.D — unit tests for the session control surface.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/lib/client';
import { createSessionController, type ControllerState } from '../../src/lib/session-control';

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

describe('V-534.D session controller — subscribe + initial state', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires listener with empty state on subscribe', () => {
    const ctrl = createSessionController({
      fetchSnapshot: vi.fn().mockResolvedValue([]),
      destroySession: vi.fn().mockResolvedValue(undefined),
      intervalMs: 1000,
    });
    const listener = vi.fn<(s: ControllerState) => void>();
    ctrl.subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]?.sessions).toEqual([]);
    ctrl.stop();
  });

  it('populates state after the first poll completes', async () => {
    const fetchSnapshot = vi
      .fn()
      .mockResolvedValueOnce([makeSession({ id: 'sess_a', status: 'ready' })]);
    const ctrl = createSessionController({
      fetchSnapshot,
      destroySession: vi.fn().mockResolvedValue(undefined),
      intervalMs: 1000,
    });
    const listener = vi.fn();
    ctrl.subscribe(listener);
    await vi.runOnlyPendingTimersAsync();
    const lastState = listener.mock.calls.at(-1)?.[0] as ReturnType<typeof ctrl.getState>;
    expect(lastState.sessions).toHaveLength(1);
    expect(lastState.buckets.active).toHaveLength(1);
    ctrl.stop();
  });
});

describe('V-534.D session controller — destroy', () => {
  it('marks the session as destroying optimistically, then clears on next poll terminal', async () => {
    let snapshotResponse: Session[] = [makeSession({ id: 'sess_a', status: 'ready' })];
    // eslint-disable-next-line @typescript-eslint/require-await
    const fetchSnapshot = vi.fn(async () => snapshotResponse);
    const destroySession = vi.fn().mockResolvedValue(undefined);
    // Long interval — the test drives state via refresh(), not the timer.
    const ctrl = createSessionController({ fetchSnapshot, destroySession, intervalMs: 100_000 });
    ctrl.subscribe(vi.fn());
    await ctrl.refresh(); // ensure initial snapshot is loaded
    await ctrl.destroy('sess_a');
    expect(ctrl.getState().destroying.has('sess_a')).toBe(true);
    expect(destroySession).toHaveBeenCalledWith('sess_a');
    // Simulate server-side destroy completion landing in the next poll.
    snapshotResponse = [makeSession({ id: 'sess_a', status: 'destroyed' })];
    await ctrl.refresh();
    expect(ctrl.getState().destroying.has('sess_a')).toBe(false);
    expect(ctrl.getState().buckets.terminated).toHaveLength(1);
    ctrl.stop();
  });

  it('records lastError + clears destroying flag when the destroy API call throws', async () => {
    const fetchSnapshot = vi.fn(() =>
      Promise.resolve([makeSession({ id: 'sess_a', status: 'ready' as const })]),
    );
    const destroyErr = new Error('forbidden');
    const destroySession = vi.fn().mockRejectedValue(destroyErr);
    const ctrl = createSessionController({ fetchSnapshot, destroySession, intervalMs: 100_000 });
    ctrl.subscribe(vi.fn());
    await ctrl.refresh();
    await expect(ctrl.destroy('sess_a')).rejects.toThrow('forbidden');
    expect(ctrl.getState().destroying.has('sess_a')).toBe(false);
    expect(ctrl.getState().lastError?.kind).toBe('destroy');
    expect(ctrl.getState().lastError?.sessionId).toBe('sess_a');
    ctrl.stop();
  });
});

describe('V-534.D session controller — refresh', () => {
  it('imperative refresh re-pulls snapshot independent of the timer', async () => {
    let snapshotResponse: Session[] = [makeSession({ id: 'sess_a' })];
    // eslint-disable-next-line @typescript-eslint/require-await
    const fetchSnapshot = vi.fn(async () => snapshotResponse);
    const ctrl = createSessionController({
      fetchSnapshot,
      destroySession: vi.fn().mockResolvedValue(undefined),
      intervalMs: 100_000,
    });
    ctrl.subscribe(vi.fn());
    await ctrl.refresh();
    expect(ctrl.getState().sessions).toHaveLength(1);
    snapshotResponse = [makeSession({ id: 'sess_a' }), makeSession({ id: 'sess_b' })];
    await ctrl.refresh();
    expect(ctrl.getState().sessions).toHaveLength(2);
    ctrl.stop();
  });

  it('refresh records lastError on fetch failure but keeps prior sessions intact', async () => {
    const fetchSnapshot = vi
      .fn()
      .mockResolvedValueOnce([makeSession({ id: 'sess_a' })])
      .mockRejectedValueOnce(new Error('network'));
    const ctrl = createSessionController({
      fetchSnapshot,
      destroySession: vi.fn().mockResolvedValue(undefined),
      intervalMs: 100_000,
    });
    ctrl.subscribe(vi.fn());
    await ctrl.refresh();
    await ctrl.refresh(); // second call → network error
    expect(ctrl.getState().sessions).toHaveLength(1);
    expect(ctrl.getState().lastError?.kind).toBe('fetch');
    ctrl.stop();
  });
});

describe('V-534.D session controller — stop', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stop() halts the polling loop', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue([]);
    const ctrl = createSessionController({
      fetchSnapshot,
      destroySession: vi.fn().mockResolvedValue(undefined),
      intervalMs: 100,
    });
    ctrl.subscribe(vi.fn());
    await vi.runOnlyPendingTimersAsync();
    ctrl.stop();
    const callsBefore = fetchSnapshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSnapshot.mock.calls.length).toBe(callsBefore);
  });
});
