// Session recordings — in-memory state + ndjson disk persistence.
//
// Persistence model (V-040): write on STOP, lazy-load frames when a
// recording is opened for playback. The recordings index file
// (`$APPDATA/recordings/index.json`) hydrates on app start so the
// list view shows persisted recordings without buffering frames.
// Active recordings are auto-finalised + persisted on provider
// unmount (app close).
//
// Memory ceiling: each recording caps frames at MAX_FRAMES_PER_RECORDING
// to prevent runaway sessions from eating GB of RAM. At 2 fps + ~150 KB
// per frame, 1200 frames = ~10 minutes = ~180 MB upper bound. When the
// cap is hit, oldest frames are dropped (ring buffer semantics).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import {
  deletePersisted,
  loadFrames,
  loadIndex,
  persistRecording,
  type RecordingHeader,
} from './recordings-store';

const MAX_FRAMES_PER_RECORDING = 1200;

export interface RecordingFrame {
  at: number; // epoch ms
  dataUrl: string;
  bytes: number;
}

export interface Recording {
  id: string;
  sessionId: string;
  label: string | null;
  startedAt: number;
  endedAt: number | null; // null while still recording
  frames: RecordingFrame[];
  /** Total frames captured (including any dropped from the front when capped). */
  totalCaptured: number;
  /** Persisted-but-frames-not-loaded marker. Set on hydrated index entries; cleared once loadFrames has populated `frames`. Live recordings are always false. */
  hydrated: boolean;
  /** Cached frameCount from the persisted header — survives even when frames haven't been hydrated yet. */
  frameCount: number;
  /** Cached totalBytes from the persisted header — same lifetime as frameCount. */
  totalBytes: number;
}

/** The recording that failed to write to disk on Stop. Surfaced (toast) so the
 *  user knows the capture is in-memory only and will be lost on app close —
 *  rather than the old behaviour of silently swallowing the failure while the
 *  list still showed a "Saved" pill. */
export interface RecordingPersistError {
  id: string;
  sessionId: string;
  label: string | null;
  /** Distinguishes repeated failures of the same recording so a consumer effect
   *  re-fires (a plain id wouldn't change). */
  at: number;
}

/** Window CustomEvent name fired alongside the context `persistError` state so a
 *  global toast bridge can surface it even from a window with no Toast provider
 *  above the RecordingsProvider (the simulator window). */
export const RECORDING_PERSIST_FAILED_EVENT = 'driftstack:recording-persist-failed';

interface RecordingsContextValue {
  recordings: Map<string, Recording>;
  /** Recording ids actively recording. */
  activeIds: Set<string>;
  /** True until loadIndex has resolved on mount. */
  loading: boolean;
  startRecording: (sessionId: string, label?: string) => string;
  stopRecording: (id: string) => Promise<Recording | null>;
  addFrame: (id: string, frame: RecordingFrame) => void;
  /** Delete a recording from memory + disk. Resolves true on success; false if
   *  the on-disk delete failed (the row is restored so the UI matches reality). */
  deleteRecording: (id: string) => Promise<boolean>;
  /** Lazy-load frames for a persisted recording. Resolves with the populated
   *  Recording. REJECTS when the on-disk read fails (corrupt/locked ndjson,
   *  perms) so the caller can surface a real error + retry instead of treating
   *  the recording as empty. */
  hydrateFrames: (id: string) => Promise<Recording | null>;
  /** Convenience: the recording id that is currently active for a given session, if any. */
  activeRecordingFor: (sessionId: string) => string | null;
  /** The most recent recording whose disk write FAILED on Stop (null = none).
   *  A view watches this to warn the user the capture is memory-only. */
  persistError: RecordingPersistError | null;
  /** Acknowledge/dismiss the current persistError (after surfacing it). */
  clearPersistError: () => void;
}

const RecordingsCtx = createContext<RecordingsContextValue | null>(null);

