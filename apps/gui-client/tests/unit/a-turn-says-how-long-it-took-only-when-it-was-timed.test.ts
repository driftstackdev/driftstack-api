// §7 (stage 3) — A TURN SAYS HOW LONG IT TOOK ONLY WHEN IT WAS TIMED.
//
// Stage 3 gives the timeline real data: per-step durations, an elapsed clock,
// step kinds, and the boundary where the agent looked at the page and made a
// new plan. Every one of those is OPTIONAL and ADDITIVE, and the reason is not
// politeness to old servers — it is that this client is the only thing that
// measures them, and it is not always watching:
//
//   · a chat reopened from disk was stored by a build that never had them;
//   · a chat stored by THIS build, on a device where the customer closed the
//     window mid-turn, has some and not others;
//   · a response the server REPLAYED from its idempotency store arrives with no
//     frames at all — the client saw the answer and nothing else;
//   · a step whose `step_start` frame never arrived has no start time, and
//     therefore no duration, even though the steps around it do.
//
// ⛔ THE RULE EVERY ARM BELOW IS ABOUT: an unknown duration is an ABSENCE, never
// a zero. "0.0s" under a step that took four seconds is not a rounder truth, it
// is a false one — and a column of zeros reads as a broken product rather than
// as a client that was not watching. So each of these functions returns null /
// omits the field for everything it cannot state, and the components render
// nothing at all when they get one.
//
// These are the PURE halves — the formatting, the fold, the settle-time copy —
// so the rule can be stated without a server, a clock or a DOM. The rendered
// halves are in a-turn-without-timing-renders-no-clock-and-no-zeros.test.tsx.

import { describe, expect, it } from 'vitest';
import {
  elapsedSince,
  formatElapsed,
  formatStepDuration,
} from '../../src/views/agent-chat/durations';
import { planSegments } from '../../src/views/agent-chat/PlanTimeline';
import { mergeLivePlan, observedTurn, stepKindOf } from '../../src/lib/use-agent-chat';

describe('a step duration is printed only when the step was really timed', () => {
  it('prints the seconds a step took, to one decimal, the way the design shows them', () => {
    expect(formatStepDuration(3100)).toBe('3.1s');
    expect(formatStepDuration(1400)).toBe('1.4s');
    expect(formatStepDuration(14_600)).toBe('14.6s');
    // A whole number of seconds keeps its decimal, so a column of durations
    // stays a column rather than jumping a character wide.
    expect(formatStepDuration(6000)).toBe('6.0s');
  });

  it('switches to a clock once a single step has run for a minute', () => {
    expect(formatStepDuration(60_000)).toBe('1:00');
    expect(formatStepDuration(124_000)).toBe('2:04');
    // 59.9s is still seconds — the switch is at the minute, not near it.
    expect(formatStepDuration(59_900)).toBe('59.9s');
  });

  it('⛔ says NOTHING for a step it has no measurement of — never "0.0s"', () => {
    expect(formatStepDuration(null)).toBeNull();
    expect(formatStepDuration(undefined)).toBeNull();
    expect(formatStepDuration(Number.NaN)).toBeNull();
    expect(formatStepDuration(Number.POSITIVE_INFINITY)).toBeNull();
    // A negative duration is a clock that moved, not a step that took no time.
    expect(formatStepDuration(-4000)).toBeNull();
  });

  it('⛔ and says nothing for a measurement too small to print honestly', () => {
    // 12ms rounds to "0.0s" in the one-decimal form, which claims the step took
    // no time at all. Below the floor the row is simply silent.
    expect(formatStepDuration(12)).toBeNull();
    expect(formatStepDuration(49)).toBeNull();
    // Just above it, the number is printable and is printed.
    expect(formatStepDuration(50)).toBe('0.1s');
  });
});

describe('a turn clock is m:ss, and absent when the turn was never started', () => {
  it('reads the way the flight strip shows it', () => {
    expect(formatElapsed(41_000)).toBe('0:41');
    expect(formatElapsed(72_000)).toBe('1:12');
    expect(formatElapsed(19_000)).toBe('0:19');
  });

  it('⛔ a turn one second old says 0:00 — unlike a step, a clock at zero is the truth', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(400)).toBe('0:00');
  });

  it('does not wrap the minutes at an hour, because a wrapped clock would be a lie', () => {
    // A turn is capped near 50 minutes, so this is defensive — but "2:03" an
    // hour in would read as two minutes, and "62:03" cannot be misread.
    expect(formatElapsed(3_723_000)).toBe('62:03');
  });

  it('says nothing for a turn with no start time, or a clock that ran backwards', () => {
    expect(formatElapsed(null)).toBeNull();
    expect(formatElapsed(undefined)).toBeNull();
    expect(elapsedSince(null, 1_000_000)).toBeNull();
    expect(elapsedSince(undefined, 1_000_000)).toBeNull();
    expect(elapsedSince(1_000_000, 900_000)).toBeNull();
  });

  it('counts from the send, so the wait before anything is announced is in it', () => {
    expect(elapsedSince(1_000_000, 1_041_000)).toBe('0:41');
  });
});

