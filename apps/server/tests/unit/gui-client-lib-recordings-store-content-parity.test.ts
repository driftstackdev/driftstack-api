// W469.A — drift guard for apps/gui-client/src/lib/recordings-store.ts.
// Recordings disk persistence — ndjson per recording + JSON index.
// Drift here either drops the rebuildIndexFromScan recovery branch
// (a corrupt index.json wipes the customer's recording library
// silently — visible files exist on disk but the GUI shows
// empty list) or breaks the write-on-STOP framing (per-frame I/O
// at 2 fps × 100KB regresses to disk-burning, which the framing
// explicitly rejects).
//
//   • File-layout framing pinned: '$APPDATA/recordings/' + Tauri
//     fs permission scoping + 'index.json' + '<recording-id>.
//     ndjson' + 'first line is the header' fast-load reasoning.
//   • Persistence-model framing pinned: 'write on STOP, not on
//     every frame. Per-frame I/O at 2 fps × 100KB would burn disk
//     for marginal crash safety; recordings are deliberate, and
//     on app close we flush any active recordings via the
//     provider's unmount path.'
//   • Tauri fs imports: 7-fn block (BaseDirectory + exists +
//     mkdir + readDir + readTextFile + remove + writeTextFile).
//   • RECORDINGS_DIR + INDEX_FILE constants pinned.
//   • RecordingHeader 8-field (id + sessionId + label nullable
//     + startedAt + endedAt nullable + totalCaptured +
//     frameCount + totalBytes 'lets the list view show size
//     without loading frames').
//   • loadIndex: ensureDir + idx-exists check + try/catch JSON
//     parse → fallback to rebuildIndexFromScan.
//   • rebuildIndexFromScan: readDir .ndjson filter + slice(0,-7)
//     id extract + readHeader + writeIndex + 'Skip malformed file.'
//   • persistRecording: lines [header, ...frames] + '\n' separator
//     + filter !== id existing-dedup + sort by startedAt desc.
//   • loadFrames: split + length>0 filter + i=1 header-skip + try/
//     catch per-line isRecordingFrame narrow.
//   • deletePersisted: ndjson-exists guard + remove + index filter
//     dedup.
//   • isRecordingHeader/isRecordingFrame runtime narrows.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/recordings-store.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W469.A apps/gui-client/src/lib/recordings-store.ts content parity', () => {
  const body = read(LIB);

  it("File-layout framing pinned: 'Recordings disk persistence — ndjson per recording + JSON index.' + '`$APPDATA/recordings/` (Tauri scopes the fs permission to this exact dir, see capabilities/default.json)' + 'index.json — array of RecordingHeader, fast-load metadata' + '<recording-id>.ndjson — one recording: header line + one JSON-encoded frame per subsequent line' + 'The ndjson file's first line is the header (so a quick `read first line + parse` gives you metadata without buffering the whole 100MB file). Frames are appended one-per-line below.'", () => {
    expect(body).toMatch(/\/\/ Recordings disk persistence — ndjson per recording \+ JSON index\./);
    expect(body).toMatch(
      /\/\/ File layout under `\$APPDATA\/recordings\/` \(Tauri scopes the fs\s*\n?\s*\/\/ permission to this exact dir, see capabilities\/default\.json\):/,
    );
    expect(body).toMatch(
      /\/\/\s+index\.json\s+— array of RecordingHeader, fast-load metadata\s*\n?\s*\/\/\s+<recording-id>\.ndjson\s+— one recording: header line \+ one JSON-encoded\s*\n?\s*\/\/\s+frame per subsequent line/,
    );
    expect(body).toMatch(
      /\/\/ The ndjson file's first line is the header \(so a quick `read first line \+\s*\n?\s*\/\/ parse` gives you metadata without buffering the whole 100MB file\)\. Frames\s*\n?\s*\/\/ are appended one-per-line below\./,
    );
  });

  it("Persistence-model framing pinned: 'write on STOP, not on every frame. Per-frame I/O at 2 fps × 100KB would burn disk for marginal crash safety; recordings are deliberate, and on app close we flush any active recordings via the provider's unmount path. If an active recording is interrupted by a crash the same way the in-memory version was, that's parity with the existing UX, just with everything-finalised-recordings now persisting.'", () => {
    expect(body).toMatch(
      /\/\/ Persistence model: write on STOP, not on every frame\. Per-frame I\/O at\s*\n?\s*\/\/ 2 fps × 100KB would burn disk for marginal crash safety; recordings are\s*\n?\s*\/\/ deliberate, and on app close we flush any active recordings via the\s*\n?\s*\/\/ provider's unmount path\. If an active recording is interrupted by a\s*\n?\s*\/\/ crash the same way the in-memory version was, that's parity with the\s*\n?\s*\/\/ existing UX, just with everything-finalised-recordings now persisting\./,
    );
  });

  it("Tauri fs imports: 7-fn block (BaseDirectory + exists + mkdir + readDir + readTextFile + remove + writeTextFile) from '@tauri-apps/plugin-fs'; type imports Recording + RecordingFrame from './recordings'", () => {
    expect(body).toMatch(
      /import \{\s*\n?\s*BaseDirectory,\s*\n?\s*exists,\s*\n?\s*mkdir,\s*\n?\s*readDir,\s*\n?\s*readTextFile,\s*\n?\s*remove,\s*\n?\s*writeTextFile,\s*\n?\s*\} from '@tauri-apps\/plugin-fs';\s*\n?\s*import type \{ Recording, RecordingFrame \} from '\.\/recordings';/,
    );
  });

  it("Constants: RECORDINGS_DIR = 'recordings' + INDEX_FILE = 'recordings/index.json'", () => {
    expect(body).toMatch(/const RECORDINGS_DIR = 'recordings';/);
    expect(body).toMatch(/const INDEX_FILE = 'recordings\/index\.json';/);
  });

  it("RecordingHeader 8-field: id + sessionId + label nullable + startedAt + endedAt nullable + totalCaptured + frameCount + totalBytes 'Total bytes across all stored frames. Lets the list view show size without loading frames.'", () => {
    expect(body).toMatch(
      /export interface RecordingHeader \{\s*\n?\s*id: string;\s*\n?\s*sessionId: string;\s*\n?\s*label: string \| null;\s*\n?\s*startedAt: number;\s*\n?\s*endedAt: number \| null;\s*\n?\s*totalCaptured: number;\s*\n?\s*frameCount: number;\s*\n?\s*\/\*\* Total bytes across all stored frames\. Lets the list view show size without loading frames\. \*\/\s*\n?\s*totalBytes: number;\s*\n?\s*\}/,
    );
  });

  it("loadIndex: ensureDir + idxExists check + try JSON.parse(readTextFile) + !Array.isArray → [] + .filter(isRecordingHeader); catch → 'Corrupt index — recover by scanning the dir.' → rebuildIndexFromScan", () => {
    expect(body).toMatch(
      /export async function loadIndex\(\): Promise<RecordingHeader\[\]> \{\s*\n?\s*await ensureDir\(\);\s*\n?\s*const idxExists = await exists\(INDEX_FILE, \{ baseDir: BaseDirectory\.AppData \}\);\s*\n?\s*if \(!idxExists\) return \[\];\s*\n?\s*try \{\s*\n?\s*const raw = await readTextFile\(INDEX_FILE, \{ baseDir: BaseDirectory\.AppData \}\);\s*\n?\s*const parsed = JSON\.parse\(raw\) as unknown;\s*\n?\s*if \(!Array\.isArray\(parsed\)\) return \[\];\s*\n?\s*return parsed\.filter\(isRecordingHeader\);\s*\n?\s*\} catch \{\s*\n?\s*\/\/ Corrupt index — recover by scanning the dir\.\s*\n?\s*return await rebuildIndexFromScan\(\);\s*\n?\s*\}/,
    );
  });

  it("rebuildIndexFromScan: readDir + .ndjson endsWith filter + slice(0, -7) id extract + readHeader + 'Skip malformed file.' inner catch + writeIndex + 'Dir read failed — return empty.' outer catch", () => {
    expect(body).toMatch(
      /async function rebuildIndexFromScan\(\): Promise<RecordingHeader\[\]> \{\s*\n?\s*const out: RecordingHeader\[\] = \[\];\s*\n?\s*try \{\s*\n?\s*const entries = await readDir\(RECORDINGS_DIR, \{ baseDir: BaseDirectory\.AppData \}\);\s*\n?\s*for \(const e of entries\) \{\s*\n?\s*if \(!e\.name\?\.endsWith\('\.ndjson'\)\) continue;\s*\n?\s*const id = e\.name\.slice\(0, -7\);/,
    );
    expect(body).toMatch(
      /\/\/ Skip malformed file\.\s*\n?\s*\}\s*\n?\s*\}\s*\n?\s*await writeIndex\(out\);\s*\n?\s*\} catch \{\s*\n?\s*\/\/ Dir read failed — return empty\.\s*\n?\s*\}/,
    );
  });

  it("persistRecording: totalBytes reduce + 8-field RecordingHeader + lines [JSON.stringify(header), ...frames.map(JSON.stringify)] + '\\n' join + final '\\n' suffix; index dedup via .filter(h => h.id !== rec.id) + push + sort by startedAt desc", () => {
    expect(body).toMatch(
      /const totalBytes = rec\.frames\.reduce\(\(acc, f\) => acc \+ f\.bytes, 0\);\s*\n?\s*const header: RecordingHeader = \{\s*\n?\s*id: rec\.id,/,
    );
    expect(body).toMatch(
      /const lines: string\[\] = \[JSON\.stringify\(header\)\];\s*\n?\s*for \(const f of rec\.frames\) \{\s*\n?\s*lines\.push\(JSON\.stringify\(f\)\);\s*\n?\s*\}\s*\n?\s*await writeTextFile\(ndjsonPath\(rec\.id\), lines\.join\('\\n'\) \+ '\\n', \{\s*\n?\s*baseDir: BaseDirectory\.AppData,\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /const idx = await loadIndex\(\);\s*\n?\s*const next = idx\.filter\(\(h\) => h\.id !== rec\.id\);\s*\n?\s*next\.push\(header\);\s*\n?\s*next\.sort\(\(a, b\) => b\.startedAt - a\.startedAt\);\s*\n?\s*await writeIndex\(next\);/,
    );
  });

  it("loadFrames: 'lazy — invoked when the player opens' framing + raw.split('\\n').filter(length>0) + i=1 header-skip + per-line try/catch isRecordingFrame narrow + 'Skip malformed line.'", () => {
    expect(body).toMatch(
      /\/\*\* Load frames for a recording from disk \(lazy — invoked when the player opens\)\. \*\/\s*\n?\s*export async function loadFrames\(id: string\): Promise<RecordingFrame\[\]> \{\s*\n?\s*const raw = await readTextFile\(ndjsonPath\(id\), \{ baseDir: BaseDirectory\.AppData \}\);\s*\n?\s*const lines = raw\.split\('\\n'\)\.filter\(\(l\) => l\.length > 0\);\s*\n?\s*\/\/ First line is the header — skip\.\s*\n?\s*const out: RecordingFrame\[\] = \[\];\s*\n?\s*for \(let i = 1; i < lines\.length; i\+\+\) \{\s*\n?\s*try \{\s*\n?\s*const parsed = JSON\.parse\(lines\[i\] as string\) as unknown;\s*\n?\s*if \(isRecordingFrame\(parsed\)\) out\.push\(parsed\);\s*\n?\s*\} catch \{\s*\n?\s*\/\/ Skip malformed line\.\s*\n?\s*\}\s*\n?\s*\}/,
    );
  });

  it('deletePersisted: ndjsonExists check before remove + index filter dedup; isRecordingHeader 8-check narrow + isRecordingFrame 3-check (at number + dataUrl string + bytes number)', () => {
    expect(body).toMatch(
      /export async function deletePersisted\(id: string\): Promise<void> \{\s*\n?\s*await ensureDir\(\);\s*\n?\s*const ndjsonExists = await exists\(ndjsonPath\(id\), \{ baseDir: BaseDirectory\.AppData \}\);\s*\n?\s*if \(ndjsonExists\) \{\s*\n?\s*await remove\(ndjsonPath\(id\), \{ baseDir: BaseDirectory\.AppData \}\);\s*\n?\s*\}\s*\n?\s*const idx = await loadIndex\(\);\s*\n?\s*const next = idx\.filter\(\(h\) => h\.id !== id\);\s*\n?\s*await writeIndex\(next\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /function isRecordingFrame\(v: unknown\): v is RecordingFrame \{\s*\n?\s*if \(typeof v !== 'object' \|\| v === null\) return false;\s*\n?\s*const r = v as Record<string, unknown>;\s*\n?\s*return typeof r\.at === 'number' && typeof r\.dataUrl === 'string' && typeof r\.bytes === 'number';\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
