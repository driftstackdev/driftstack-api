// The stage says `30 fps` beside a live video of the thing it is describing.
//
// Three review rounds refused to build this chip, and every one of them gave
// the same reason: a number printed next to a moving picture is checkable by
// eye, so it must be MEASURED or absent. What is built is the measured half —
// the frame rate — and the latency half the mockup also draws is still not
// built, because nothing in this app knows when the sender sent a frame.
//
// What this file holds, and each one is a way the chip could lie:
//
//   1. The number is the frames the browser actually presented, over a window
//      the test controls: 60 frames in 2 s is 30 fps, and it says so.
//   2. NOTHING until a whole window has been measured. The first second of a
//      stream is the encoder finding its feet.
//   3. NOTHING where the browser cannot count frames at all — no chip, not a
//      plausible 30 (the two old WebViews this app ships into).
//   4. NOTHING once the frames stop. A number that stays put over a frozen
//      picture is the worst of the three, because it is the one that looks
//      right.
//   5. It costs a render a second, not a render a frame. At 60 fps a chip that
//      re-rendered per frame would re-render this view 60 times a second for
//      the length of a task.
//   6. The loop is cancelled on unmount AND when the stream changes, or a torn
//      down view keeps doing per-frame work on an element it no longer shows.
//
// The clock and the video API are injected (`use-presented-frame-rate.ts`), so
// every one of those is a fact this file can establish in milliseconds rather
// than a thing someone watches for a while and believes.
//
// ⛔ WHAT A JSDOM TEST CANNOT SAY, said elsewhere: jsdom has no compositor, so
// `requestVideoFrameCallback` here is this file's fake. The shipped hook was
// also run in a real browser against a real `<video>` playing a real 30 fps
// MediaStream — it read `30`, it read `null` for the first window, it read
// `null` a second after the track was stopped, and it re-rendered 6 times in 9
// seconds rather than ~270. That evidence is in the stage report, not here.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import {
  frameRateOver,
  pruneFrameWindow,
  usePresentedFrameRate,
  type FrameRateClock,
  type FrameRateVideo,
  type FrameSample,
} from '../../src/lib/use-presented-frame-rate';
import { Stage } from '../../src/views/agent-chat/Stage';
import { stageCaption, stageHud, type StageWatch } from '../../src/views/agent-chat/stage-copy';

/** The live-view token fetch, answered. `get` is deliberately ABSENT rather
 *  than stubbed: the panel's 5s lifecycle poll bails when it is not a function,
 *  so the arms below run no interval of their own and the only timer in the
 *  tree is the measurement's. */
vi.mock('../../src/lib/SettingsContext', () => {
  const stable = {
    client: {
      agentSessions: {
        livekitToken: () =>
          Promise.resolve({
            ws_url: 'wss://live.example.com',
            room: 'agt_fps',
            token: 'scene-token',
            participant_identity: 'watcher',
            expires_at: '2026-06-15T07:42:00.000Z',
          }),
      },
    },
    settings: { apiKey: 'sk-test', baseUrl: 'https://api.example.test' },
  };
  return { useSettings: () => stable };
});
/**
 * ⛔ THE MOCK RENDERS A REAL `<video>` AND HANDS IT UP THE SAME WAY THE PANEL
 * DOES — a ref callback — because that hand-up is the thing round C's review
 * called missing. It reported the chip as unbuildable on the grounds that
 * "AgentSessionPanel exposes no such hook"; the hook (`onVideoEl`, Night-arc I)
 * was already there and only `LiveAutomationPanel` forwarding it was not. A
 * stub that ignored the prop would let that one line be deleted again with
 * every arm in this file still green.
 */
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: ({ onVideoEl }: { onVideoEl?: (el: HTMLVideoElement | null) => void }) => (
    <video data-testid="agent-session-panel" ref={onVideoEl} />
  ),
}));

afterEach(() => {
  cleanup();
});

/** Thirty frames a second, as whole milliseconds are not: 2000/60 is the
 *  spacing 60 frames over two seconds actually have. */
const FRAME_MS = 2000 / 60;

interface FakeClock extends FrameRateClock {
  /** Move the clock WITHOUT running anything — so a test can decide whether a
   *  frame arrives before or after the tick that lands on the same
   *  millisecond. */
  set: (t: number) => void;
  /** Run every interval that is now due, re-arming each as a real one does. */
  drain: () => void;
  /** How many intervals are still armed. Zero is the claim "this hook
   *  scheduled nothing", which is what the no-API case has to be. */
  armedTimers: () => number;
}

