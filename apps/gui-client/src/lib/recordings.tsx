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

interface RecordingsContextValue {
  recordings: Map<string, Recording>;
  /** Recording ids actively recording. */
  activeIds: Set<string>;
  /** True until loadIndex has resolved on mount. */
  loading: boolean;
  startRecording: (sessionId: string, label?: string) => string;
  stopRecording: (id: string) => Promise<Recording | null>;
  addFrame: (id: string, frame: RecordingFrame) => void;
  deleteRecording: (id: string) => Promise<void>;
  /** Lazy-load frames for a persisted recording. Resolves with the populated Recording. */
  hydrateFrames: (id: string) => Promise<Recording | null>;
  /** Convenience: the recording id that is currently active for a given session, if any. */
  activeRecordingFor: (sessionId: string) => string | null;
}

const RecordingsCtx = createContext<RecordingsContextValue | null>(null);

export function RecordingsProvider({ children }: { children: ReactNode }): JSX.Element {
  // Single state slot; mutations replace the Map ref so React re-renders.
  const [recordings, setRecordings] = useState<Map<string, Recording>>(() => new Map());
  const [loading, setLoading] = useState(true);
  // Latest recordings ref for the unmount-flush effect.
  const recordingsRef = useRef(recordings);
  recordingsRef.current = recordings;

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
    let stopped: Recording | null = null;
    setRecordings((prev) => {
      const cur = prev.get(id);
      if (!cur || cur.endedAt !== null) return prev;
      const next = new Map(prev);
      stopped = {
        ...cur,
        endedAt: Date.now(),
        frameCount: cur.frames.length,
        totalBytes: cur.frames.reduce((acc, f) => acc + f.bytes, 0),
      };
      next.set(id, stopped);
      return next;
    });
    if (stopped !== null) {
      try {
        await persistRecording(stopped);
      } catch {
        // Persist failure leaves the recording in memory only — UI still
        // shows it; on app restart it's lost. Not surfaced as an error
        // because the user already pressed Stop and the UI updated.
      }
    }
    return stopped;
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

  const deleteRecording = useCallback(async (id: string): Promise<void> => {
    setRecordings((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    try {
      await deletePersisted(id);
    } catch {
      // Disk-delete failure is mostly harmless: the recording is gone
      // from the UI; on restart the index would still show it, but
      // the user can re-delete then.
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
    } catch {
      return cur;
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
