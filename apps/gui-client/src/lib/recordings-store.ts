// Recordings disk persistence — ndjson per recording + JSON index.
//
// File layout under `$APPDATA/recordings/` (Tauri scopes the fs
// permission to this exact dir, see capabilities/default.json):
//
//   index.json                 — array of RecordingHeader, fast-load metadata
//   <recording-id>.ndjson      — one recording: header line + one JSON-encoded
//                                frame per subsequent line
//
// The ndjson file's first line is the header (so a quick `read first line +
// parse` gives you metadata without buffering the whole 100MB file). Frames
// are appended one-per-line below.
//
// Persistence model: write on STOP, not on every frame. Per-frame I/O at
// 2 fps × 100KB would burn disk for marginal crash safety; recordings are
// deliberate, and on app close we flush any active recordings via the
// provider's unmount path. If an active recording is interrupted by a
// crash the same way the in-memory version was, that's parity with the
// existing UX, just with everything-finalised-recordings now persisting.

import {
  BaseDirectory,
  exists,
  mkdir,
  readDir,
  readTextFile,
  remove,
  writeTextFile,
} from '@tauri-apps/plugin-fs';
import type { Recording, RecordingFrame } from './recordings';

const RECORDINGS_DIR = 'recordings';
const INDEX_FILE = 'recordings/index.json';

export interface RecordingHeader {
  id: string;
  sessionId: string;
  label: string | null;
  startedAt: number;
  endedAt: number | null;
  totalCaptured: number;
  frameCount: number;
  /** Total bytes across all stored frames. Lets the list view show size without loading frames. */
  totalBytes: number;
}

async function ensureDir(): Promise<void> {
  const dirExists = await exists(RECORDINGS_DIR, { baseDir: BaseDirectory.AppData });
  if (!dirExists) {
    await mkdir(RECORDINGS_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
  }
}

function ndjsonPath(id: string): string {
  return `${RECORDINGS_DIR}/${id}.ndjson`;
}

export async function loadIndex(): Promise<RecordingHeader[]> {
  await ensureDir();
  const idxExists = await exists(INDEX_FILE, { baseDir: BaseDirectory.AppData });
  if (!idxExists) return await rebuildIndexFromScan();
  let fromIndex: RecordingHeader[];
  try {
    const raw = await readTextFile(INDEX_FILE, { baseDir: BaseDirectory.AppData });
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return await rebuildIndexFromScan();
    fromIndex = parsed.filter(isRecordingHeader);
  } catch {
    // Corrupt index — recover by scanning the dir.
    return await rebuildIndexFromScan();
  }
  // SELF-HEAL (distance-audit, 2026-06-12 night): the index update in
  // persistRecording is a read-modify-write on a raw file — two windows
  // persisting near-simultaneously (simulator Record stop + main-window
  // finalize-on-quit) can drop the loser's entry while its ndjson file
  // survives. Union the index with a dir scan so any orphaned recording
  // re-appears on the next load instead of silently vanishing.
  try {
    const known = new Set(fromIndex.map((h) => h.id));
    const entries = await readDir(RECORDINGS_DIR, { baseDir: BaseDirectory.AppData });
    let healed = false;
    for (const e of entries) {
      if (!e.name?.endsWith('.ndjson')) continue;
      const id = e.name.slice(0, -7);
      if (known.has(id)) continue;
      const header = await readHeader(id).catch(() => null);
      if (header !== null) {
        fromIndex.push(header);
        healed = true;
      }
    }
    if (healed) {
      fromIndex.sort((a, b) => b.startedAt - a.startedAt);
      await writeIndex(fromIndex);
    }
  } catch {
    // Scan failed — the index alone is still a valid view.
  }
  return fromIndex;
}

async function rebuildIndexFromScan(): Promise<RecordingHeader[]> {
  const out: RecordingHeader[] = [];
  try {
    const entries = await readDir(RECORDINGS_DIR, { baseDir: BaseDirectory.AppData });
    for (const e of entries) {
      if (!e.name?.endsWith('.ndjson')) continue;
      const id = e.name.slice(0, -7);
      try {
        const header = await readHeader(id);
        if (header !== null) out.push(header);
      } catch {
        // Skip malformed file.
      }
    }
    await writeIndex(out);
  } catch {
    // Dir read failed — return empty.
  }
  return out;
}

async function writeIndex(headers: RecordingHeader[]): Promise<void> {
  await ensureDir();
  await writeTextFile(INDEX_FILE, JSON.stringify(headers, null, 2), {
    baseDir: BaseDirectory.AppData,
  });
}

async function readHeader(id: string): Promise<RecordingHeader | null> {
  const raw = await readTextFile(ndjsonPath(id), { baseDir: BaseDirectory.AppData });
  const firstNl = raw.indexOf('\n');
  const headerLine = firstNl < 0 ? raw : raw.slice(0, firstNl);
  if (headerLine.length === 0) return null;
  const parsed = JSON.parse(headerLine) as unknown;
  return isRecordingHeader(parsed) ? parsed : null;
}

/** Persist a finalised recording. Writes the ndjson file + updates the index. */
export async function persistRecording(rec: Recording): Promise<RecordingHeader> {
  await ensureDir();
  const totalBytes = rec.frames.reduce((acc, f) => acc + f.bytes, 0);
  const header: RecordingHeader = {
    id: rec.id,
    sessionId: rec.sessionId,
    label: rec.label,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    totalCaptured: rec.totalCaptured,
    frameCount: rec.frames.length,
    totalBytes,
  };
  const lines: string[] = [JSON.stringify(header)];
  for (const f of rec.frames) {
    lines.push(JSON.stringify(f));
  }
  await writeTextFile(ndjsonPath(rec.id), lines.join('\n') + '\n', {
    baseDir: BaseDirectory.AppData,
  });
  // Update index.
  const idx = await loadIndex();
  const next = idx.filter((h) => h.id !== rec.id);
  next.push(header);
  next.sort((a, b) => b.startedAt - a.startedAt);
  await writeIndex(next);
  return header;
}

/** Load frames for a recording from disk (lazy — invoked when the player opens). */
export async function loadFrames(id: string): Promise<RecordingFrame[]> {
  const raw = await readTextFile(ndjsonPath(id), { baseDir: BaseDirectory.AppData });
  const lines = raw.split('\n').filter((l) => l.length > 0);
  // First line is the header — skip.
  const out: RecordingFrame[] = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i] as string) as unknown;
      if (isRecordingFrame(parsed)) out.push(parsed);
    } catch {
      // Skip malformed line.
    }
  }
  return out;
}

export async function deletePersisted(id: string): Promise<void> {
  await ensureDir();
  const ndjsonExists = await exists(ndjsonPath(id), { baseDir: BaseDirectory.AppData });
  if (ndjsonExists) {
    await remove(ndjsonPath(id), { baseDir: BaseDirectory.AppData });
  }
  const idx = await loadIndex();
  const next = idx.filter((h) => h.id !== id);
  await writeIndex(next);
}

// ─── shape guards ─────────────────────────────────────────────────

function isRecordingHeader(v: unknown): v is RecordingHeader {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.sessionId === 'string' &&
    (r.label === null || typeof r.label === 'string') &&
    typeof r.startedAt === 'number' &&
    (r.endedAt === null || typeof r.endedAt === 'number') &&
    typeof r.totalCaptured === 'number' &&
    typeof r.frameCount === 'number' &&
    typeof r.totalBytes === 'number'
  );
}

function isRecordingFrame(v: unknown): v is RecordingFrame {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.at === 'number' && typeof r.dataUrl === 'string' && typeof r.bytes === 'number';
}