describe('what a settled turn keeps from the stream this client watched', () => {
  const EMPTY = { plan: null, startedAt: null, settledAt: 5_000, stepMs: [] as const };

  it('keeps nothing at all when nothing was observed — the turn is exactly what it was before §7', () => {
    expect(observedTurn(EMPTY)).toEqual({});
  });

  it('⛔ a send with a start time but NO frames is not timed — this is the replayed response', () => {
    // The server replays a stored terminal for an idempotent re-send: the
    // answer arrives whole, no plan and no steps stream, and the wall time is
    // how long the replay took. Timing it would put "0:02" under six steps
    // that really took a minute.
    expect(observedTurn({ ...EMPTY, startedAt: 1_000, settledAt: 3_000 })).toEqual({});
  });

  it('times the turn once at least one frame of it was seen', () => {
    expect(
      observedTurn({
        plan: { labels: ['Open the store'], total: 1 },
        startedAt: 1_000,
        settledAt: 42_000,
        stepMs: [],
      }),
    ).toEqual({ plan: { labels: ['Open the store'] }, timing: { elapsedMs: 41_000 } });
  });

  it('keeps the kinds and the re-plan boundaries when the plan carried them, and omits them when it did not', () => {
    const rich = observedTurn({
      plan: {
        labels: ['Open the store', 'Search', 'Read the price'],
        total: 3,
        kinds: ['navigate', 'type', 'read'],
        replanAt: [2],
      },
      startedAt: 1_000,
      settledAt: 2_000,
      stepMs: [],
    });
    expect(rich.plan).toEqual({
      labels: ['Open the store', 'Search', 'Read the price'],
      kinds: ['navigate', 'type', 'read'],
      replanAt: [2],
    });
    const plain = observedTurn({
      plan: { labels: ['Open the store'], total: 1 },
      startedAt: null,
      settledAt: 2_000,
      stepMs: [],
    });
    expect(plain.plan).toEqual({ labels: ['Open the store'] });
    expect('kinds' in (plain.plan ?? {})).toBe(false);
    expect('replanAt' in (plain.plan ?? {})).toBe(false);
  });

  it('⛔ drops a step-duration array in which nothing was ever measured, rather than storing a row of nulls', () => {
    const none = observedTurn({ ...EMPTY, stepMs: [null, null, null] });
    // `stepMs.length > 0` still counts as "this client watched the turn", so
    // the absence being asserted is the ARRAY, not the whole record.
    expect(none.timing).toBeUndefined();
    const some = observedTurn({ ...EMPTY, stepMs: [null, 4200, null] });
    expect(some.timing).toEqual({ stepMs: [null, 4200, null] });
  });

  it('never reports a negative elapsed time when the system clock moves mid-turn', () => {
    const back = observedTurn({
      plan: { labels: ['Open the store'], total: 1 },
      startedAt: 90_000,
      settledAt: 10_000,
      stepMs: [],
    });
    expect(back.timing).toEqual({ elapsedMs: 0 });
  });
});

