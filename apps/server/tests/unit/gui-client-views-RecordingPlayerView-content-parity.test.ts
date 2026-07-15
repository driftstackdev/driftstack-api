// W482.B — drift guard for apps/gui-client/src/views/RecordingPlayerView.tsx.
// Recording playback view. Drift here either drops the
// wall-clock anchor pattern (playback advances by TICK_MS
// increments instead of real elapsed time — a 100ms tick
// becomes ~100ms of recording playback regardless of actual
// wall-clock drift between ticks; bursty capture replays wrong)
// or breaks the togglePlay end-restart (Replay button at the
// end clicks but does nothing because cursor is already at
// totalMs).
//
//   • Framing pinned: 'Recording playback — timeline scrubber
//     + play/pause.' + 'Plays back the in-memory frame buffer
//     at the same wall-clock cadence they were captured
//     (advances the cursor by real time, picks the frame whose
//     `at` is the closest <= cursor). At 2 fps the playback
//     looks like ~2 fps; if the underlying capture was bursty
//     the playback honours that.'
//   • TICK_MS = 100 module constant pinned: 'playback cursor
//     advances at 10 Hz, frames pick the nearest'.
//   • playStateRef wall-clock anchor: {wallStart, cursorBase}
//     refreshed on play/scrub.
//   • startTick: setInterval at TICK_MS computing elapsed =
//     Date.now() - wallStart then next = cursorBase + elapsed;
//     end-detection next >= totalMs → setCursorMs(totalMs) +
//     setPlaying(false) + stopTick.
//   • Frame selection: linear scan picking latest f.at <=
//     target where target = effectiveStart + cursorMs
//     (effectiveStart = first surviving frame; audit #12
//     ring-buffer-trimmed basis, not recording.startedAt).
//   • togglePlay end-restart: cursorMs >= totalMs → reset
//     cursor to 0 + re-anchor playState before flipping
//     playing.
//   • Lazy-hydrate frames on mount when hydrated && empty.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/RecordingPlayerView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W482.B apps/gui-client/src/views/RecordingPlayerView.tsx content parity', () => {
  const body = read(LIB);

  it("Framing pinned: 'Recording playback — timeline scrubber + play/pause.' + 'Plays back the in-memory frame buffer at the same wall-clock cadence they were captured (advances the cursor by real time, picks the frame whose `at` is the closest <= cursor). At 2 fps the playback looks like ~2 fps; if the underlying capture was bursty the playback honours that.'", () => {
    expect(body).toMatch(/\/\/ Recording playback — timeline scrubber \+ play\/pause\./);
    expect(body).toMatch(
      /\/\/ Plays back the in-memory frame buffer at the same wall-clock cadence\s*\n?\s*\/\/ they were captured \(advances the cursor by real time, picks the\s*\n?\s*\/\/ frame whose `at` is the closest <= cursor\)\. At 2 fps the playback\s*\n?\s*\/\/ looks like ~2 fps; if the underlying capture was bursty the\s*\n?\s*\/\/ playback honours that\./,
    );
  });

  it("TICK_MS = 100 module constant pinned with framing 'playback cursor advances at 10 Hz, frames pick the nearest' — pinned so playback tick cadence isn't reverted to per-frame stepping (would break bursty-capture replay)", () => {
    expect(body).toMatch(
      /const TICK_MS = 100; \/\/ playback cursor advances at 10 Hz, frames pick the nearest/,
    );
  });

  it('playStateRef wall-clock anchor: useRef<{wallStart: number; cursorBase: number} | null>(null) — pinned so the playback loop measures elapsed time from a fixed wall-clock anchor instead of accumulating TICK_MS increments (avoids drift if the JS event loop is busy)', () => {
    expect(body).toMatch(
      /\/\/ Wall-clock anchor for the playback loop: \{ wallStart, cursorBase \}\s*\n?\s*const playStateRef = useRef<\{ wallStart: number; cursorBase: number \} \| null>\(null\);/,
    );
  });

  it('startTick: stopTick + anchor playStateRef = {wallStart: Date.now(), cursorBase: cursorMs} + setInterval TICK_MS measuring elapsed = Date.now() - wallStart then next = cursorBase + elapsed; end-detection next >= totalMs → setCursorMs(totalMs) + setPlaying(false) + stopTick — pinned so playback halts at the actual recording end, not at TICK_MS-aligned ticks before/after', () => {
    expect(body).toMatch(
      /const startTick = useCallback\(\(\): void => \{\s*\n?\s*stopTick\(\);\s*\n?\s*playStateRef\.current = \{ wallStart: Date\.now\(\), cursorBase: cursorMs \};\s*\n?\s*tickRef\.current = window\.setInterval\(\(\) => \{\s*\n?\s*const ps = playStateRef\.current;\s*\n?\s*if \(ps === null\) return;\s*\n?\s*const elapsed = Date\.now\(\) - ps\.wallStart;\s*\n?\s*const next = ps\.cursorBase \+ elapsed;\s*\n?\s*if \(next >= totalMs\) \{\s*\n?\s*setCursorMs\(totalMs\);\s*\n?\s*setPlaying\(false\);\s*\n?\s*stopTick\(\);\s*\n?\s*\} else \{\s*\n?\s*setCursorMs\(next\);\s*\n?\s*\}\s*\n?\s*\}, TICK_MS\);\s*\n?\s*\}, \[cursorMs, stopTick, totalMs\]\);/,
    );
  });

  it("Frame selection: useMemo currentFrame; null when recording === null or frames.length === 0; otherwise target = effectiveStart + cursorMs (ring-buffer-trimmed basis, audit #12 — first SURVIVING frame, not recording.startedAt) + linear scan picking the latest f.at <= target (early break on first f.at > target — pinned so we don't traverse the whole frame list after finding the right one); deps include effectiveStart", () => {
    expect(body).toMatch(
      /const currentFrame = useMemo\(\(\) => \{\s*\n?\s*if \(recording === null \|\| recording\.frames\.length === 0\) return null;\s*\n?\s*const target = effectiveStart \+ cursorMs;\s*\n?\s*let chosen = recording\.frames\[0\] \?\? null;\s*\n?\s*for \(const f of recording\.frames\) \{\s*\n?\s*if \(f\.at <= target\) chosen = f;\s*\n?\s*else break;\s*\n?\s*\}\s*\n?\s*return chosen;\s*\n?\s*\}, \[recording, cursorMs, effectiveStart\]\);/,
    );
  });

  it("togglePlay end-restart + handleScrub re-anchor: cursorMs >= totalMs → reset cursorMs to 0 + re-anchor playStateRef before flipping playing — pinned so 'Replay' button restarts from 0 instead of doing nothing because cursor is already at totalMs; handleScrub re-anchors playStateRef while playing so the next tick measures from the new cursor", () => {
    expect(body).toMatch(
      /function togglePlay\(\): void \{\s*\n?\s*if \(cursorMs >= totalMs\) \{\s*\n?\s*\/\/ Restart from the beginning if we're at the end\.\s*\n?\s*setCursorMs\(0\);\s*\n?\s*playStateRef\.current = \{ wallStart: Date\.now\(\), cursorBase: 0 \};\s*\n?\s*\}\s*\n?\s*setPlaying\(\(p\) => !p\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /function handleScrub\(e: React\.ChangeEvent<HTMLInputElement>\): void \{\s*\n?\s*const next = Number\(e\.target\.value\);\s*\n?\s*setCursorMs\(next\);\s*\n?\s*if \(playing\) \{\s*\n?\s*\/\/ Re-anchor the playback loop so the next tick measures from\s*\n?\s*\/\/ the new cursor\.\s*\n?\s*playStateRef\.current = \{ wallStart: Date\.now\(\), cursorBase: next \};\s*\n?\s*\}\s*\n?\s*\}/,
    );
  });

  it('recording export is ref-single-flighted, visibly busy, and contains thrown writes', () => {
    expect(body).toContain('const exportingRef = useRef(false);');
    expect(body).toContain('if (exportingRef.current || recording === null');
    expect(body).toContain('exportingRef.current = true;');
    expect(body).toContain("body: humanizeError(err, 'Could not save the file.')");
    expect(body).toContain('exportingRef.current = false;');
    expect(body).toContain('disabled={exporting || recording.frames.length === 0}');
    expect(body).toContain('aria-busy={exporting}');
    expect(body).toContain("{exporting ? 'Exporting…' : 'Export'}");
  });

  it('global Space playback excludes native and ARIA interactive targets to prevent double activation', () => {
    expect(body).toContain('const INTERACTIVE_SHORTCUT_TARGETS = [');
    for (const selector of [
      "'button'",
      "'a[href]'",
      "'input'",
      "'textarea'",
      "'select'",
      '\'[contenteditable]:not([contenteditable="false"])\'',
      '\'[role="button"]\'',
      '\'[role="link"]\'',
      '\'[role="tab"]\'',
      '\'[role="slider"]\'',
    ]) {
      expect(body).toContain(selector);
    }
    expect(body).toContain('if (isInteractiveShortcutTarget(e.target)) return;');

    const bypassMutation = body.replace(
      'if (isInteractiveShortcutTarget(e.target)) return;',
      'if (false) return;',
    );
    expect(bypassMutation).not.toContain('if (isInteractiveShortcutTarget(e.target)) return;');
  });

  it('Lazy-hydrate effect humanizes disk errors, clears loading in finally, and retains the recording-not-found branch', () => {
    expect(body).toMatch(/import \{ humanizeError \} from '\.\.\/lib\/humanize-error';/);
    expect(body).toMatch(
      /const loadFrames = useCallback\(\(\): void => \{[\s\S]*?setHydrating\(true\);[\s\S]*?setHydrateError\(null\);[\s\S]*?hydrateFrames\(recordingId\)[\s\S]*?setHydrateError\(\s*humanizeError\(\s*err,\s*"Couldn't read the saved recording\. Check the app's file permissions and try again\."[\s\S]*?\.finally\(\(\) => setHydrating\(false\)\);[\s\S]*?\}, \[hydrateFrames, recordingId\]\);/,
    );
    const bypassMutation = body.replace(
      'setHydrateError(\n          humanizeError(',
      'setHydrateError(\n          String(',
    );
    expect(bypassMutation).not.toMatch(/setHydrateError\(\s*humanizeError\(/);
    expect(body).toMatch(
      /if \(recording === null\) return;\s*\n?\s*if \(!recording\.hydrated \|\| recording\.frames\.length > 0\) return;\s*\n?\s*loadFrames\(\);/,
    );
    expect(body).toMatch(
      /if \(recording === null\) \{\s*\n?\s*return \(\s*\n?\s*<div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">\s*\n?\s*<span className="section-label">Recording not found<\/span>\s*\n?\s*<p className="text-sm text-ink-secondary">It may have been deleted or the app restarted\.<\/p>/,
    );
  });

  it("Render shape: back link '← Recordings' + h2 with sessionId mono + startedAt toLocaleString + frames.length + bytes/1024/1024 MB; play/pause button label 'Pause' when playing else cursorMs >= totalMs ? 'Replay' : 'Play'; range input min=0 max=Math.max(totalMs, 1) + step=TICK_MS + value=Math.min(cursorMs, totalMs)", () => {
    expect(body).toMatch(/← Recordings/);
    expect(body).toMatch(/\{playing \? 'Pause' : cursorMs >= totalMs \? 'Replay' : 'Play'\}/);
    expect(body).toMatch(
      /<input\s*\n?\s*type="range"\s*\n?\s*min=\{0\}\s*\n?\s*max=\{Math\.max\(totalMs, 1\)\}\s*\n?\s*value=\{Math\.min\(cursorMs, totalMs\)\}\s*\n?\s*step=\{TICK_MS\}\s*\n?\s*onChange=\{handleScrub\}/,
    );
  });

  it("Frame display branch: hydrating → 'Loading frames…' / hydrateError !== null → 'Couldn't load frames' error state + message + 'Try again' (onClick=loadFrames) / currentFrame === null → 'No frames captured' / else the frame itself is a click-to-play <button onClick={togglePlay}> wrapping <img src={currentFrame.dataUrl}> with a center play/pause glyph + a hover-revealed 'Space to play' hint — pinned so a read FAILURE reads distinctly from a genuinely empty recording (with a retry) and the frame doubles as the play/pause hit target like a video player", () => {
    expect(body).toMatch(
      /\{hydrating \? \(\s*\n?\s*<span className="section-label text-ink-muted">Loading frames…<\/span>\s*\n?\s*\) : hydrateError !== null \? \(/,
    );
    expect(body).toMatch(
      /<span className="section-label text-status-error">Couldn't load frames<\/span>/,
    );
    expect(body).toMatch(
      /<button type="button" className="btn-secondary" onClick=\{loadFrames\}>\s*\n?\s*Try again\s*\n?\s*<\/button>/,
    );
    // Empty-recording branch stays distinct from a hydrate failure.
    expect(body).toMatch(
      /\) : currentFrame === null \? \(\s*\n?\s*<span className="section-label text-ink-muted">No frames captured<\/span>\s*\n?\s*\) : \(/,
    );
    // The frame is now a play/pause button wrapping the img.
    expect(body).toMatch(
      /<button\s*\n?\s*type="button"\s*\n?\s*onClick=\{togglePlay\}\s*\n?\s*aria-label=\{playing \? 'Pause playback' : 'Play recording'\}[\s\S]*?<img\s*\n?\s*src=\{currentFrame\.dataUrl\}/,
    );
    // …with an honest hover-revealed keyboard hint for each state.
    expect(body).toContain("{playing ? 'Space to pause' : 'Space to play'}");
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