function fakeClock(): FakeClock {
  let t = 0;
  let nextId = 1;
  const timers = new Map<number, { fn: () => void; ms: number; dueAt: number }>();
  return {
    now: () => t,
    setInterval: (fn, ms) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { fn, ms, dueAt: t + ms });
      return id;
    },
    clearInterval: (handle) => {
      timers.delete(handle);
    },
    set: (next) => {
      t = next;
    },
    drain: () => {
      for (;;) {
        let dueId: number | null = null;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [id, timer] of timers) {
          if (timer.dueAt <= t && timer.dueAt < dueAt) {
            dueId = id;
            dueAt = timer.dueAt;
          }
        }
        if (dueId === null) return;
        const timer = timers.get(dueId);
        if (timer === undefined) return;
        timer.dueAt += timer.ms;
        timer.fn();
      }
    },
    armedTimers: () => timers.size,
  };
}

interface FakeVideo extends FrameRateVideo {
  /** Hand the compositor's callback one frame, at the clock's current time. */
  present: () => void;
  /** Is a frame callback outstanding? False after a cancel, which is how "the
   *  loop was stopped" is asserted without reaching into the hook. */
  armed: () => boolean;
  /** Every handle passed to `cancelVideoFrameCallback`, in order. */
  cancelled: () => ReadonlyArray<number>;
}

/**
 * A video element with no DOM behind it, in the three shapes the hook has to
 * handle: both APIs, the decoded-frame counter alone (the old WebViews), and
 * neither.
 *
 * ⛔ THE COUNTER STARTS HIGH ON PURPOSE. A real `totalVideoFrames` is a running
 * total for the life of the element, so a fallback that forgot to subtract its
 * baseline would report thousands of frames per second — and would report them
 * confidently. Starting at 0 here is the one fixture that could not catch it.
 */
function fakeVideo(
  clock: FakeClock,
  { rvfc = true, quality = true }: { rvfc?: boolean; quality?: boolean } = {},
): FakeVideo {
  let handles = 1;
  let pending: { handle: number; cb: (now: number) => void } | null = null;
  let presented = 0;
  const cancelledHandles: number[] = [];
  const video: FakeVideo = {
    present: () => {
      presented += 1;
      const waiting = pending;
      if (waiting === null) return;
      pending = null;
      waiting.cb(clock.now());
    },
    armed: () => pending !== null,
    cancelled: () => cancelledHandles,
  };
  if (rvfc) {
    video.requestVideoFrameCallback = (cb) => {
      const handle = handles;
      handles += 1;
      pending = { handle, cb };
      return handle;
    };
    video.cancelVideoFrameCallback = (handle) => {
      cancelledHandles.push(handle);
      if (pending?.handle === handle) pending = null;
    };
  }
  if (quality) video.getVideoPlaybackQuality = () => ({ totalVideoFrames: 5_000 + presented });
  return video;
}

/** One frame, presented at `at` — the clock moves first, so a tick due on the
 *  same millisecond sees the frame that arrived with it. */
function presentAt(clock: FakeClock, video: FakeVideo, at: number): void {
  act(() => {
    clock.set(at);
    video.present();
    clock.drain();
  });
}

/** Wall time passing with NO frames in it. */
function idleUntil(clock: FakeClock, at: number): void {
  act(() => {
    clock.set(at);
    clock.drain();
  });
}

