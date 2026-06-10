// W481.B — drift guard for apps/gui-client/src/views/RecordingsView.tsx.
// Recordings list view. Drift here either drops the 'live'
// indicator on still-recording rows (operator clicks Delete on
// a row that's still capturing frames — Tauri process can't
// release the buffer and stays bloated until app restart) or
// breaks the in-memory-persistence framing (user expects
// recordings to survive an app restart and is surprised when
// the list is empty).
//
//   • Framing pinned: 'Recordings list — index of in-memory
//     recordings.' + 'Recordings live until the app closes
//     (see lib/recordings.tsx). The playback view is reached
//     by clicking a row.'
//   • RecordingsViewProps: onOpen callback.
//   • sort: list = Array.from(recordings.values()).sort((a, b)
//     => b.startedAt - a.startedAt) — newest first.
//   • live flag: r.endedAt === null + 'live' badge in
//     status-busy + Delete disabled when live with title='Stop
//     recording before deleting'.
//   • Frames col: r.hydrated && r.frames.length === 0 ?
//     r.frameCount : r.frames.length (hydrated short-circuit
//     for not-yet-loaded recordings) + '/{r.totalCaptured}'
//     suffix when total exceeds memory frame count.
//   • Size: bytes/1024/1024 .toFixed(1) MB.
//   • Empty subcomponent: loading branch + no-recordings
//     branch with inline svg + persistence-coming-soon note.

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

  it("Framing pinned: 'Recordings list — index of in-memory recordings.' + 'Recordings live until the app closes (see lib/recordings.tsx). The playback view is reached by clicking a row.'", () => {
    expect(body).toMatch(/\/\/ Recordings list — index of in-memory recordings\./);
    expect(body).toMatch(
      /\/\/ Recordings live until the app closes \(see lib\/recordings\.tsx\)\. The\s*\n?\s*\/\/ playback view is reached by clicking a row\./,
    );
  });

  it('RecordingsViewProps {onOpen: (recordingId: string) => void} + useRecordings destructure {recordings + deleteRecording + loading}; list sort newest-first by startedAt desc (b.startedAt - a.startedAt)', () => {
    expect(body).toMatch(
      /export interface RecordingsViewProps \{\s*\n?\s*onOpen: \(recordingId: string\) => void;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /const \{ recordings, deleteRecording, loading \} = useRecordings\(\);\s*\n?\s*const list = Array\.from\(recordings\.values\(\)\)\.sort\(\(a, b\) => b\.startedAt - a\.startedAt\);/,
    );
  });

  it("Persistence-coming-soon framing pinned: 'Recordings live in memory until the app restarts. Persistence to disk lands in a follow-up phase.' — pinned so the in-memory limitation stays visible to the user (and doesn't get silently dropped before the disk-persistence phase ships)", () => {
    expect(body).toMatch(
      /<p className="text-2xs text-ink-muted">\s*\n?\s*Recordings live in memory until the app restarts\. Persistence to disk lands in a\s*\n?\s*follow-up phase\.\s*\n?\s*<\/p>/,
    );
  });

  it("Live-indicator + delete-disabled-when-live: const live = r.endedAt === null + 'live' badge with text-status-busy + Delete button disabled={live} + title={live ? 'Stop recording before deleting' : undefined} — pinned so operator can't delete a still-capturing recording (Tauri process couldn't release the buffer)", () => {
    expect(body).toMatch(/const live = r\.endedAt === null;/);
    expect(body).toMatch(/\{live && <span className="ml-1\.5 text-status-busy">live<\/span>\}/);
    expect(body).toMatch(
      /<button\s*\n?\s*type="button"\s*\n?\s*className="btn-danger"\s*\n?\s*onClick=\{\(\) => void deleteRecording\(r\.id\)\}\s*\n?\s*disabled=\{live\}\s*\n?\s*title=\{live \? 'Stop recording before deleting' : undefined\}\s*\n?\s*>\s*\n?\s*Delete\s*\n?\s*<\/button>/,
    );
  });

  it("Frames col: r.hydrated && r.frames.length === 0 ? r.frameCount : r.frames.length (hydrated short-circuit when frames haven't loaded yet) + '/totalCaptured' suffix when r.totalCaptured > max(frames.length, frameCount); Open button disabled when r.frames.length === 0; Size col bytes/1024/1024 .toFixed(1) MB", () => {
    expect(body).toMatch(
      /\{r\.hydrated && r\.frames\.length === 0 \? r\.frameCount : r\.frames\.length\}\s*\n?\s*\{r\.totalCaptured > Math\.max\(r\.frames\.length, r\.frameCount\) && \(\s*\n?\s*<span className="ml-1 text-ink-muted">\/ \{r\.totalCaptured\}<\/span>\s*\n?\s*\)\}/,
    );
    expect(body).toMatch(
      /<button\s*\n?\s*type="button"\s*\n?\s*className="btn-secondary"\s*\n?\s*onClick=\{\(\) => onOpen\(r\.id\)\}\s*\n?\s*disabled=\{r\.frames\.length === 0\}\s*\n?\s*>\s*\n?\s*Open\s*\n?\s*<\/button>/,
    );
    expect(body).toMatch(/\{\(totalBytes \/ 1024 \/ 1024\)\.toFixed\(1\)\} MB/);
  });

  it("Empty subcomponent: loading branch → <SkeletonRows> (W466) vs no-recordings branch with inline 24×24 svg + 'No recordings yet' h3 + 'Open a live session, click <Record>, and frames stream into memory while the session runs.' helper + persistence-coming-soon footer", () => {
    // W466 — loading branch upgraded from a dashed-box text to the shared skeleton.
    expect(body).toMatch(/import \{ SkeletonRows \} from '\.\.\/components\/Skeleton';/);
    expect(body).toMatch(
      /function Empty\(\{ loading \}: \{ loading: boolean \}\): JSX\.Element \{\s*\n?\s*if \(loading\) \{\s*\n?\s*return <SkeletonRows rows=\{4\} label="Loading recordings" \/>;/,
    );
    expect(body).not.toMatch(/<span className="section-label">Loading recordings…<\/span>/);
    expect(body).toMatch(
      /<h3 className="text-base font-medium text-ink-primary">No recordings yet<\/h3>\s*\n?\s*<p className="max-w-md text-sm text-ink-secondary">\s*\n?\s*Recordings capture every frame of a live session for replay \+ audit\. Open a live session,\s*\n?\s*click <span className="mono">Record<\/span>, and frames stream into memory while the\s*\n?\s*session runs\.\s*\n?\s*<\/p>/,
    );
  });

  it('Th/Td subcomponents: thin wrappers with section-label header + sm body text — pinned so the table cell convention stays consistent across the table (no inline className duplication)', () => {
    expect(body).toMatch(
      /function Th\(\{ children \}: \{ children: React\.ReactNode \}\): JSX\.Element \{\s*\n?\s*return <th className="px-3 py-2 section-label">\{children\}<\/th>;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /function Td\(\{ children \}: \{ children: React\.ReactNode \}\): JSX\.Element \{\s*\n?\s*return <td className="px-3 py-2 align-middle text-sm">\{children\}<\/td>;\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
