// S13 — the pure arithmetic behind the old bundled-llm-settings/-status
// routes for a MOVED account (§8.6, L6): `movedAccountConsent`,
// `movedAccountCapWriteRefusal` and `movedAccountCreditsView` in
// services/bundled-llm.ts. No database, no HTTP, no clock but the one each
// test passes in — the route (account-bundled-llm.ts) is what turns a real
// account read into the inputs these take; that wiring is covered by the
// integration tests in tests/integration.
//
// The microcredit→cents conversion (§2: 1 credit = 1,000,000 µcr = US$0.01,
// so 1,000,000 µcr = 1 cent) is the thing most likely to drift a digit, so
// every boundary gets its own case rather than one "round trip" assertion.

import { describe, expect, it } from 'vitest';
import {
  BUNDLED_CAP_STORAGE_MAX_CENTS,
  MOVED_ACCOUNT_CAP_IMMUTABLE_DETAIL,
  movedAccountCapWriteRefusal,
  movedAccountConsent,
  movedAccountCreditsView,
} from '../../src/services/bundled-llm.js';

describe('movedAccountConsent — the old boolean, for a moved account (L6)', () => {
  it('automatic (ai_source null) reads as consented — the same fallback a legacy "yes" always meant', () => {
    expect(movedAccountConsent(null)).toBe(true);
  });

  it('explicit credits reads as consented', () => {
    expect(movedAccountConsent('credits')).toBe(true);
  });

  it('CRITICAL own_key is the only source that reads as NOT consented', () => {
    expect(movedAccountConsent('own_key')).toBe(false);
  });
});

describe('movedAccountCapWriteRefusal — only an exact re-send of the shown cap is accepted (§8.6 item 6)', () => {
  it('CRITICAL an exact re-send is accepted (null = no refusal)', () => {
    expect(
      movedAccountCapWriteRefusal({ requestedCents: 3_500, currentCapCents: 3_500 }),
    ).toBeNull();
  });

  it('CRITICAL a higher value is refused with the plan-comes-with-credits detail', () => {
    expect(movedAccountCapWriteRefusal({ requestedCents: 3_501, currentCapCents: 3_500 })).toBe(
      MOVED_ACCOUNT_CAP_IMMUTABLE_DETAIL,
    );
  });

  it('a LOWER value is refused too — unlike the legacy write bound, there is nothing to lower toward; the old cap column is never written for a moved account', () => {
    expect(movedAccountCapWriteRefusal({ requestedCents: 3_499, currentCapCents: 3_500 })).toBe(
      MOVED_ACCOUNT_CAP_IMMUTABLE_DETAIL,
    );
  });

  it("the refusal names the reason a customer reads, not an internal one: 'Monthly AI credits come with your plan and can't be changed here.'", () => {
    expect(MOVED_ACCOUNT_CAP_IMMUTABLE_DETAIL).toBe(
      "Monthly AI credits come with your plan and can't be changed here.",
    );
  });
});

