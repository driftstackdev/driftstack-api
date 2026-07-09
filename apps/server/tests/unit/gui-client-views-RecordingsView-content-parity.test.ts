// W481.B — drift guard for apps/gui-client/src/views/RecordingsView.tsx.
// Recordings GALLERY view (founder-approved port of the recordings-gallery
// visual demo, 2026-06-12 — thumbnail grid + player rail; replaced the
// original table). Drift here either drops the 'live' guard on
// still-recording entries (operator deletes a recording that's still
// capturing frames — Tauri process can't release the buffer and stays
// bloated until app restart) or breaks the in-memory-persistence framing
// (user expects recordings to survive an app restart and is surprised
// when the list is empty).
//
//   • Framing pinned: gallery header comment + persistence-coming-soon
//     user copy.
//   • RecordingsViewProps: onOpen callback.
//   • sort: newest first (b.startedAt - a.startedAt); selected falls
//     back to newest (?? list[0]) so deleting the selection never
//     leaves a dead rail.
//   • live guard: endedAt === null → 'live' badge in status-busy +
//     rail Delete disabled with title='Stop recording before deleting'.
//   • Frames fact: hydrated short-circuit (frameCount when frames not
//     yet loaded) + '/totalCaptured' suffix; rail Open disabled when
//     frames.length === 0.
//   • Size: bytes/1024/1024 .toFixed(1) MB.
//   • Thumb: first frame dataUrl poster (alt="" decorative) vs the
//     hydrated/'no frames' placeholder; duration chip.
//   • Empty subcomponent: loading → SkeletonRows (W466) vs
//     no-recordings branch with inline svg + persistence note.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/RecordingsView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W481.B apps/gui-client/src/views/RecordingsView.tsx content parity', () => {
  const body = read(LIB);

  it("Framing pinned: gallery header ('Recordings gallery — thumbnail grid + player rail') + persistence reality (ndjson store, frames hydrate on demand)", () => {
    expect(body).toMatch(
      /\/\/ Recordings gallery — thumbnail grid \+ player rail over the in-memory/,
    );
    expect(body).toMatch(
      /\/\/ Recordings persist to disk \(see lib\/recordings\.tsx — ndjson store,/,
    );
  });

  it('RecordingsViewProps {onOpen: (recordingId: string) => void} + useRecordings destructure {recordings + deleteRecording + loading}; list sort newest-first; selection falls back to newest', () => {
    expect(body).toMatch(
      /export interface RecordingsViewProps \{\s*\n?\s*onOpen: \(recordingId: string\) => void;\s*\n?\s*\}/,
    );
    // The destructure + the newest-first sort are both pinned, but no longer
    // required to be line-adjacent (a copy-session-id handler now sits between
    // them — W##: GUI polish wave). Asserted independently so each fragment
    // still drifts the guard if it changes.
    expect(body).toMatch(
      /const \{ recordings, deleteRecording, hydrateFrames, loading \} = useRecordings\(\);/,
    );
    expect(body).toMatch(
      /const list = Array\.from\(recordings\.values\(\)\)\.sort\(\(a, b\) => b\.startedAt - a\.startedAt\);/,
    );
    // Deleted/unknown selection degrades to the newest recording — the
    // rail never points at a recording that no longer exists.
    expect(body).toContain(
      'const selected = (selectedId !== null ? recordings.get(selectedId) : undefined) ?? list[0];',
    );
  });

  it("Persistence copy pinned to REALITY (the disk-persistence phase shipped — recordings-store.ts ndjson + loadIndex): header 'persist on this machine (app data); frames load on demand' + empty-state '...they persist on this machine and survive an app restart'. The original 'lands in a follow-up phase' copy became false and was corrected in the gallery port; the Console restyle folded the empty-state persistence note into the EmptyState description sentence (same 'survive an app restart' promise).", () => {
    expect(body).toMatch(
      /Recordings persist on this machine \(app data\); frames load on demand when you open\s*\n?\s*one\./,
    );
    expect(body).toMatch(/they persist on this machine and survive an app restart\./);
    expect(body).not.toMatch(/Persistence to disk lands in a\s*\n?\s*follow-up\s*\n?\s*phase/);
  });

  it("Live guard survives the gallery port: endedAt === null → 'live' badge with text-status-busy (card meta + rail Duration) + hero '{liveCount} live' pill; rail Delete disabled when live OR while a delete is in flight (deletingId guard, audit wiq542bfj — a fast double-click otherwise deleted a 2nd recording) OR while the confirm is armed for this recording; the delete confirmation is now a dedicated full-width confirm bar ('Confirm delete?' + Delete + Cancel) rendered BELOW the action row (the button no longer relabels) — pinned so operator can't delete a still-capturing recording (Tauri process couldn't release the buffer)", () => {
    expect(body).toMatch(/const live = r\.endedAt === null;/);
    expect(body).toContain('<span className="ml-1.5 text-status-busy">live</span>');
    // Hero live pill now reads "{liveCount} live".
    expect(body).toMatch(/const liveCount = list\.filter\(\(r\) => r\.endedAt === null\)\.length;/);
    expect(body).toMatch(/\{liveCount\} live/);
    // Delete is disabled while live, while a delete is in flight, OR while the
    // confirm bar is armed for this recording.
    expect(body).toMatch(
      /disabled=\{\s*\n?\s*selected\.endedAt === null \|\|\s*\n?\s*deletingId !== null \|\|\s*\n?\s*confirmingDeleteId === selected\.id\s*\n?\s*\}/,
    );
    // The title is a simple 2-way ternary (the click-again-to-confirm tooltip
    // moved out to the dedicated confirm bar below the action row).
    expect(body).toMatch(
      /title=\{\s*\n?\s*selected\.endedAt === null\s*\n?\s*\? 'Stop recording before deleting'\s*\n?\s*: 'This permanently deletes the recording'\s*\n?\s*\}/,
    );
    // Dedicated full-width confirm bar rendered BELOW the Open/Export/Delete row.
    expect(body).toMatch(/\{confirmingDeleteId === selected\.id && deletingId === null \? \(/);
    expect(body).toMatch(
      /<span className="min-w-0 flex-1 text-xs text-ink-primary">Confirm delete\?<\/span>/,
    );
  });

  it("Frames fact: hydrated short-circuit (frameCount when frames haven't loaded) + '/totalCaptured' suffix; rail Open disabled when frames.length === 0; Size via formatBytes(recordingTotalBytes)", () => {
    expect(body).toContain('selected.hydrated && selected.frames.length === 0');
    expect(body).toContain('? selected.frameCount');
    expect(body).toContain('Math.max(selected.frames.length, selected.frameCount)');
    // BUG FIX pinned: persisted recordings (hydrated, frames not yet
    // loaded) are OPENABLE — the player hydrates on mount. The old
    // frames.length===0 disable made every persisted recording
    // unplayable after an app restart.
    expect(body).toContain('selected.frames.length === 0 &&');
    expect(body).toContain('!(selected.hydrated && selected.frameCount > 0)');
    // Size now renders via the adaptive formatBytes helper (KB/MB) so sub-100KB
    // recordings no longer all show "0.0 MB".
    expect(body).toContain('formatBytes(recordingTotalBytes(selected))');
  });

  it("Thumb: first-frame poster (decorative alt='') vs hydrated 'frames on disk' / 'no frames' placeholder + duration chip; card double-click opens only when frames are loaded", () => {
    expect(body).toContain('const first = r.frames[0];');
    expect(body).toContain('<img src={first.dataUrl} alt=""');
    expect(body).toContain("{r.hydrated ? 'frames on disk' : 'no frames'}");
    expect(body).toContain('{formatDuration(recordingDurationMs(r))}');
    // Console restyle: the openable predicate was hoisted to a `playable`
    // const (frames in memory OR persisted on disk), and the card's
    // double-click only opens when playable — same gating, named helper.
    expect(body).toContain(
      'const playable = r.frames.length > 0 || (r.hydrated && r.frameCount > 0);',
    );
    expect(body).toContain('onDoubleClick={playable ? onOpen : undefined}');
  });

  it("Empty subcomponent (Console restyle): loading branch → a gallery-shaped skeleton (Skeleton-based GallerySkeleton, replacing the old SkeletonRows) vs no-recordings branch via the shared <EmptyState> — FilmGlyph icon + 'No recordings yet' title + 'Recordings capture every frame of a live session for replay + audit. Open a live session, hit Record, and frames stream into memory while the session runs — they persist on this machine and survive an app restart.' description (capture helper + persistence reality, same intent as the old h3/p markup)", () => {
    expect(body).toMatch(/import \{ Skeleton \} from '\.\.\/components\/Skeleton';/);
    expect(body).toMatch(/import \{ EmptyState \} from '\.\.\/components\/EmptyState';/);
    expect(body).toMatch(
      /function Empty\(\{ loading \}: \{ loading: boolean \}\): JSX\.Element \{\s*\n?\s*if \(loading\) \{\s*\n?\s*return <GallerySkeleton \/>;/,
    );
    expect(body).toMatch(/title="No recordings yet"/);
    expect(body).toMatch(
      /Recordings capture every frame of a live session for replay \+ audit\. Open a live session,\s*\n?\s*hit Record, and frames stream into memory while the session runs — they persist on this\s*\n?\s*machine and survive an app restart\./,
    );
  });

  it("Export affordance (founder-approved recordings export): rail Export button → handleExport, which hydrates a persisted recording's frames first, then downloadJson(recordingExportFilename, buildRecordingExport). Disabled with the same openable predicate as Open (an empty recording has nothing to write). PROFILE export stays hidden — this is recordings-only.", () => {
    expect(body).toMatch(
      /import \{ buildRecordingExport, recordingExportFilename \} from '\.\.\/lib\/recordings-export';/,
    );
    expect(body).toMatch(/import \{ downloadJson \} from '\.\.\/lib\/download';/);
    expect(body).toContain('async function handleExport(rec: Recording): Promise<void> {');
    // Persisted recordings must be hydrated before the envelope is built.
    expect(body).toContain('if (rec.hydrated && rec.frames.length === 0) {');
    expect(body).toContain('const hydrated = await hydrateFrames(rec.id);');
    // BUG FIX pinned: the success toast is GATED on a CONFIRMED write —
    // downloadJson returns whether the file actually landed (the Tauri WKWebView
    // anchor fallback writes nothing but used to read as success → a lying toast).
    expect(body).toContain('const saved = await downloadJson(');
    expect(body).toContain('recordingExportFilename(full, now)');
    expect(body).toContain('buildRecordingExport(full, now)');
    expect(body).toContain('if (saved) {');
    expect(body).toContain('onClick={() => void handleExport(selected)}');
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