describe('the frame rate is the frames the browser said it presented', () => {
  it('reads 30 from 60 frames presented over two seconds', () => {
    const clock = fakeClock();
    const video = fakeVideo(clock);
    const { result } = renderHook(() => usePresentedFrameRate({ video, live: true, clock }));

    for (let frame = 1; frame <= 60; frame += 1) presentAt(clock, video, frame * FRAME_MS);

    expect(result.current).toBe(30);
  });

  it('reads 60 from 120 frames over the same two seconds — the window is time, not a count', () => {
    // The other rate a device stream really runs at. If the window were a fixed
    // NUMBER of frames rather than a span of time, both fixtures would read the
    // same and only one of them would be right.
    const clock = fakeClock();
    const video = fakeVideo(clock);
    const { result } = renderHook(() => usePresentedFrameRate({ video, live: true, clock }));

    for (let frame = 1; frame <= 120; frame += 1) presentAt(clock, video, frame * (FRAME_MS / 2));

    expect(result.current).toBe(60);
  });

  it('says nothing until a whole window has been measured', () => {
    const clock = fakeClock();
    const video = fakeVideo(clock);
    const { result } = renderHook(() => usePresentedFrameRate({ video, live: true, clock }));

    // A full second of frames — enough to compute a rate from, and the wrong
    // moment to show one.
    for (let frame = 1; frame <= 30; frame += 1) presentAt(clock, video, frame * FRAME_MS);
    expect(result.current).toBeNull();

    // …and one frame short of the window, still nothing.
    for (let frame = 31; frame <= 59; frame += 1) presentAt(clock, video, frame * FRAME_MS);
    expect(result.current).toBeNull();

    // The frame that completes it.
    presentAt(clock, video, 60 * FRAME_MS);
    expect(result.current).toBe(30);
  });

  it('loses the number when the frames stop, rather than holding the last one', () => {
    const clock = fakeClock();
    const video = fakeVideo(clock);
    const { result } = renderHook(() => usePresentedFrameRate({ video, live: true, clock }));
    for (let frame = 1; frame <= 60; frame += 1) presentAt(clock, video, frame * FRAME_MS);
    expect(result.current).toBe(30);

    // A HICCUP IS NOT A FREEZE. Half a second with no frame: the window still
    // holds two seconds of real frames and the rate they arrived at is still
    // the right thing to show. A chip that blinked off for every stutter would
    // be its own kind of noise.
    idleUntil(clock, 2_500);
    expect(result.current).toBe(30);

    // The picture is FROZEN: a whole emit tick has passed with no frame in it,
    // which is the boundary — the last rate is now a claim about the past.
    idleUntil(clock, 3_500);
    expect(result.current).toBeNull();
  });

  it('counts a stream that never starts as no number at all', () => {
    const clock = fakeClock();
    const video = fakeVideo(clock);
    const { result } = renderHook(() => usePresentedFrameRate({ video, live: true, clock }));

    idleUntil(clock, 10_000);

    expect(result.current).toBeNull();
  });
});

describe('where the browser cannot count frames there is no chip', () => {
  it('reports nothing, for ever, and schedules nothing, when neither frame API exists', () => {
    const clock = fakeClock();
    const video = fakeVideo(clock, { rvfc: false, quality: false });
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return usePresentedFrameRate({ video, live: true, clock });
    });

    for (let frame = 1; frame <= 300; frame += 1) presentAt(clock, video, frame * FRAME_MS);

    expect(result.current).toBeNull();
    // Not "no number but a timer anyway": an element this hook cannot measure
    // costs nothing at all.
    expect(clock.armedTimers()).toBe(0);
    expect(renders).toBe(1);
  });

  it('falls back to the decoded-frame counter where requestVideoFrameCallback is missing', () => {
    // The old WKWebView / WebKitGTK shape: no per-frame callback, but the
    // element still keeps a running total of the frames it decoded.
    const clock = fakeClock();
    const video = fakeVideo(clock, { rvfc: false, quality: true });
    const { result } = renderHook(() => usePresentedFrameRate({ video, live: true, clock }));

    for (let frame = 1; frame <= 60; frame += 1) presentAt(clock, video, frame * FRAME_MS);

    // Not 5_030: the counter's baseline is taken when the loop arms, so the
    // number is frames-since-then and not frames-since-the-element-existed.
    expect(result.current).toBe(30);
  });

  it('loses the number on the decoded-frame counter too, once the picture freezes', () => {
    // ⛔ THE STALENESS RULE WAS UNREACHABLE ON THIS PATH, AND IT IS THE PATH THE
    // TWO OLD WEBVIEWS TAKE. `frameRateOver` refuses a reading a whole emit
    // tick old — that is the arm that makes a freeze visible within a second
    // rather than holding a rate over a motionless picture. The fallback
    // recorded a sample at `now` on EVERY tick, including ticks in which the
    // counter had not moved, so `now - last.at` was 0 for ever and the rule
    // could never fire here. What the window held instead was 60 real frames
    // spread over a 2 s span that was half freeze, so the chip read `15 fps`
    // beside a picture that had stopped — measured, and the exact shape of
    // plausible wrong number this whole chip exists not to print.
    //
    // A tick with no frame in it now records NOTHING, so the newest reading
    // stays where the frames stopped and the existing rule fires on it, which
    // is what the rVFC path two describes above has always done.
    const clock = fakeClock();
    const video = fakeVideo(clock, { rvfc: false, quality: true });
    const { result } = renderHook(() => usePresentedFrameRate({ video, live: true, clock }));
    for (let frame = 1; frame <= 60; frame += 1) presentAt(clock, video, frame * FRAME_MS);
    expect(result.current).toBe(30);

    // THE SAME TOLERANCE THE rVFC PATH HAS, and the point of the arm is that it
    // is the same: half a second with the counter standing still is a hiccup
    // and the number stays. (2_500 and 3_500 rather than 3_000 and 4_000 on
    // purpose — the boundary is exactly one emit tick and a fixture that stands
    // on it is a float knife-edge: 60 frames at 2000/60 ms land the last one at
    // 2000.0000000000002, so a tick at 3_000 is 999.9999999999998 ms old and
    // reads as fresh. This arm straddles the boundary instead of sitting on
    // it.)
    idleUntil(clock, 2_500);
    expect(result.current).toBe(30);
    // A whole tick with no frame in it: the picture is frozen and the number
    // goes, rather than decaying through a sequence of halves.
    idleUntil(clock, 3_500);
    expect(result.current).toBeNull();
    idleUntil(clock, 4_500);
    expect(result.current).toBeNull();

    // POSITIVE CONTROL — the loop was not killed, only quietened: the counter
    // moving again brings a number back. (It reads LOW for up to one window
    // after a gap, on this path and on rVFC alike, because the rate is the mean
    // over the window and the window still straddles the freeze — the hook says
    // so in its own words, and that is a separate question from this arm.)
    for (let frame = 1; frame <= 60; frame += 1) {
      presentAt(clock, video, 4_500 + frame * FRAME_MS);
    }
    expect(result.current).not.toBeNull();
  });
});

