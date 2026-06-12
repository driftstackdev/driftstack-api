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
    expect(body).toMatch(
      /const \{ recordings, deleteRecording, loading \} = useRecordings\(\);\s*\n?\s*const list = Array\.from\(recordings\.values\(\)\)\.sort\(\(a, b\) => b\.startedAt - a\.startedAt\);/,
    );
    // Deleted/unknown selection degrades to the newest recording — the
    // rail never points at a recording that no longer exists.
    expect(body).toContain(
      'const selected = (selectedId !== null ? recordings.get(selectedId) : undefined) ?? list[0];',
    );
  });

  it("Persistence copy pinned to REALITY (the disk-persistence phase shipped — recordings-store.ts ndjson + loadIndex): header 'persist on this machine (app data); frames load on demand' + empty-state 'survive an app restart'. The original 'lands in a follow-up phase' copy became false and was corrected in the gallery port.", () => {
    expect(body).toMatch(
      /Recordings persist on this machine \(app data\); frames load on demand when you open\s*\n?\s*one\./,
    );
    expect(body).toMatch(
      /Recordings persist on this machine \(app data\) and survive an app restart\./,
    );
    expect(body).not.toMatch(/Persistence to disk lands in a\s*\n?\s*follow-up\s*\n?\s*phase/);
  });

  it("Live guard survives the gallery port: endedAt === null → 'live' badge with text-status-busy (card meta + rail Duration) + rail Delete disabled when live with title='Stop recording before deleting' — pinned so operator can't delete a still-capturing recording (Tauri process couldn't release the buffer)", () => {
    expect(body).toMatch(/const live = r\.endedAt === null;/);
    expect(body).toContain('<span className="ml-1.5 text-status-busy">live</span>');
    expect(body).toContain('disabled={selected.endedAt === null}');
    expect(body).toContain(
      "selected.endedAt === null ? 'Stop recording before deleting' : undefined",
    );
  });

  it("Frames fact: hydrated short-circuit (frameCount when frames haven't loaded) + '/totalCaptured' suffix; rail Open disabled when frames.length === 0; Size bytes/1024/1024 .toFixed(1) MB", () => {
    expect(body).toContain('selected.hydrated && selected.frames.length === 0');
    expect(body).toContain('? selected.frameCount');
    expect(body).toContain('Math.max(selected.frames.length, selected.frameCount)');
    // BUG FIX pinned: persisted recordings (hydrated, frames not yet
    // loaded) are OPENABLE — the player hydrates on mount. The old
    // frames.length===0 disable made every persisted recording
    // unplayable after an app restart.
    expect(body).toContain('selected.frames.length === 0 &&');
    expect(body).toContain('!(selected.hydrated && selected.frameCount > 0)');
    expect(body).toContain('(recordingTotalBytes(selected) / 1024 / 1024).toFixed(1)} MB');
  });

  it("Thumb: first-frame poster (decorative alt='') vs hydrated 'frames on disk' / 'no frames' placeholder + duration chip; card double-click opens only when frames are loaded", () => {
    expect(body).toContain('const first = r.frames[0];');
    expect(body).toContain('<img src={first.dataUrl} alt=""');
    expect(body).toContain("{r.hydrated ? 'frames on disk' : 'no frames'}");
    expect(body).toContain('{formatDuration(recordingDurationMs(r))}');
    expect(body).toContain(
      'r.frames.length > 0 || (r.hydrated && r.frameCount > 0) ? onOpen : undefined',
    );
  });

  it("Empty subcomponent: loading branch → <SkeletonRows> (W466) vs no-recordings branch with inline 24×24 svg + 'No recordings yet' h3 + 'Open a live session, click <Record>, and frames stream into memory while the session runs.' helper + persistence-coming-soon footer", () => {
    expect(body).toMatch(/import \{ SkeletonRows \} from '\.\.\/components\/Skeleton';/);
    expect(body).toMatch(
      /function Empty\(\{ loading \}: \{ loading: boolean \}\): JSX\.Element \{\s*\n?\s*if \(loading\) \{\s*\n?\s*return <SkeletonRows rows=\{4\} label="Loading recordings" \/>;/,
    );
    expect(body).toMatch(
      /<h3 className="text-base font-medium text-ink-primary">No recordings yet<\/h3>\s*\n?\s*<p className="max-w-md text-sm text-ink-secondary">\s*\n?\s*Recordings capture every frame of a live session for replay \+ audit\. Open a live session,\s*\n?\s*click <span className="mono">Record<\/span>, and frames stream into memory while the\s*\n?\s*session runs\.\s*\n?\s*<\/p>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
