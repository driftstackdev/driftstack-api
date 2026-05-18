// v2-#6 — pure-function tests for startOfCalendarMonthUtc, the UTC
// calendar-month boundary helper used by BundledLlmService.
// sumMonthlySpendCents to compute the "spent this calendar month"
// figure on /v1/account/me/bundled-llm-status.
//
// The function is documented as "exported so tests can pin the
// boundary" but had no direct coverage — the BundledLlmService unit
// test exercises sumMonthlySpendCents end-to-end but doesn't isolate
// the boundary helper, so a subtle off-by-one (e.g. dropping the
// hour/min/sec/ms reset, or using local-time instead of UTC) could
// drift past the integration test without tripping it.
//
// Pins:
//   - Returns a Date at YYYY-MM-01T00:00:00.000Z for any input in
//     that month (idempotent).
//   - Strips hour / minute / second / millisecond components.
//   - Honors UTC explicitly — same input + different local timezones
//     would produce the same boundary.
//   - January (month=0) + December (month=11) edge cases.
//   - Leap-year February (29 days) doesn't shift the boundary.

import { describe, expect, it } from 'vitest';
import { startOfCalendarMonthUtc } from '../../src/services/bundled-llm.js';

function iso(d: Date): string {
  return d.toISOString();
}

describe('startOfCalendarMonthUtc — UTC calendar-month boundary', () => {
  it('returns 2026-05-01T00:00:00.000Z for a mid-month timestamp', () => {
    expect(iso(startOfCalendarMonthUtc(new Date('2026-05-18T14:32:15.789Z')))).toBe(
      '2026-05-01T00:00:00.000Z',
    );
  });

  it('strips the hour / minute / second / millisecond components', () => {
    const result = startOfCalendarMonthUtc(new Date('2026-05-18T23:59:59.999Z'));
    expect(result.getUTCHours()).toBe(0);
    expect(result.getUTCMinutes()).toBe(0);
    expect(result.getUTCSeconds()).toBe(0);
    expect(result.getUTCMilliseconds()).toBe(0);
  });

  it('honors UTC — midnight Z input returns the same instant', () => {
    expect(iso(startOfCalendarMonthUtc(new Date('2026-05-01T00:00:00.000Z')))).toBe(
      '2026-05-01T00:00:00.000Z',
    );
  });

  it('is idempotent — applying twice returns the same Date', () => {
    const first = startOfCalendarMonthUtc(new Date('2026-05-18T14:32:15.789Z'));
    const second = startOfCalendarMonthUtc(first);
    expect(iso(second)).toBe(iso(first));
  });

  it('returns January boundary for an early-January timestamp (month=0 edge)', () => {
    expect(iso(startOfCalendarMonthUtc(new Date('2026-01-02T03:04:05Z')))).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('returns December boundary for a late-December timestamp (month=11 edge)', () => {
    expect(iso(startOfCalendarMonthUtc(new Date('2026-12-31T23:59:59.999Z')))).toBe(
      '2026-12-01T00:00:00.000Z',
    );
  });

  it('handles leap-year February (2024 had 29 days) correctly', () => {
    // The leap day Feb-29 still maps to Feb-01 of the same year.
    expect(iso(startOfCalendarMonthUtc(new Date('2024-02-29T12:00:00Z')))).toBe(
      '2024-02-01T00:00:00.000Z',
    );
  });

  it('handles non-leap-year February (2025: 28 days)', () => {
    expect(iso(startOfCalendarMonthUtc(new Date('2025-02-28T12:00:00Z')))).toBe(
      '2025-02-01T00:00:00.000Z',
    );
  });

  it('boundary instant 23:59:59.999 of the last day of a month maps to that month start (not next month)', () => {
    // 2026-05-31T23:59:59.999Z is the LAST millisecond of May; it
    // must still bucket into the May boundary, not roll over to June.
    expect(iso(startOfCalendarMonthUtc(new Date('2026-05-31T23:59:59.999Z')))).toBe(
      '2026-05-01T00:00:00.000Z',
    );
  });

  it('boundary instant 00:00:00.000 of the first day of a month is a fixed point', () => {
    // The very first instant of a month must equal the boundary itself.
    expect(iso(startOfCalendarMonthUtc(new Date('2026-06-01T00:00:00.000Z')))).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });
});