describe('the measurement stops when the thing it measures does', () => {
  it('cancels the frame callback when the view goes away', () => {
    const clock = fakeClock();
    const video = fakeVideo(clock);
    const { unmount } = renderHook(() => usePresentedFrameRate({ video, live: true, clock }));
    presentAt(clock, video, FRAME_MS);
    expect(video.armed()).toBe(true);
    expect(clock.armedTimers()).toBe(1);

    unmount();

    expect(video.cancelled()).toHaveLength(1);
    expect(video.armed()).toBe(false);
    expect(clock.armedTimers()).toBe(0);
  });

  it('cancels the old element and arms the new one when the stream changes', () => {
    // A reconnect replaces the <video>. Two live callback chains on two
    // elements is the shape the simulator's own night audit found: the old
    // chain keeps running and its frames keep being counted.
    const clock = fakeClock();
    const first = fakeVideo(clock);
    const second = fakeVideo(clock);
    const { rerender } = renderHook(
      ({ video }: { video: FrameRateVideo }) => usePresentedFrameRate({ video, live: true, clock }),
      { initialProps: { video: first } },
    );
    presentAt(clock, first, FRAME_MS);
    expect(first.armed()).toBe(true);

    rerender({ video: second });

    expect(first.cancelled()).toHaveLength(1);
    expect(first.armed()).toBe(false);
    expect(second.armed()).toBe(true);
    // One loop, not two.
    expect(clock.armedTimers()).toBe(1);
  });

  it('stops measuring when the screen stops showing a live picture', () => {
    const clock = fakeClock();
    const video = fakeVideo(clock);
    const { result, rerender } = renderHook(
      ({ live }: { live: boolean }) => usePresentedFrameRate({ video, live, clock }),
      { initialProps: { live: true } },
    );
    for (let frame = 1; frame <= 60; frame += 1) presentAt(clock, video, frame * FRAME_MS);
    expect(result.current).toBe(30);

    rerender({ live: false });

    expect(result.current).toBeNull();
    expect(video.armed()).toBe(false);
    expect(clock.armedTimers()).toBe(0);
  });
});

