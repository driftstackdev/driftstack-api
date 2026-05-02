// Session recordings — in-memory ring buffer + React context.
//
// Lives entirely in-memory for this iteration: recordings disappear
// on app restart. Persisting them across restarts (ndjson via the
// tauri fs plugin) is queued for GUI6.5 once the founder validates
// the playback UX. The empirical question — "is replaying 2-fps
// PNGs in an <img> good enough for debugging, or do we need real
// video encoding?" — is the load-bearing one to answer first; the
// persistence shape can ride along after.
//
// Memory ceiling: each recording caps frames at MAX_FRAMES_PER_RECORDING
// to prevent runaway sessions from eating GB of RAM. At 2 fps + ~150 KB
// per frame, 1200 frames = ~10 minutes = ~180 MB upper bound. When the
// cap is hit, oldest frames are dropped (ring buffer semantics).

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

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
}

interface RecordingsContextValue {
  recordings: Map<string, Recording>;
  /** Recording ids actively recording. */
  activeIds: Set<string>;
  startRecording: (sessionId: string, label?: string) => string;
  stopRecording: (id: string) => Recording | null;
  addFrame: (id: string, frame: RecordingFrame) => void;
  deleteRecording: (id: string) => void;
  /** Convenience: the recording id that is currently active for a given session, if any. */
  activeRecordingFor: (sessionId: string) => string | null;
}

const RecordingsCtx = createContext<RecordingsContextValue | null>(null);

export function RecordingsProvider({ children }: { children: ReactNode }): JSX.Element {
  // Single state slot; mutations replace the Map ref so React re-renders.
  const [recordings, setRecordings] = useState<Map<string, Recording>>(() => new Map());

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
    };
    setRecordings((prev) => {
      const next = new Map(prev);
      next.set(id, rec);
      return next;
    });
    return id;
  }, []);

  const stopRecording = useCallback((id: string): Recording | null => {
    let stopped: Recording | null = null;
    setRecordings((prev) => {
      const cur = prev.get(id);
      if (!cur || cur.endedAt !== null) return prev;
      const next = new Map(prev);
      stopped = { ...cur, endedAt: Date.now() };
      next.set(id, stopped);
      return next;
    });
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

  const deleteRecording = useCallback((id: string): void => {
    setRecordings((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
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
      startRecording,
      stopRecording,
      addFrame,
      deleteRecording,
      activeRecordingFor,
    }),
    [
      recordings,
      activeIds,
      startRecording,
      stopRecording,
      addFrame,
      deleteRecording,
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
  return r.frames.reduce((acc, f) => acc + f.bytes, 0);
}
