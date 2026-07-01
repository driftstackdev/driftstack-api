// 2026-06-30 — recovery path for the GUI notification stream.
//
// The bounded subscriber (notifications.ts) deliberately gives up after a run
// of consecutive errors and latches 'closed'. Before this, useNotifications
// only (re)opened the stream inside an effect keyed on settings.apiKey/baseUrl,
// so once it latched 'closed' there was NO working way back: opening Settings
// or re-saving the SAME key doesn't change those deps, React bails, and the
// stream stays dead for the rest of the app session. These tests pin the fix:
//   • reconnect() forces a fresh subscription without changing settings;
//   • a network 'online' event self-heals;
//   • a tab becoming visible self-heals.
// Each must tear down the dead source and open exactly one new one.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mutable settings the mocked context returns; tests mutate before render.
const settingsState = { apiKey: 'dk_live_test' as string | null, baseUrl: 'https://api.example' };
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ settings: settingsState }),
}));

// Capture each subscribe call so we can assert open/close counts + drive the
// connection state (via the onState callback) the same way the real stream does.
const subscribeCalls: Array<{
  close: ReturnType<typeof vi.fn>;
  onState?: (s: string) => void;
}> = [];
vi.mock('../../src/lib/notifications', () => ({
  subscribeNotifications: vi.fn((opts: { onState?: (s: string) => void }) => {
    const close = vi.fn();
    subscribeCalls.push({ close, onState: opts.onState });
    return close;
  }),
}));

const { useNotifications } = await import('../../src/lib/use-notifications');

beforeEach(() => {
  subscribeCalls.length = 0;
  settingsState.apiKey = 'dk_live_test';
  settingsState.baseUrl = 'https://api.example';
});

describe('useNotifications recovery', () => {
  it('opens exactly one subscription on mount when signed in', () => {
    renderHook(() => useNotifications());
    expect(subscribeCalls).toHaveLength(1);
  });

  it('reconnect() tears down the current source and opens a fresh one WITHOUT a settings change', () => {
    const { result } = renderHook(() => useNotifications());
    expect(subscribeCalls).toHaveLength(1);
    const first = subscribeCalls[0];
    if (!first) throw new Error('expected a first subscription');

    act(() => {
      result.current.reconnect();
    });

    // The old (latched-closed) source is torn down…
    expect(first.close).toHaveBeenCalledTimes(1);
    // …and exactly one fresh subscription replaces it — the real recovery path.
    expect(subscribeCalls).toHaveLength(2);
  });

  it("a network 'online' event self-heals a CLOSED stream", () => {
    renderHook(() => useNotifications());
    expect(subscribeCalls).toHaveLength(1);
    // Drive the stream to the terminal 'closed' state (as the bounded
    // subscriber does after a run of errors), THEN come back online.
    act(() => subscribeCalls[0]?.onState?.('closed'));
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(subscribeCalls).toHaveLength(2);
  });

  it('a tab becoming visible self-heals a CLOSED stream', () => {
    renderHook(() => useNotifications());
    expect(subscribeCalls).toHaveLength(1);
    act(() => subscribeCalls[0]?.onState?.('closed'));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(subscribeCalls).toHaveLength(2);
  });

  it('does NOT tear down a HEALTHY (open) stream on online / visibility', () => {
    renderHook(() => useNotifications());
    expect(subscribeCalls).toHaveLength(1);
    act(() => subscribeCalls[0]?.onState?.('open'));
    act(() => {
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // Still one subscription — a live stream is not needlessly reopened
    // (which flickered + dropped events on every tab refocus).
    expect(subscribeCalls).toHaveLength(1);
  });

  it('does not subscribe when signed out (no api key)', () => {
    settingsState.apiKey = null;
    renderHook(() => useNotifications());
    expect(subscribeCalls).toHaveLength(0);
  });

  it('reconnect() is inert while disabled (no stream to revive)', () => {
    const { result } = renderHook(() => useNotifications({ disabled: true }));
    expect(subscribeCalls).toHaveLength(0);
    act(() => {
      result.current.reconnect();
    });
    expect(subscribeCalls).toHaveLength(0);
  });
});