describe('a frame costs no React render', () => {
  it('re-renders once a second at most, not once a frame', () => {
    const clock = fakeClock();
    const video = fakeVideo(clock);
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return usePresentedFrameRate({ video, live: true, clock });
    });

    // Four seconds of a steady 30 fps stream: 120 frames.
    for (let frame = 1; frame <= 120; frame += 1) presentAt(clock, video, frame * FRAME_MS);

    expect(result.current).toBe(30);
    // The mount, and the one tick where the number went from nothing to 30. The
    // three later ticks re-read the same whole number and bail out of the state
    // update entirely, so a stream sitting at one rate costs NOTHING after the
    // first second — measured, not assumed.
    expect(renders).toBe(2);
  });
});

describe('the window arithmetic, on its own', () => {
  it('keeps the sample that straddles the left edge so the span is the whole window', () => {
    // Drop it and the window measures from the first sample INSIDE the edge,
    // which shortens the denominator and reads high.
    const samples: FrameSample[] = [
      { at: 0, frames: 0 },
      { at: 900, frames: 27 },
      { at: 1_100, frames: 33 },
      { at: 3_000, frames: 90 },
    ];
    pruneFrameWindow(samples, 3_000);
    // The 900ms reading is OUTSIDE the 2s window and is the one kept: it is the
    // left edge. The 0ms one, which a second reading has now superseded, goes.
    expect(samples[0]).toEqual({ at: 900, frames: 27 });
    expect(samples).toHaveLength(3);
  });

  it('refuses a rate it cannot support', () => {
    const now = 5_000;
    expect(frameRateOver([{ at: 4_000, frames: 1 }], now)).toBeNull();
    // Time that did not move.
    expect(
      frameRateOver(
        [
          { at: 5_000, frames: 1 },
          { at: 5_000, frames: 9 },
        ],
        now,
      ),
    ).toBeNull();
    // Frames that did not arrive: a still picture is not a 0 fps picture.
    expect(
      frameRateOver(
        [
          { at: 3_000, frames: 7 },
          { at: 5_000, frames: 7 },
        ],
        now,
      ),
    ).toBeNull();
    // A rate that rounds to zero reads as a broken chip; nothing is honest.
    // (One frame in four seconds — the tolerance is widened so this arm is
    // about the rounding and not about the staleness rule above.)
    expect(
      frameRateOver(
        [
          { at: 1_000, frames: 7 },
          { at: 5_000, frames: 8 },
        ],
        now,
        4_000,
      ),
    ).toBeNull();
    // POSITIVE CONTROL — the shape all four of those are refusals of.
    expect(
      frameRateOver(
        [
          { at: 3_000, frames: 0 },
          { at: 5_000, frames: 60 },
        ],
        now,
      ),
    ).toBe(30);
    // …and the newest reading being older than a tick is a stream that stopped.
    expect(
      frameRateOver(
        [
          { at: 1_000, frames: 0 },
          { at: 3_000, frames: 60 },
        ],
        now,
      ),
    ).toBeNull();
  });
});

// ─── and what the stage does with the number ────────────────────────────────

const LIVE_HUD = stageHud({ watch: 'live', session: 'open', sending: true });
const LIVE_CAPTION = stageCaption({ phase: 'acting', livePhase: 'Looking at the page…' });

function renderStage(overrides: { watch?: StageWatch; frameRate?: number } = {}): void {
  render(
    <Stage
      sessionId="agt_fps"
      collapsed={false}
      hud={LIVE_HUD}
      caption={LIVE_CAPTION}
      place={null}
      watch={overrides.watch ?? 'live'}
      session="open"
      hasSession
      atRest={false}
      steps={3}
      idleFact="You watch, the AI drives — and you can stop it at any time."
      onWatchChange={() => undefined}
      standIn={<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="" aria-hidden="true" />}
      frameRate={overrides.frameRate}
    />,
  );
}