describe('mergeLivePlan folds the new §7 companions without changing its old shape', () => {
  it('⛔ a server that sends no kinds and no re-plans produces EXACTLY the object it always did', () => {
    // The shape pin: `a-turn-of-several-segments-renders-as-one-step-list`
    // compares this with toEqual, and an always-present `kinds: [null, null]`
    // would both break it and render a row of hollow nodes as if measured.
    const merged = mergeLivePlan(null, { labels: ['Opening the site', 'Waiting'], total: 2 });
    expect(Object.keys(merged).sort()).toEqual(['labels', 'total']);
  });

  it('keeps a kind per caption, at the offset the frame states', () => {
    const first = mergeLivePlan(null, {
      labels: ['Open the store', 'Search'],
      total: 2,
      kinds: ['navigate', 'type'],
    });
    expect(first.kinds).toEqual(['navigate', 'type']);
    const second = mergeLivePlan(first, {
      labels: ['Read the price'],
      total: 3,
      offset: 2,
      kinds: ['read'],
    });
    expect(second.labels).toEqual(['Open the store', 'Search', 'Read the price']);
    expect(second.kinds).toEqual(['navigate', 'type', 'read']);
  });

  it('a frame with captions but no kinds leaves those slots unknown rather than borrowing a neighbour’s', () => {
    const first = mergeLivePlan(null, {
      labels: ['Open the store'],
      total: 1,
      kinds: ['navigate'],
    });
    const second = mergeLivePlan(first, { labels: ['Tap something'], total: 2, offset: 1 });
    expect(second.kinds).toEqual(['navigate', null]);
  });

  it('marks a re-plan boundary where the new segment starts, and only when the agent really re-planned', () => {
    const first = mergeLivePlan(null, { labels: ['a', 'b', 'c'], total: 3 });
    const replanned = mergeLivePlan(first, {
      labels: ['c again', 'd'],
      total: 4,
      offset: 3,
      replan: true,
    });
    expect(replanned.replanAt).toEqual([3]);
    // Carrying on with the SAME plan is not a re-plan and earns no row.
    const continued = mergeLivePlan(first, { labels: ['d'], total: 4, offset: 3 });
    expect(continued.replanAt).toBeUndefined();
  });

  it('⛔ never marks the FIRST plan as a re-plan — nobody changed their mind before there was a plan', () => {
    const first = mergeLivePlan(null, { labels: ['a'], total: 1, replan: true });
    expect(first.replanAt).toBeUndefined();
  });

  it('keeps earlier boundaries, in order, and never records one twice', () => {
    let plan = mergeLivePlan(null, { labels: ['a', 'b'], total: 2 });
    plan = mergeLivePlan(plan, { labels: ['c'], total: 3, offset: 2, replan: true });
    plan = mergeLivePlan(plan, { labels: ['d'], total: 4, offset: 3, replan: true });
    // The same frame arriving twice (a reconnect replaying it) must not draw
    // two "looked at the page" rows in the same place.
    plan = mergeLivePlan(plan, { labels: ['d'], total: 4, offset: 3, replan: true });
    expect(plan.replanAt).toEqual([2, 3]);
  });
});

describe('the kind of a planned step is read, never inferred', () => {
  it('reports the ACTION of an interact step, because "interact" is not a picture', () => {
    expect(stepKindOf({ kind: 'interact', action: 'tap', selector: '#buy' })).toBe('tap');
    expect(stepKindOf({ kind: 'interact', action: 'type', value: 'shoes' })).toBe('type');
  });

  it('reports the kind of everything else', () => {
    expect(stepKindOf({ kind: 'navigate', url: 'https://shop.example.com/' })).toBe('navigate');
    expect(stepKindOf({ kind: 'capture', capture: 'screenshot' })).toBe('capture');
    expect(stepKindOf({ kind: 'behavioral_pause' })).toBe('behavioral_pause');
  });

  it('⛔ falls back to the kind — never to a guess from the selector — when an interact has no action', () => {
    expect(stepKindOf({ kind: 'interact', selector: '#buy' })).toBe('interact');
  });

  it('says nothing about a step there is nothing to read', () => {
    expect(stepKindOf(null)).toBeNull();
    expect(stepKindOf(undefined)).toBeNull();
    expect(stepKindOf({})).toBeNull();
    expect(stepKindOf({ kind: '' })).toBeNull();
    expect(stepKindOf('navigate')).toBeNull();
  });
});

describe('a turn is cut into one list per plan it ran', () => {
  it('⛔ a turn that never re-planned is ONE span — the single list this rendered before §7', () => {
    expect(planSegments(6, undefined)).toEqual([{ from: 0, to: 6 }]);
    expect(planSegments(6, [])).toEqual([{ from: 0, to: 6 }]);
  });

  it('cuts at each boundary, so the steps below one sit under the row that describes it', () => {
    expect(planSegments(6, [3])).toEqual([
      { from: 0, to: 3 },
      { from: 3, to: 6 },
    ]);
    expect(planSegments(6, [2, 4])).toEqual([
      { from: 0, to: 2 },
      { from: 2, to: 4 },
      { from: 4, to: 6 },
    ]);
  });

  it('⛔ cannot produce an empty or overlapping list from a nonsense boundary', () => {
    // 0 is the start of the first plan, 6 and 9 are past the end, and 3
    // arriving twice must not open a second empty list.
    expect(planSegments(6, [0, 6, 9, 3, 3, -2, 2.5])).toEqual([
      { from: 0, to: 3 },
      { from: 3, to: 6 },
    ]);
    expect(planSegments(0, [1])).toEqual([{ from: 0, to: 0 }]);
  });
});