export function RecordingsProvider({ children }: { children: ReactNode }): JSX.Element {
  // Single state slot; mutations replace the Map ref so React re-renders.
  const [recordings, setRecordings] = useState<Map<string, Recording>>(() => new Map());
  const [loading, setLoading] = useState(true);
  // Set when a Stop-time disk write fails — surfaced (toast) so the user knows
  // the recording is in-memory only and won't survive an app restart.
  const [persistError, setPersistError] = useState<RecordingPersistError | null>(null);
  // Latest recordings ref for the unmount-flush effect.
  const recordingsRef = useRef(recordings);
  recordingsRef.current = recordings;

  // Re-read the on-disk index and merge it into state. Used both on mount and
  // when the window regains focus/visibility. The merge preserves anything live
  // in THIS provider that the index can't represent:
  //   • live (still-recording) entries — not yet persisted, must survive a refresh,
  //   • frame-loaded entries — keep the in-memory frames rather than reverting to
  //     a header-only stub (which would force a re-hydrate / blank the player).
  const refreshIndex = useCallback(async (): Promise<void> => {
    const index = await loadIndex();
    setRecordings((prev) => {
      const next = new Map<string, Recording>();
      for (const h of index) {
        const existing = prev.get(h.id);
        // Keep an already-frame-loaded copy (hydrated===false marks frames loaded)
        // so opening it again doesn't re-read the disk / flash empty. Includes
        // loaded-but-EMPTY recordings (0 captured frames) — without this a
        // zero-frame recording reverts to a hydrated:true/frames:[] stub and the
        // player effect re-fires loadFrames on every window focus (audit #16).
        if (existing && !existing.hydrated) {
          next.set(h.id, existing);
        } else {
          next.set(h.id, headerToRecording(h));
        }
      }
      // Re-add any live, not-yet-persisted recordings the index can't know about.
      for (const r of prev.values()) {
        if (r.endedAt === null && !next.has(r.id)) next.set(r.id, r);
      }
      return next;
    });
  }, []);

  // Hydrate index on mount.
  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const index = await loadIndex();
        if (cancelled) return;
        const map = new Map<string, Recording>();
        for (const h of index) {
          map.set(h.id, headerToRecording(h));
        }
        setRecordings(map);
      } catch {
        // Disk-load failed — fall back to empty (e.g. fresh install or perm denied).
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Refresh the list when the window regains focus / becomes visible. Recordings
  // are CREATED in the simulator window but VIEWED in the main window — separate
  // RecordingsProvider instances with separate in-memory Maps, each backed by the
  // same on-disk index. Without this re-read, the main window's Recordings list
  // is hydrated once on mount and NEVER updates: a session recorded in the
  // simulator never appears (and a deletion in one window lingers in the other)
  // until a full app restart.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onActive = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refreshIndex().catch(() => {
        // Transient disk-read failure — keep the current view; next focus retries.
      });
    };
    window.addEventListener('focus', onActive);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onActive);
    }
    return () => {
      window.removeEventListener('focus', onActive);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onActive);
      }
    };
  }, [refreshIndex]);

  // Auto-flush any active recordings on unmount (app close).
  useEffect(() => {
    return () => {
      const cur = recordingsRef.current;
      for (const rec of cur.values()) {
        if (rec.endedAt === null && !rec.hydrated && rec.frames.length > 0) {
          // Fire-and-forget; the React tree is tearing down so we
          // can't await. Tauri's fs plugin queues these through IPC.
          void persistRecording({ ...rec, endedAt: Date.now() }).catch(() => {
            // Last-chance write; nothing to surface.
          });
        }
      }
    };
  }, []);

  const startRecording = useCallback((sessionId: string, label?: string): string => {
    const id = mintId();
    const rec: Recording = {
      id,
      sessionId,
      label: label ?? null,
      startedAt: Date.now(),
      endedAt: null,
      frames: [],
      totalCaptured: 0,
      hydrated: false,
      frameCount: 0,
      totalBytes: 0,
    };
    setRecordings((prev) => {
      const next = new Map(prev);
      next.set(id, rec);
      return next;
    });
    return id;
  }, []);

  const stopRecording = useCallback(async (id: string): Promise<Recording | null> => {
    // Compute the finalised recording DETERMINISTICALLY from the latest committed
    // state (the ref) rather than reading a `let` assigned inside the setState
    // updater — that updater can run lazily, so the closure read could see the
    // pre-update value and skip the persist entirely.
    const cur = recordingsRef.current.get(id);
    const finalized: Recording | null =
      !cur || cur.endedAt !== null
        ? null
        : {
            ...cur,
            endedAt: Date.now(),
            frameCount: cur.frames.length,
            totalBytes: cur.frames.reduce((acc, f) => acc + f.bytes, 0),
          };
    if (finalized !== null) {
      const stopped = finalized;
      setRecordings((prev) => {
        const c = prev.get(id);
        if (!c || c.endedAt !== null) return prev;
        const next = new Map(prev);
        next.set(id, stopped);
        return next;
      });
    }
    if (finalized !== null) {
      try {
        await persistRecording(finalized);
      } catch {
        // Persist failure leaves the recording in memory only — on app restart
        // it's lost (RecordingsProvider only hydrates from disk). Previously
        // swallowed silently while the list still showed a "Saved" pill, so the
        // user believed their capture was safe. Surface it: set the context
        // `persistError` (a view warns the user) AND fire a window event so a
        // global toast bridge can warn even from a window with no Toast provider
        // above this one (the simulator window).
        const err: RecordingPersistError = {
          id: finalized.id,
          sessionId: finalized.sessionId,
          label: finalized.label,
          at: Date.now(),
        };
        setPersistError(err);
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          try {
            window.dispatchEvent(new CustomEvent(RECORDING_PERSIST_FAILED_EVENT, { detail: err }));
          } catch {
            // CustomEvent unsupported (very old/headless) — context state still set.
          }
        }
      }
    }
    return finalized;
  }, []);

  const clearPersistError = useCallback((): void => {
    setPersistError(null);
  }, []);

  const addFrame = useCallback((id: string, frame: RecordingFrame): void => {
    setRecordings((prev) => {
      const cur = prev.get(id);
      if (!cur || cur.endedAt !== null) return prev;
      const frames = [...cur.frames, frame];
      while (frames.length > MAX_FRAMES_PER_RECORDING) frames.shift();
      const next = new Map(prev);
      next.set(id, {
        ...cur,
        frames,
        totalCaptured: cur.totalCaptured + 1,
      });
      return next;
    });
  }, []);

  // Returns true when the on-disk delete succeeded, false when it failed (the
  // row is RE-INSERTED so the UI matches reality — the recording is still on
  // disk and would otherwise reappear after a restart, looking like data
  // resurrection). Callers can surface the false to the user.
  const deleteRecording = useCallback(async (id: string): Promise<boolean> => {
    // Capture the row so we can restore it if the disk delete fails.
    const removed = recordingsRef.current.get(id);
    setRecordings((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    try {
      await deletePersisted(id);
      return true;
    } catch (err) {
      // The disk delete failed (file locked by the other window, perms, fs-scope).
      // Optimistically removing the row would lie: on restart loadIndex re-hydrates
      // the still-on-disk recording and it returns from the dead. Re-insert it so
      // the UI reflects what's actually on disk, and report the failure.
      console.warn('[recordings] disk delete failed; restoring row:', err);
      if (removed !== undefined) {
        setRecordings((prev) => {
          if (prev.has(id)) return prev; // a concurrent re-add already restored it
          const next = new Map(prev);
          next.set(id, removed);
          return next;
        });
      }
      return false;
    }
  }, []);

  const hydrateFrames = useCallback(async (id: string): Promise<Recording | null> => {
    const cur = recordingsRef.current.get(id);
    if (!cur) return null;
    if (!cur.hydrated || cur.frames.length > 0) return cur;
    try {
      const frames = await loadFrames(id);
      let updated: Recording | null = null;
      setRecordings((prev) => {
        const c = prev.get(id);
        if (!c) return prev;
        updated = { ...c, frames, hydrated: false };
        const next = new Map(prev);
        next.set(id, updated);
        return next;
      });
      return updated;
    } catch (err) {
      // A disk read failure (corrupt/locked ndjson, perms) must PROPAGATE so the
      // player shows its "Couldn't load frames / Try again" state and Export
      // reports "Export failed" — rather than being swallowed into a resolved
      // 0-frame recording that reads as "No frames captured" / "Nothing to
      // export" (misleading: the frames exist on disk, the read just failed).
      throw err instanceof Error ? err : new Error('Could not read the recording from disk.');
    }
  }, []);

  const activeIds = useMemo<Set<string>>(() => {
    const out = new Set<string>();
    for (const r of recordings.values()) {
      if (r.endedAt === null) out.add(r.id);
    }
    return out;
  }, [recordings]);

  const activeRecordingFor = useCallback(
    (sessionId: string): string | null => {
      for (const r of recordings.values()) {
        if (r.sessionId === sessionId && r.endedAt === null) return r.id;
      }
      return null;
    },
    [recordings],
  );

  const value = useMemo<RecordingsContextValue>(
    () => ({
      recordings,
      activeIds,
      loading,
      startRecording,
      stopRecording,
      addFrame,
      deleteRecording,
      hydrateFrames,
      activeRecordingFor,
      persistError,
      clearPersistError,
    }),
    [
      recordings,
      activeIds,
      loading,
      startRecording,
      stopRecording,
      addFrame,
      deleteRecording,
      hydrateFrames,
      activeRecordingFor,
      persistError,
      clearPersistError,
    ],
  );

  return <RecordingsCtx.Provider value={value}>{children}</RecordingsCtx.Provider>;
}

export function useRecordings(): RecordingsContextValue {
  const ctx = useContext(RecordingsCtx);
  if (!ctx) throw new Error('useRecordings must be used inside <RecordingsProvider>');
  return ctx;
}

function mintId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  let s = '';
  for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

// ─── helpers used by views ────────────────────────────────────────

export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

export function recordingDurationMs(r: Recording): number {
  const end = r.endedAt ?? Date.now();
  return Math.max(0, end - r.startedAt);
}

/** P2 #10 — adaptive byte size for the recordings UI. The cards/player hardcoded
 *  `(bytes / 1024 / 1024).toFixed(1) MB`, so a sub-100KB recording read "0.0 MB".
 *  Pick the unit that keeps the number readable: bytes < 1 KiB → "B", < 1 MiB →
 *  "KB", else "MB" with one decimal. */
export function formatBytes(bytes: number): string {
  const b = Math.max(0, bytes);
  if (b < 1024) return `${Math.round(b)} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10 * 1024 ? 1 : 0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export function recordingTotalBytes(r: Recording): number {
  // Hydrated entries (loaded from disk index but frames not yet read)
  // expose the cached totalBytes from the persisted header. Live + frame-
  // loaded recordings sum the in-memory frames.
  if (r.hydrated && r.frames.length === 0) return r.totalBytes;
  return r.frames.reduce((acc, f) => acc + f.bytes, 0);
}

function headerToRecording(h: RecordingHeader): Recording {
  return {
    id: h.id,
    sessionId: h.sessionId,
    label: h.label,
    startedAt: h.startedAt,
    endedAt: h.endedAt,
    frames: [],
    totalCaptured: h.totalCaptured,
    hydrated: true,
    frameCount: h.frameCount,
    totalBytes: h.totalBytes,
  };
}