describe('the stage shows the frame rate only where there is a live picture', () => {
  it('shows it in both tiers at once, one of them hidden by the tier CSS', () => {
    // Two elements rather than one moved between parents: the facts row under
    // the phone is gone at 252px and the fact rides up into the HUD, which is
    // the treatment the place chip beside it already has.
    renderStage({ frameRate: 30 });
    const chips = document.querySelectorAll('.ai-fps');
    expect(chips).toHaveLength(2);
    expect(document.querySelectorAll('.ai-fps-inline')).toHaveLength(1);
    for (const chip of chips) expect(chip.textContent).toBe('30 fps');
  });

  it('hides the ticking number from the screen reader, which is told the state in words', () => {
    // The same rule the live clock follows: a leaf that rewrites itself once a
    // second is noise, and everything it means — live, read-only, which step —
    // is already announced as text by the log and the chip beside it.
    renderStage({ frameRate: 30 });
    for (const chip of document.querySelectorAll('.ai-fps')) {
      expect(chip.getAttribute('aria-hidden')).toBe('true');
    }
    expect(screen.queryByText('30 fps', { ignore: '[aria-hidden="true"]' })).toBeNull();
  });

  it('says nothing while the screen is not showing a live picture', () => {
    // A stand-in, a placeholder, a reconnect and an ended session are all
    // states in which a frame rate would be a claim about a picture that is not
    // there. The fixture is set in every one of these and changes nothing.
    for (const watch of ['idle', 'loading', 'simulated', 'error', 'ended'] as const) {
      renderStage({ watch, frameRate: 30 });
      expect(document.querySelectorAll('.ai-fps'), watch).toHaveLength(0);
      cleanup();
    }
  });

  it('shows nothing in the app, where no video has been measured yet', () => {
    // No fixture and no <video> (jsdom mounts none): the chip is absent rather
    // than showing a dash, a zero or a remembered number.
    renderStage();
    expect(document.querySelectorAll('.ai-fps')).toHaveLength(0);
    // …and the facts row is honestly marked empty, so the stage gives the band
    // back to the phone instead of reserving 22px for a chip that never came.
    expect(document.querySelector('.ai-facts')?.hasAttribute('data-empty')).toBe(true);
  });

  it('POSITIVE CONTROL — the same stage with a number shows it and is not marked empty', () => {
    renderStage({ frameRate: 30 });
    expect(document.querySelector('.ai-facts')?.hasAttribute('data-empty')).toBe(false);
    expect(document.querySelector('.ai-facts')?.textContent).toContain('30 fps');
  });
});

// ─── and the one thing the text gate cannot check for itself ────────────────

/** Comments stripped: this file's own rules explain in prose why they carry no
 *  colour, and a scan that read the prose could never go green. */
