// S13 audit fix #13 — a moved account with no current window still shows the
// credit it holds.
//
// The old status shape for a moved account forced `cap_cents` and
// `remaining_cents` to 0 whenever there was no current window (coverage lapsed,
// or not granted yet). §8.6 has no such condition: the cap is the window's
// level PLUS every other live grant, and remaining is the spendable balance. So
// an account with lapsed coverage and a 500-credit goodwill lot read "cap 0,
// remaining 0" while its turns went on running on that goodwill credit.
//
// Now the missing window only makes the LEVEL 0 (and `used`, which is what the
// window's own lots were charged): the other live grants and the spendable
// balance count as they always did. The month still falls back to the calendar
// month, the legacy shape's own default.

import { describe, expect, it } from 'vitest';
import {
  movedAccountCreditsView,
  startOfCalendarMonthUtc,
} from '../../src/services/bundled-llm.js';

const MICRO = 1_000_000;
const NOW = new Date('2026-09-23T12:34:56.000Z');

describe('a moved account without a window still counts its other credits', () => {
  it('CRITICAL a 500-credit goodwill lot and no window: cap 500, remaining 500 — not 0 and 0', () => {
    const view = movedAccountCreditsView({
      aiSource: 'credits',
      currentWindow: null,
      otherLiveGrantedMicro: 500 * MICRO,
      spendableMicro: 500 * MICRO,
      chargedInWindowMicro: 0,
      now: NOW,
    });
    expect(view).toEqual({
      consent: true,
      capCents: 500,
      usedThisMonthCents: 0,
      remainingCents: 500,
      monthStartedAt: startOfCalendarMonthUtc(NOW),
    });
  });

  it('remaining is the spendable balance, partly spent goodwill included (floored)', () => {
    const view = movedAccountCreditsView({
      aiSource: null,
      currentWindow: null,
      otherLiveGrantedMicro: 500 * MICRO,
      spendableMicro: 123 * MICRO + 999_999,
      chargedInWindowMicro: 0,
      now: NOW,
    });
    expect(view.capCents).toBe(500);
    expect(view.remainingCents).toBe(123);
  });

  it('used is 0 with no window: nothing was charged to a window that does not exist, whatever the caller passes', () => {
    const view = movedAccountCreditsView({
      aiSource: 'credits',
      currentWindow: null,
      otherLiveGrantedMicro: 0,
      spendableMicro: 0,
      chargedInWindowMicro: 42 * MICRO,
      now: NOW,
    });
    expect(view.usedThisMonthCents).toBe(0);
  });

  it('CONTROL — no window and no other credit really is 0 and 0', () => {
    const view = movedAccountCreditsView({
      aiSource: 'own_key',
      currentWindow: null,
      otherLiveGrantedMicro: 0,
      spendableMicro: 0,
      chargedInWindowMicro: 0,
      now: NOW,
    });
    expect(view).toMatchObject({ consent: false, capCents: 0, remainingCents: 0 });
  });

  it('CONTROL — with a window, the level still adds to the other grants exactly as before', () => {
    const view = movedAccountCreditsView({
      aiSource: 'credits',
      currentWindow: { windowStart: '2026-09-01T00:00:00.000000Z', levelMicro: 3_000 * MICRO },
      otherLiveGrantedMicro: 500 * MICRO,
      spendableMicro: 2_000 * MICRO,
      chargedInWindowMicro: 1_500 * MICRO,
      now: NOW,
    });
    expect(view).toMatchObject({
      capCents: 3_500,
      usedThisMonthCents: 1_500,
      remainingCents: 2_000,
    });
  });
});
