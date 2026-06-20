// Recording export — a self-contained, portable JSON envelope for a single
// recording (header facts + every captured frame as a data URL). Pure +
// independently unit-testable; the views wire buildRecordingExport →
// downloadJson (the proven blob/anchor download that works in the Tauri
// WKWebView). Deliberately NOT the profile export format (different shape,
// different abuse surface — recordings are read-only session captures the
// founder explicitly approved exporting).

import type { Recording } from './recordings';
import { timestampedFilename } from './download';

/** Schema version of the export envelope — bump on a breaking shape change so
 *  a future importer can branch. */
export const RECORDING_EXPORT_VERSION = 1;

export interface RecordingExportFrame {
  at: number;
  dataUrl: string;
  bytes: number;
}

export interface RecordingExportEnvelope {
  /** Schema version (RECORDING_EXPORT_VERSION). */
  driftstack_recording_export: number;
  /** When the export was produced (ISO 8601). */
  exportedAt: string;
  id: string;
  sessionId: string;
  label: string | null;
  startedAt: number;
  endedAt: number | null;
  totalCaptured: number;
  frameCount: number;
  totalBytes: number;
  frames: RecordingExportFrame[];
}

/** Build a portable envelope from an in-memory recording. Frame counts/bytes
 *  are recomputed from the actual frames present (not the cached header values)
 *  so the envelope is internally consistent even for a partially-hydrated or
 *  ring-buffer-trimmed recording. */
export function buildRecordingExport(rec: Recording, exportedAt: Date): RecordingExportEnvelope {
  const frames = rec.frames.map((f) => ({ at: f.at, dataUrl: f.dataUrl, bytes: f.bytes }));
  return {
    driftstack_recording_export: RECORDING_EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    id: rec.id,
    sessionId: rec.sessionId,
    label: rec.label,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    totalCaptured: rec.totalCaptured,
    frameCount: frames.length,
    totalBytes: frames.reduce((acc, f) => acc + f.bytes, 0),
    frames,
  };
}

/** Filesystem-safe export filename: driftstack-recording-<session>-YYYY-MM-DD.json.
 *  The session id is sanitised to [A-Za-z0-9_-]; an empty result falls back to
 *  the recording id so the name is never just the bare timestamp. */
export function recordingExportFilename(rec: Recording, now: Date): string {
  const safeSession = rec.sessionId.replace(/[^A-Za-z0-9_-]/g, '');
  const tag = safeSession.length > 0 ? safeSession : rec.id;
  return timestampedFilename(`driftstack-recording-${tag}`, 'json', now);
}
