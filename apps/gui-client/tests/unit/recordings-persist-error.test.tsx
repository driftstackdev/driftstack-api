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

  it('deleteRecording returns false and RESTORES the row when the disk delete fails', async () => {
    // Seed one persisted recording the index hydrates on mount.
    loadIndex.mockResolvedValue([
      {
        id: 'rec_1',
        sessionId: 'ses_1',
        label: null,
        startedAt: 1,
        endedAt: 2,
        totalCaptured: 1,
        frameCount: 1,
        totalBytes: 10,
      },
    ]);
    deletePersisted.mockRejectedValue(new Error('file locked'));

    const { result } = renderHook(() => useRecordings(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.recordings.has('rec_1')).toBe(true);

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.deleteRecording('rec_1');
    });

    // Reports the failure…
    expect(ok).toBe(false);
    // …and the row is back (it's still on disk; the UI must not lie).
    expect(result.current.recordings.has('rec_1')).toBe(true);
  });

  it('deleteRecording returns true and removes the row on a successful disk delete', async () => {
    loadIndex.mockResolvedValue([
      {
        id: 'rec_2',
        sessionId: 'ses_2',
        label: null,
        startedAt: 1,
        endedAt: 2,
        totalCaptured: 1,
        frameCount: 1,
        totalBytes: 10,
      },
    ]);
    deletePersisted.mockResolvedValue(undefined);

    const { result } = renderHook(() => useRecordings(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.recordings.has('rec_2')).toBe(true);

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.deleteRecording('rec_2');
    });

    expect(ok).toBe(true);
    expect(result.current.recordings.has('rec_2')).toBe(false);
  });

  it('hydrateFrames REJECTS when the on-disk read fails (player can show retry, not "no frames")', async () => {
    // A persisted recording with frames on disk, hydrated into the list on mount.
    loadIndex.mockResolvedValue([
      {
        id: 'rec_h',
        sessionId: 'ses_h',
        label: null,
        startedAt: 1,
        endedAt: 2,
        totalCaptured: 3,
        frameCount: 3,
        totalBytes: 30,
      },
    ]);
    // The disk read throws (corrupt/locked ndjson, perms).
    loadFrames.mockRejectedValue(new Error('EACCES: permission denied'));

    const { result } = renderHook(() => useRecordings(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // The failure must PROPAGATE — previously it was swallowed (resolved with a
    // 0-frame recording) so the player read "No frames captured" / Export said
    // "Nothing to export" even though the frames exist on disk.
    await expect(result.current.hydrateFrames('rec_h')).rejects.toThrow(/permission denied/);
  });

  it('refreshes the list on window focus so a recording made in another window appears', async () => {
    // Mount with an empty index (the simulator made a recording AFTER this
    // window mounted — separate provider, separate in-memory Map).
    loadIndex.mockResolvedValue([]);
    const { result } = renderHook(() => useRecordings(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.recordings.size).toBe(0);

    // A new recording lands on disk; the next focus must surface it without a restart.
    loadIndex.mockResolvedValue([
      {
        id: 'rec_new',
        sessionId: 'ses_new',
        label: 'From simulator',
        startedAt: 5,
        endedAt: 6,
        totalCaptured: 2,
        frameCount: 2,
        totalBytes: 20,
      },
    ]);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.recordings.has('rec_new')).toBe(true));
    expect(result.current.recordings.get('rec_new')?.label).toBe('From simulator');
  });

  it('a focus refresh keeps a still-LIVE recording the on-disk index cannot know about', async () => {
    loadIndex.mockResolvedValue([]);
    const { result } = renderHook(() => useRecordings(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let liveId = '';
    act(() => {
      liveId = result.current.startRecording('ses_live', 'Live');
    });
    expect(result.current.recordings.has(liveId)).toBe(true);

    // Focus re-reads the (still empty) index — the un-persisted live recording
    // must survive the merge, not get wiped.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(result.current.recordings.has(liveId)).toBe(true);
    expect(result.current.recordings.get(liveId)?.endedAt).toBeNull();
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