const CSS = readFileSync(resolve(__dirname, '../../src/styles/index.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** One rule's declarations, by exact selector. Throws when the selector is
 *  gone, so a rename reds here rather than passing as "this rule no longer says
 *  the forbidden thing". */
function rule(selector: string): string {
  const escaped = selector.replace(/[.[\]*'()+:]/g, (c) => `\\${c}`);
  const match = new RegExp(`(^|\\n)${escaped} \\{([^}]*)\\}`).exec(CSS);
  if (match === null) throw new Error(`no CSS rule for ${selector}`);
  return match[2] ?? '';
}

describe('the chip borrows its contrast from the chip beside it', () => {
  it('declares no colour of its own, because the gate cannot measure this one', () => {
    // ⛔ `scripts/gui-text-quality.mjs` exempts anything under
    // `aria-hidden="true"` from its CONTRAST check — and the chip has to be
    // aria-hidden, because it rewrites itself once a second. So its contrast is
    // proved by CONSTRUCTION instead: it is the bare `.ai-chip`, whose ink and
    // surface the gate DOES measure on this same surface in both themes, on the
    // place chip sitting next to it. The moment this rule grows a colour, that
    // proof is gone and nothing else would notice.
    //
    // Measured by hand in a real browser at both stage sizes and in both
    // themes: 9.85:1 (rgb(203 213 225) on rgb(30 41 59)) — the stage is a dark
    // room in the light theme too, so all four cells are the same pair.
    const body = rule('.ai-fps');
    expect(body).not.toMatch(/(^|[\s;])color\s*:/);
    expect(body).not.toMatch(/background/);
    // What it IS for: whole seconds change the digits, and proportional figures
    // would change the chip's width with them.
    expect(body).toContain('font-variant-numeric: tabular-nums');
  });

  it('shows exactly one of its two copies at any width', () => {
    // The HUD copy is hidden everywhere except the narrow tier, where the facts
    // row under the phone is gone. Both halves are asserted: a rule that hid it
    // and never showed it again would leave the minimum window — the one the
    // gate measures at 960x600 — with no chip at all.
    expect(rule('.ai-fps-inline')).toContain('display: none');
    expect(rule('[data-ai-narrow] .ai-fps-inline')).toContain('display: inline-flex');
  });

  it('does not move sideways when the device finally says where it is browsing from', () => {
    // ⛔ THE SECOND FACT IN THE HUD BROKE THE FIRST ONE'S WAY OF STAYING RIGHT.
    // The narrow HUD is 236px and reads left to right as "what the stage is
    // doing", then the facts hard against the right edge. While the place chip
    // was the only thing after the state chip, `.ai-facts-inline { margin-left:
    // auto }` was the whole mechanism. It is not, now: `browsingFrom()` returns
    // null until the device's capability report lands (a 10s poll), and in that
    // window this chip is the ONLY trailing child and has no auto margin.
    //
    // Measured in a real browser at 960x600, with the place chip removed
    // exactly as `place === null` renders it: the chip sat at x=338.7 — flush
    // against LIVE, 106px of empty room to its right — and jumped to x=444.5
    // the moment the place arrived, seconds into the same session.
    //
    // The auto margin therefore belongs to the state chip's RIGHT, where it is
    // the single one whatever follows it. jsdom lays nothing out, so what this
    // arm can hold is the mechanism: ONE auto margin in the narrow HUD, and the
    // place chip's cancelled — two of them share the free space between them
    // instead of pushing the group.
    expect(rule('[data-ai-narrow] .ai-hud > .ai-chip-state')).toContain('margin-right: auto');
    expect(rule('[data-ai-narrow] .ai-hud > .ai-facts-inline')).toContain('margin-left: 0');
    // …and it stays in the narrow tier. In the wide tier `.ai-hud-note` sits
    // between the state chip and the facts, so the same margin on the base rule
    // would shove that sentence to the right edge of the stage.
    expect(rule('.ai-chip-state')).not.toMatch(/margin/);
  });
});

// ─── the whole chain, inside the view's own tree ────────────────────────────

/** Everything `VideoFrameCallbackMetadata` requires. The hook reads none of it
 *  — it takes its time from the injected clock so both measurement paths share
 *  one time base — but the browser passes it and a fixture that omitted it
 *  would not be the browser's shape. */
const FRAME_METADATA: VideoFrameCallbackMetadata = {
  expectedDisplayTime: 0,
  height: 874,
  mediaTime: 0,
  presentationTime: 0,
  presentedFrames: 0,
  width: 402,
};

describe('the element the panel paints into reaches the chip', () => {
  const rvfc: { callback: VideoFrameRequestCallback | null; cancels: number } = {
    callback: null,
    cancels: 0,
  };

  beforeEach(() => {
    rvfc.callback = null;
    rvfc.cancels = 0;
    // jsdom's <video> has no frame callback, so the API is put on the prototype
    // — which is also what makes the hook's `.bind(video)` and its runtime
    // `typeof` check run against a real element rather than a literal.
    HTMLVideoElement.prototype.requestVideoFrameCallback = (callback) => {
      rvfc.callback = callback;
      return 1;
    };
    HTMLVideoElement.prototype.cancelVideoFrameCallback = () => {
      rvfc.cancels += 1;
      rvfc.callback = null;
    };
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback;
    delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).cancelVideoFrameCallback;
  });

  /** One presented frame, `gap` ms after the last one. */
  function presentFrame(gap: number): void {
    act(() => {
      vi.advanceTimersByTime(gap);
    });
    act(() => {
      rvfc.callback?.(performance.now(), FRAME_METADATA);
    });
  }

  it('turns frames the panel presented into the number on the stage', async () => {
    render(
      <Stage
        sessionId="agt_fps"
        collapsed={false}
        hud={LIVE_HUD}
        caption={LIVE_CAPTION}
        place={null}
        watch="live"
        session="open"
        hasSession
        atRest={false}
        steps={3}
        idleFact="You watch, the AI drives — and you can stop it at any time."
        onWatchChange={() => undefined}
      />,
    );
    // The token resolves, the panel mounts its <video>, and the ref hands it up.
    await act(async () => {
      await Promise.resolve();
    });
    expect(await screen.findByTestId('agent-session-panel')).toBeInTheDocument();
    expect(rvfc.callback).not.toBeNull();

    // Sixty frames at 30 fps, then the tick that closes the first window.
    for (let frame = 1; frame <= 60; frame += 1) presentFrame(33);
    expect(document.querySelector('.ai-fps')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(30);
    });

    expect(document.querySelectorAll('.ai-fps')).toHaveLength(2);
    expect(document.querySelector('.ai-fps')?.textContent).toBe('30 fps');
  });
});
