// Regression (sweep2): a recording whose disk write FAILS on Stop must NOT be
// swallowed silently. The provider used to keep it in-memory (the list still
// showed a "Saved" pill) while it would vanish on the next app launch — the user
// believed their capture was safe. Now Stop surfaces the failure via the context
// `persistError` AND a window CustomEvent so a toast can warn the user.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';

const persistRecording = vi.fn();
const loadIndex = vi.fn();
const loadFrames = vi.fn();
const deletePersisted = vi.fn();

vi.mock('../../src/lib/recordings-store', () => ({
  persistRecording,
  loadIndex,
  loadFrames,
  deletePersisted,
}));

const { RecordingsProvider, useRecordings, RECORDING_PERSIST_FAILED_EVENT } =
  await import('../../src/lib/recordings');

function wrapper({ children }: { children: ReactNode }): JSX.Element {
  return <RecordingsProvider>{children}</RecordingsProvider>;
}

describe('RecordingsProvider — persist-failure surfacing', () => {
  beforeEach(() => {
    persistRecording.mockReset();
    loadIndex.mockReset().mockResolvedValue([]);
    loadFrames.mockReset().mockResolvedValue([]);
    deletePersisted.mockReset().mockResolvedValue(undefined);
  });

  it('sets persistError + fires the window event when the Stop write fails', async () => {
    persistRecording.mockRejectedValue(new Error('disk full'));
    const events: Array<{ id: string; sessionId: string }> = [];
    const onEvt = (e: Event): void => {
      events.push((e as CustomEvent).detail as { id: string; sessionId: string });
    };
    window.addEventListener(RECORDING_PERSIST_FAILED_EVENT, onEvt);

    const { result } = renderHook(() => useRecordings(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let id = '';
    act(() => {
      id = result.current.startRecording('ses_x', 'Checkout');
    });
    act(() => {
      result.current.addFrame(id, { at: 1, dataUrl: 'data:,', bytes: 10 });
    });
    await act(async () => {
      await result.current.stopRecording(id);
    });

    // Context state surfaced.
    expect(result.current.persistError).not.toBeNull();
    expect(result.current.persistError?.id).toBe(id);
    expect(result.current.persistError?.sessionId).toBe('ses_x');
    expect(result.current.persistError?.label).toBe('Checkout');
    // Window event fired for the global toast bridge.
    expect(events).toHaveLength(1);
    expect(events[0]?.sessionId).toBe('ses_x');

    // Dismiss clears it.
    act(() => {
      result.current.clearPersistError();
    });
    expect(result.current.persistError).toBeNull();

    window.removeEventListener(RECORDING_PERSIST_FAILED_EVENT, onEvt);
  });

  it('leaves persistError null on a successful Stop write', async () => {
    persistRecording.mockResolvedValue({});
    const { result } = renderHook(() => useRecordings(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let id = '';
    act(() => {
      id = result.current.startRecording('ses_ok');
    });
    act(() => {
      result.current.addFrame(id, { at: 1, dataUrl: 'data:,', bytes: 5 });
    });
    await act(async () => {
      await result.current.stopRecording(id);
    });

    expect(persistRecording).toHaveBeenCalledTimes(1);
    expect(result.current.persistError).toBeNull();
  });
});