describe('movedAccountCreditsView — no current window (no paid coverage yet)', () => {
  it('CRITICAL cap, used and remaining all read 0, whatever ai_source is', () => {
    const view = movedAccountCreditsView({
      aiSource: 'credits',
      currentWindow: null,
      otherLiveGrantedMicro: 999_000_000,
      spendableMicro: 999_000_000,
      chargedInWindowMicro: 999_000_000,
      now: new Date('2026-06-15T12:00:00Z'),
    });
    expect(view.capCents).toBe(0);
    expect(view.usedThisMonthCents).toBe(0);
    expect(view.remainingCents).toBe(0);
  });

  it('consent is still computed from ai_source — the missing window only zeroes the money fields', () => {
    const consented = movedAccountCreditsView({
      aiSource: null,
      currentWindow: null,
      otherLiveGrantedMicro: 0,
      spendableMicro: 0,
      chargedInWindowMicro: 0,
      now: new Date('2026-06-15T12:00:00Z'),
    });
    const notConsented = movedAccountCreditsView({
      aiSource: 'own_key',
      currentWindow: null,
      otherLiveGrantedMicro: 0,
      spendableMicro: 0,
      chargedInWindowMicro: 0,
      now: new Date('2026-06-15T12:00:00Z'),
    });
    expect(consented.consent).toBe(true);
    expect(notConsented.consent).toBe(false);
  });

  it("falls back to the calendar month, the LEGACY shape's own default when its settings row is missing", () => {
    const view = movedAccountCreditsView({
      aiSource: null,
      currentWindow: null,
      otherLiveGrantedMicro: 0,
      spendableMicro: 0,
      chargedInWindowMicro: 0,
      now: new Date('2026-06-15T12:34:56.789Z'),
    });
    expect(view.monthStartedAt.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });
});

const NOW = new Date('2026-06-15T12:00:00Z');

describe('movedAccountCreditsView — cap_cents = min(window level + other live grants, storage max)', () => {
  it('CRITICAL sums the window level and the other live grants, in whole cents (both already whole credits)', () => {
    const view = movedAccountCreditsView({
      aiSource: 'credits',
      currentWindow: { windowStart: '2026-06-01T00:00:00.000000Z', levelMicro: 300 * 1_000_000 },
      otherLiveGrantedMicro: 50 * 1_000_000,
      spendableMicro: 0,
      chargedInWindowMicro: 0,
      now: NOW,
    });
    expect(view.capCents).toBe(350);
  });

  it('zero other live grants leaves the cap at exactly the window level', () => {
    const view = movedAccountCreditsView({
      aiSource: 'credits',
      currentWindow: { windowStart: '2026-06-01T00:00:00.000000Z', levelMicro: 10_000 * 1_000_000 },
      otherLiveGrantedMicro: 0,
      spendableMicro: 0,
      chargedInWindowMicro: 0,
      now: NOW,
    });
    expect(view.capCents).toBe(10_000);
  });

  it(`CRITICAL clamps at the old column's storage max (${String(BUNDLED_CAP_STORAGE_MAX_CENTS)} cents), the same ceiling BUNDLED_CAP_STORAGE_MAX_CENTS names for the legacy route`, () => {
    const view = movedAccountCreditsView({
      aiSource: 'credits',
      currentWindow: {
        windowStart: '2026-06-01T00:00:00.000000Z',
        levelMicro: 900_000 * 1_000_000,
      },
      otherLiveGrantedMicro: 200_000 * 1_000_000,
      spendableMicro: 0,
      chargedInWindowMicro: 0,
      now: NOW,
    });
    expect(view.capCents).toBe(BUNDLED_CAP_STORAGE_MAX_CENTS);
  });
});

describe('movedAccountCreditsView — used_this_month_cents = ceil(charged in the current window)', () => {
  it('0 charged is 0 cents', () => {
    const view = movedAccountCreditsView({
      aiSource: 'credits',
      currentWindow: { windowStart: '2026-06-01T00:00:00.000000Z', levelMicro: 0 },
      otherLiveGrantedMicro: 0,
      spendableMicro: 0,
      chargedInWindowMicro: 0,
      now: NOW,
    });
    expect(view.usedThisMonthCents).toBe(0);
  });

  it('CRITICAL a single microcredit charged still shows as 1 cent — charges round UP, never under-reporting what the customer spent', () => {
    const view = movedAccountCreditsView({
      aiSource: 'credits',
      currentWindow: { windowStart: '2026-06-01T00:00:00.000000Z', levelMicro: 0 },
      otherLiveGrantedMicro: 0,
      spendableMicro: 0,
      chargedInWindowMicro: 1,
      now: NOW,
    });
    expect(view.usedThisMonthCents).toBe(1);
  });

  it('CRITICAL an exact whole-credit charge does NOT round up to the next cent (boundary: 1,000,000 µcr stays 1 cent, not 2)', () => {
    const view = movedAccountCreditsView({
      aiSource: 'credits',
      currentWindow: { windowStart: '2026-06-01T00:00:00.000000Z', levelMicro: 0 },
      otherLiveGrantedMicro: 0,
      spendableMicro: 0,
      chargedInWindowMicro: 1_000_000,
      now: NOW,
    });
    expect(view.usedThisMonthCents).toBe(1);
  });

  it('one microcredit past a whole cent rounds up to the NEXT cent', () => {
    const view = movedAccountCreditsView({
      aiSource: 'credits',
      currentWindow: { windowStart: '2026-06-01T00:00:00.000000Z', levelMicro: 0 },
      otherLiveGrantedMicro: 0,
      spendableMicro: 0,
      chargedInWindowMicro: 1_000_001,
      now: NOW,
    });
    expect(view.usedThisMonthCents).toBe(2);
  });
});

describe('movedAccountCreditsView — remaining_cents = floor(spendable)', () => {
  it('CRITICAL a whole-credit balance plus a fraction floors DOWN — never shows more than the customer has', () => {
    const view = movedAccountCreditsView({
      aiSource: 'credits',
      currentWindow: { windowStart: '2026-06-01T00:00:00.000000Z', levelMicro: 0 },
      otherLiveGrantedMicro: 0,
      spendableMicro: 1_999_999,
      chargedInWindowMicro: 0,
      now: NOW,
    });
    expect(view.remainingCents).toBe(1);
  });

  it('an exact whole-credit balance floors to that many cents exactly', () => {
    const view = movedAccountCreditsView({
      aiSource: 'credits',
      currentWindow: { windowStart: '2026-06-01T00:00:00.000000Z', levelMicro: 0 },
      otherLiveGrantedMicro: 0,
      spendableMicro: 2_000_000,
      chargedInWindowMicro: 0,
      now: NOW,
    });
    expect(view.remainingCents).toBe(2);
  });

  it('remaining is NOT window-scoped: it is spendableMicro as given, unrelated to the window level or the other-live-grants figure passed alongside it', () => {
    const view = movedAccountCreditsView({
      aiSource: 'credits',
      currentWindow: { windowStart: '2026-06-01T00:00:00.000000Z', levelMicro: 1 * 1_000_000 },
      otherLiveGrantedMicro: 1 * 1_000_000,
      spendableMicro: 500 * 1_000_000,
      chargedInWindowMicro: 0,
      now: NOW,
    });
    expect(view.remainingCents).toBe(500);
  });
});

describe("movedAccountCreditsView — month_started_at is the window's window_start", () => {
  it('an exact-millisecond window_start round-trips unchanged', () => {
    const view = movedAccountCreditsView({
      aiSource: 'credits',
      currentWindow: { windowStart: '2026-06-05T08:15:30.000000Z', levelMicro: 0 },
      otherLiveGrantedMicro: 0,
      spendableMicro: 0,
      chargedInWindowMicro: 0,
      now: NOW,
    });
    expect(view.monthStartedAt.toISOString()).toBe('2026-06-05T08:15:30.000Z');
  });

  it('CRITICAL a sub-millisecond window_start is NOT naively truncated: it delegates to firstMillisecondAtOrAfter, which rounds UP to the next whole millisecond', () => {
    const view = movedAccountCreditsView({
      aiSource: 'credits',
      currentWindow: { windowStart: '2026-06-05T08:15:30.123456Z', levelMicro: 0 },
      otherLiveGrantedMicro: 0,
      spendableMicro: 0,
      chargedInWindowMicro: 0,
      now: NOW,
    });
    // A naive `new Date(...)` parse of the same string truncates to .123 and
    // would equal this minus one millisecond — the distinguishing case.
    expect(view.monthStartedAt.toISOString()).toBe('2026-06-05T08:15:30.124Z');
  });

  it("is NOT the calendar month's start — the window need not begin on the 1st (L6: unlike the legacy default, a moved account's month follows its billing anniversary)", () => {
    const view = movedAccountCreditsView({
      aiSource: 'credits',
      currentWindow: { windowStart: '2026-06-17T00:00:00.000000Z', levelMicro: 0 },
      otherLiveGrantedMicro: 0,
      spendableMicro: 0,
      chargedInWindowMicro: 0,
      now: NOW,
    });
    expect(view.monthStartedAt.toISOString()).not.toBe('2026-06-01T00:00:00.000Z');
    expect(view.monthStartedAt.toISOString()).toBe('2026-06-17T00:00:00.000Z');
  });
});

describe('the dashboard save check (settings.astro) — a re-saved cap always round-trips as accepted', () => {
  it('CRITICAL the cap movedAccountCreditsView reports is exactly what movedAccountCapWriteRefusal accepts back — the property S13 needs: GET, then PATCH with the same number, must not refuse', () => {
    const view = movedAccountCreditsView({
      aiSource: null,
      currentWindow: { windowStart: '2026-06-01T00:00:00.000000Z', levelMicro: 3_000 * 1_000_000 },
      otherLiveGrantedMicro: 500 * 1_000_000,
      spendableMicro: 1_200 * 1_000_000,
      chargedInWindowMicro: 800 * 1_000_000,
      now: NOW,
    });
    expect(
      movedAccountCapWriteRefusal({
        requestedCents: view.capCents,
        currentCapCents: view.capCents,
      }),
    ).toBeNull();
    // And a client that (wrongly) sends `used_this_month_cents` or `remaining_cents`
    // back as the cap is refused — those are never the same number.
    expect(
      movedAccountCapWriteRefusal({
        requestedCents: view.remainingCents,
        currentCapCents: view.capCents,
      }),
    ).toBe(MOVED_ACCOUNT_CAP_IMMUTABLE_DETAIL);
  });
});
