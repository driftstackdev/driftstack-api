// W608.B — drift guard for apps/gui-client/src/lib/recordings.tsx.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/recordings.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W608.B apps/gui-client/src/lib/recordings.tsx content parity', () => {
  const body = read(LIB);

  it('Recordings provider framing: V-040 ndjson disk persistence + write-on-STOP + lazy-load frames on open + auto-finalise on unmount + MAX_FRAMES_PER_RECORDING=1200 ring-buffer (~10min @ 2fps ~180MB cap) pinned', () => {
    expect(body).toMatch(/\/\/ Session recordings — in-memory state \+ ndjson disk persistence\./);
    expect(body).toMatch(
      /\/\/ Persistence model \(V-040\): write on STOP, lazy-load frames when a/,
    );
    expect(body).toMatch(/\/\/ recording is opened for playback\. The recordings index file/);
    expect(body).toMatch(
      /\/\/ \(`\$APPDATA\/recordings\/index\.json`\) hydrates on app start so the/,
    );
    expect(body).toMatch(/\/\/ list view shows persisted recordings without buffering frames\./);
    expect(body).toMatch(/\/\/ Active recordings are auto-finalised \+ persisted on provider/);
    expect(body).toMatch(/\/\/ unmount \(app close\)\./);
    expect(body).toMatch(
      /\/\/ Memory ceiling: each recording caps frames at MAX_FRAMES_PER_RECORDING/,
    );
    expect(body).toMatch(
      /\/\/ to prevent runaway sessions from eating GB of RAM\. At 2 fps \+ ~150 KB/,
    );
    expect(body).toMatch(
      /\/\/ per frame, 1200 frames = ~10 minutes = ~180 MB upper bound\. When the/,
    );
    expect(body).toMatch(/\/\/ cap is hit, oldest frames are dropped \(ring buffer semantics\)\./);
    expect(body).toMatch(/^const MAX_FRAMES_PER_RECORDING = 1200;$/m);
  });

  it('RecordingFrame + Recording (incl hydrated marker + cached frameCount/totalBytes) + RecordingsContextValue (recordings Map + activeIds Set + 7 verbs) pinned', () => {
    expect(body).toMatch(
      /^export interface RecordingFrame \{\s*\n\s*at: number; \/\/ epoch ms\s*\n\s*dataUrl: string;\s*\n\s*bytes: number;\s*\n\}/m,
    );
    expect(body).toMatch(/^export interface Recording \{$/m);
    expect(body).toMatch(/endedAt: number \| null; \/\/ null while still recording/);
    expect(body).toMatch(/frames: RecordingFrame\[\];/);
    expect(body).toMatch(
      /\/\*\* Total frames captured \(including any dropped from the front when capped\)\. \*\//,
    );
    expect(body).toMatch(/totalCaptured: number;/);
    expect(body).toMatch(/\/\*\* Persisted-but-frames-not-loaded marker\./);
    expect(body).toMatch(/hydrated: boolean;/);
    expect(body).toMatch(/^interface RecordingsContextValue \{$/m);
    expect(body).toMatch(/recordings: Map<string, Recording>;/);
    expect(body).toMatch(/activeIds: Set<string>;/);
    expect(body).toMatch(/startRecording: \(sessionId: string, label\?: string\) => string;/);
    expect(body).toMatch(/stopRecording: \(id: string\) => Promise<Recording \| null>;/);
    expect(body).toMatch(/addFrame: \(id: string, frame: RecordingFrame\) => void;/);
    // deleteRecording now resolves a boolean — true on success, false when the
    // on-disk delete failed (the row is restored so the UI matches reality).
    expect(body).toMatch(
      /\/\*\* Delete a recording from memory \+ disk\. Resolves true on success; false if\s*\n\s*\*\s*the on-disk delete failed \(the row is restored so the UI matches reality\)\. \*\/\s*\n\s*deleteRecording: \(id: string\) => Promise<boolean>;/,
    );
    expect(body).not.toMatch(/deleteRecording: \(id: string\) => Promise<void>;/);
    expect(body).toMatch(/hydrateFrames: \(id: string\) => Promise<Recording \| null>;/);
    expect(body).toMatch(/activeRecordingFor: \(sessionId: string\) => string \| null;/);
  });

  it('RecordingsProvider: hydrate-index-on-mount + auto-flush-active-recordings-on-unmount + startRecording mints UUID + stopRecording persists + addFrame ring-buffer enforce + soft-fail persist + hydrateFrames lazy-load', () => {
    expect(body).toMatch(/export function RecordingsProvider/);
    expect(body).toMatch(/\/\/ Hydrate index on mount\./);
    expect(body).toMatch(/const index = await loadIndex\(\);/);
    expect(body).toMatch(/\/\/ Auto-flush any active recordings on unmount \(app close\)\./);
    expect(body).toMatch(
      /\/\/ Fire-and-forget; the React tree is tearing down so we\s*\n\s*\/\/ can't await\. Tauri's fs plugin queues these through IPC\./,
    );
    expect(body).toMatch(/while \(frames\.length > MAX_FRAMES_PER_RECORDING\) frames\.shift\(\);/);
    // sweep2: a Stop-time persist failure is no longer swallowed silently — it
    // surfaces via the context `persistError` + a window CustomEvent so a toast
    // can warn the user the capture is in-memory only.
    expect(body).toMatch(
      /\/\/ Persist failure leaves the recording in memory only — on app restart/,
    );
    expect(body).toMatch(/setPersistError\(err\);/);
    expect(body).toMatch(/RECORDING_PERSIST_FAILED_EVENT/);
    expect(body).toMatch(
      /^export function useRecordings\(\): RecordingsContextValue \{\s*\n\s*const ctx = useContext\(RecordingsCtx\);\s*\n\s*if \(!ctx\) throw new Error\('useRecordings must be used inside <RecordingsProvider>'\);/m,
    );
  });

  it('Helpers: mintId (crypto.randomUUID with Math.random fallback) + formatDuration "mm:ss" + recordingDurationMs (endedAt or Date.now) + recordingTotalBytes (hydrated header vs in-memory sum) + headerToRecording shape pinned', () => {
    expect(body).toMatch(/^function mintId\(\): string \{$/m);
    expect(body).toMatch(/if \(typeof globalThis\.crypto\?\.randomUUID === 'function'\) \{/);
    expect(body).toMatch(/return globalThis\.crypto\.randomUUID\(\);/);
    expect(body).toMatch(/^export function formatDuration\(ms: number\): string \{$/m);
    expect(body).toMatch(/return `\$\{mm\}:\$\{ss\.toString\(\)\.padStart\(2, '0'\)\}`;/);
    expect(body).toMatch(
      /^export function recordingDurationMs\(r: Recording\): number \{\s*\n\s*const end = r\.endedAt \?\? Date\.now\(\);\s*\n\s*return Math\.max\(0, end - r\.startedAt\);\s*\n\}/m,
    );
    expect(body).toMatch(/export function recordingTotalBytes\(r: Recording\): number \{/);
    expect(body).toMatch(
      /\/\/ Hydrated entries \(loaded from disk index but frames not yet read\)/,
    );
    expect(body).toMatch(/\/\/ expose the cached totalBytes from the persisted header\./);
    expect(body).toMatch(/if \(r\.hydrated && r\.frames\.length === 0\) return r\.totalBytes;/);
    expect(body).toMatch(/^function headerToRecording\(h: RecordingHeader\): Recording \{$/m);
    expect(body).toMatch(/hydrated: true,/);
    expect(existsSync(LIB)).toBe(true);
  });
});
