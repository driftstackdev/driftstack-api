// A month anchored on the 31st ends on the last day of shorter months and
// returns to the 31st; an annual period splits into twelve monthly windows.
//
// Included credits follow natural months counted from an anchor (a paid
// period's start, a contract's anchor): month k = anchor + k months, in UTC, the
// day clamped to the length of a shorter month, the time of day kept. Computed
// from the ANCHOR every time — chaining month to month would turn Jan 31 into
// Feb 28 and then Mar 28 for ever, silently moving every later renewal.
//
// This is Postgres's `(S AT TIME ZONE 'UTC' + make_interval(months => k)) AT
// TIME ZONE 'UTC'`, and the expected values below are written out rather than
// computed so that a wrong implementation cannot agree with itself. UTC
// throughout: the last two arms run the same calendar under three
// daylight-saving zones and require identical boundaries. They are the only
// arms that can catch a local-time getter when the test process itself runs in
// UTC, as CI's does.

import { afterEach, describe, expect, it } from 'vitest';
import {
  TOP_UP_VALIDITY_MONTHS,
  addUtcMonths,
  naturalMonthContaining,
  naturalMonthsOfPeriod,
} from '../src/ai-credits.js';
import { seededRandom } from './_helpers/seeded-random.js';

const iso = (d: Date): string => d.toISOString();
const at = (s: string): Date => new Date(s);

describe('natural months from an anchor', () => {
  it('a Jan 31 anchor in a common year: Feb 28, then back to the 31st wherever the month has one', () => {
    const anchor = at('2027-01-31T10:15:30.250Z');
    const months = Array.from({ length: 13 }, (_, k) => iso(addUtcMonths(anchor, k)));
    expect(months).toEqual([
      '2027-01-31T10:15:30.250Z',
      '2027-02-28T10:15:30.250Z',
      '2027-03-31T10:15:30.250Z',
      '2027-04-30T10:15:30.250Z',
      '2027-05-31T10:15:30.250Z',
      '2027-06-30T10:15:30.250Z',
      '2027-07-31T10:15:30.250Z',
      '2027-08-31T10:15:30.250Z',
      '2027-09-30T10:15:30.250Z',
      '2027-10-31T10:15:30.250Z',
      '2027-11-30T10:15:30.250Z',
      '2027-12-31T10:15:30.250Z',
      '2028-01-31T10:15:30.250Z',
    ]);
  });

  it('a Jan 31 anchor in a leap year gives Feb 29', () => {
    expect(iso(addUtcMonths(at('2028-01-31T00:00:00Z'), 1))).toBe('2028-02-29T00:00:00.000Z');
    expect(iso(addUtcMonths(at('2028-01-30T00:00:00Z'), 1))).toBe('2028-02-29T00:00:00.000Z');
    expect(iso(addUtcMonths(at('2028-01-29T00:00:00Z'), 1))).toBe('2028-02-29T00:00:00.000Z');
    expect(iso(addUtcMonths(at('2028-01-28T00:00:00Z'), 1))).toBe('2028-02-28T00:00:00.000Z');
    // 2100 is not a leap year (divisible by 100, not by 400); 2000 was.
    expect(iso(addUtcMonths(at('2100-01-31T00:00:00Z'), 1))).toBe('2100-02-28T00:00:00.000Z');
    expect(iso(addUtcMonths(at('2000-01-31T00:00:00Z'), 1))).toBe('2000-02-29T00:00:00.000Z');
  });

  it('a Feb 29 anchor is Feb 28 in common years and Feb 29 again in the next leap year', () => {
    const anchor = at('2028-02-29T23:59:59.999Z');
    expect(iso(addUtcMonths(anchor, 1))).toBe('2028-03-29T23:59:59.999Z');
    expect(iso(addUtcMonths(anchor, 12))).toBe('2029-02-28T23:59:59.999Z');
    expect(iso(addUtcMonths(anchor, 48))).toBe('2032-02-29T23:59:59.999Z');
  });

  it('months are counted from the anchor, never chained from the previous month', () => {
    const anchor = at('2027-01-31T00:00:00Z');
    const chained = addUtcMonths(addUtcMonths(anchor, 1), 1);
    expect(iso(chained)).toBe('2027-03-28T00:00:00.000Z');
    expect(iso(addUtcMonths(anchor, 2))).toBe('2027-03-31T00:00:00.000Z');
  });

  it('crosses year boundaries both ways and refuses a fractional month', () => {
    expect(iso(addUtcMonths(at('2027-11-30T12:00:00Z'), 3))).toBe('2028-02-29T12:00:00.000Z');
    expect(iso(addUtcMonths(at('2027-03-31T12:00:00Z'), -1))).toBe('2027-02-28T12:00:00.000Z');
    expect(iso(addUtcMonths(at('2027-01-15T12:00:00Z'), -13))).toBe('2025-12-15T12:00:00.000Z');
    expect(() => addUtcMonths(at('2027-01-15T12:00:00Z'), 0.5)).toThrow(RangeError);
    expect(() => addUtcMonths(new Date(Number.NaN), 1)).toThrow(RangeError);
  });

  it('a boundary past the last instant a Date can hold is refused, never returned as an invalid date', () => {
    // 8.64e15 ms is the last instant a Date can represent (+275760-09-13). Past it,
    // the arithmetic produced `Invalid Date` without a word, and a caller comparing
    // against it gets `false` from every comparison instead of an error.
    const last = new Date(8.64e15);
    expect(() => addUtcMonths(last, 1)).toThrow(RangeError);
    expect(() => addUtcMonths(at('2027-01-15T00:00:00Z'), 5_000_000)).toThrow(RangeError);
    // The month containing the last instant ends past it: refused, not a month
    // whose start and end are both invalid (it came back as index 0 before).
    expect(() => naturalMonthContaining(new Date(8.64e15 - 10 * 86_400_000), last)).toThrow(
      /representable/,
    );
    // ...and a period ending there is refused for that reason, not as "longer than 100 years".
    expect(() => naturalMonthsOfPeriod(new Date(8.64e15 - 40 * 86_400_000), last)).toThrow(
      /representable/,
    );
    // Positive control: the last month that still fits is computed as usual.
    expect(iso(addUtcMonths(at('+275760-08-13T00:00:00Z'), 1))).toBe('+275760-09-13T00:00:00.000Z');
  });

  it('for generated anchors: the target month is anchor month + k, the day is clamped, the time of day kept', () => {
    const rnd = seededRandom(0xca1e_0001);
    const DAYS = (y: number, m: number): number => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    for (let i = 0; i < 5_000; i += 1) {
      const anchor = new Date(
        Date.UTC(
          rnd.int(1990, 2150),
          rnd.int(0, 11),
          rnd.int(1, 31),
          rnd.int(0, 23),
          rnd.int(0, 59),
          rnd.int(0, 59),
          rnd.int(0, 999),
        ),
      );
      const k = rnd.int(0, 60);
      const got = addUtcMonths(anchor, k);
      const total = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + k;
      const y = Math.floor(total / 12);
      const m = total % 12;
      expect(got.getUTCFullYear(), iso(anchor)).toBe(y);
      expect(got.getUTCMonth(), iso(anchor)).toBe(m);
      expect(got.getUTCDate(), `${iso(anchor)} + ${String(k)}`).toBe(
        Math.min(anchor.getUTCDate(), DAYS(y, m)),
      );
      expect(got.getTime() % 86_400_000, iso(anchor)).toBe(anchor.getTime() % 86_400_000);
    }
  });
});

describe('the natural month containing an instant', () => {
  const anchor = at('2027-01-31T10:00:00Z');

  it('starts are inclusive and ends exclusive', () => {
    const feb = naturalMonthContaining(anchor, at('2027-02-28T10:00:00Z'));
    expect([feb.index, iso(feb.start), iso(feb.end)]).toEqual([
      1,
      '2027-02-28T10:00:00.000Z',
      '2027-03-31T10:00:00.000Z',
    ]);
    const lastMsOfJan = naturalMonthContaining(anchor, at('2027-02-28T09:59:59.999Z'));
    expect([lastMsOfJan.index, iso(lastMsOfJan.start), iso(lastMsOfJan.end)]).toEqual([
      0,
      '2027-01-31T10:00:00.000Z',
      '2027-02-28T10:00:00.000Z',
    ]);
    expect(naturalMonthContaining(anchor, anchor).index).toBe(0);
  });

  it('an instant on the calendar 1st still belongs to the month that began on the 31st before it', () => {
    const m = naturalMonthContaining(anchor, at('2027-04-01T00:00:00Z'));
    expect([m.index, iso(m.start), iso(m.end)]).toEqual([
      2,
      '2027-03-31T10:00:00.000Z',
      '2027-04-30T10:00:00.000Z',
    ]);
  });

  it('for generated instants: the month found contains the instant, and it is month `index` of the anchor', () => {
    const rnd = seededRandom(0xca1e_0002);
    for (let i = 0; i < 3_000; i += 1) {
      const a = new Date(
        Date.UTC(
          rnd.int(2020, 2040),
          rnd.int(0, 11),
          rnd.int(1, 31),
          rnd.int(0, 23),
          rnd.int(0, 59),
        ),
      );
      const t = new Date(a.getTime() + rnd.int(0, 5 * 366) * 86_400_000 + rnd.int(0, 86_399_999));
      const m = naturalMonthContaining(a, t);
      expect(
        m.start.getTime() <= t.getTime() && t.getTime() < m.end.getTime(),
        `${iso(a)} / ${iso(t)}`,
      ).toBe(true);
      expect(iso(m.start)).toBe(iso(addUtcMonths(a, m.index)));
      expect(iso(m.end)).toBe(iso(addUtcMonths(a, m.index + 1)));
    }
  });

  it('an instant before the anchor has no natural month', () => {
    expect(() => naturalMonthContaining(anchor, at('2027-01-31T09:59:59.999Z'))).toThrow(
      RangeError,
    );
  });
});

describe('an annual period splits into twelve monthly windows', () => {
  it('a year anchored on Jan 31: twelve contiguous windows, clamped in the short months', () => {
    const start = at('2027-01-31T10:00:00Z');
    const months = naturalMonthsOfPeriod(start, addUtcMonths(start, 12));
    expect(months).toHaveLength(12);
    expect(months.map((m) => iso(m.start).slice(0, 10))).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
      '2027-05-31',
      '2027-06-30',
      '2027-07-31',
      '2027-08-31',
      '2027-09-30',
      '2027-10-31',
      '2027-11-30',
      '2027-12-31',
    ]);
    expect(iso(months[11]?.end ?? new Date(0))).toBe('2028-01-31T10:00:00.000Z');
    for (let i = 1; i < months.length; i += 1) {
      expect(months[i]?.start.getTime()).toBe(months[i - 1]?.end.getTime());
    }
  });

  it('a leap-year annual period includes Feb 29, and a Feb 29 anchor gives twelve too', () => {
    const leap = naturalMonthsOfPeriod(at('2028-01-31T00:00:00Z'), at('2029-01-31T00:00:00Z'));
    expect(leap).toHaveLength(12);
    expect(iso(leap[1]?.start ?? new Date(0))).toBe('2028-02-29T00:00:00.000Z');
    const feb29 = naturalMonthsOfPeriod(at('2028-02-29T00:00:00Z'), at('2029-02-28T00:00:00Z'));
    expect(feb29).toHaveLength(12);
  });

  it('a period that does not end on a month boundary has its last window cut at the end', () => {
    const months = naturalMonthsOfPeriod(at('2027-01-15T00:00:00Z'), at('2027-03-01T00:00:00Z'));
    expect(months.map((m) => [iso(m.start), iso(m.end)])).toEqual([
      ['2027-01-15T00:00:00.000Z', '2027-02-15T00:00:00.000Z'],
      ['2027-02-15T00:00:00.000Z', '2027-03-01T00:00:00.000Z'],
    ]);
    expect(() =>
      naturalMonthsOfPeriod(at('2027-01-15T00:00:00Z'), at('2027-01-15T00:00:00Z')),
    ).toThrow(RangeError);
  });

  it('bought credits last twelve months', () => {
    expect(TOP_UP_VALIDITY_MONTHS).toBe(12);
  });
});

describe('daylight-saving time cannot move a boundary', () => {
  const saved = process.env.TZ;
  afterEach(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });

  const CASES: Array<[string, number]> = [
    ['2027-01-31T02:00:00.000Z', 1], // late evening of Jan 30 in New York
    ['2027-03-01T12:00:00.000Z', 1], // US daylight saving starts in between
    ['2027-10-31T00:30:00.000Z', 1], // Europe's clocks go back at the end of October
    ['2027-09-30T15:45:00.000Z', 2], // Lord Howe's half-hour change
  ];

  function boundaries(): string[] {
    return CASES.map(([s, k]) => iso(addUtcMonths(at(s), k)));
  }

  it('the same boundaries under UTC, New York, London and Lord Howe', () => {
    process.env.TZ = 'UTC';
    const utc = boundaries();
    expect(utc).toEqual([
      '2027-02-28T02:00:00.000Z',
      '2027-04-01T12:00:00.000Z',
      '2027-11-30T00:30:00.000Z',
      '2027-11-30T15:45:00.000Z',
    ]);
    for (const zone of ['America/New_York', 'Europe/London', 'Australia/Lord_Howe']) {
      process.env.TZ = zone;
      // A positive control that the zone really changed for this process.
      expect(new Date('2027-07-01T12:00:00Z').getHours(), zone).not.toBe(12);
      expect(boundaries(), zone).toEqual(utc);
    }
  });

  // The four cases above cannot carry this claim alone. In each of them the
  // zone's local day either equals the UTC day or clamps to the same day of a
  // shorter target month, and none crosses a year, so a calendar that read the
  // LOCAL day or year passed every arm in this file in a UTC process — the zone
  // CI runs in. These instants sit either side of UTC midnight on month and
  // year ends, in winter and in summer time, so each zone's local year, month,
  // day and hour differ from UTC's somewhere in the set, and the arm below
  // checks that they do before it trusts an agreement.
  const STRADDLING: Array<[string, number]> = [];
  for (const year of [2027, 2028]) {
    for (const day of ['01-01', '01-31', '03-01', '06-30', '07-01', '10-31', '12-31']) {
      for (const time of ['00:15:00.000', '03:59:59.999', '12:00:00.000', '23:45:00.000']) {
        for (const k of [0, 1, 2, 11, 12, 13, 25]) STRADDLING.push([`${year}-${day}T${time}Z`, k]);
      }
    }
  }

  const localFieldsThatDiffer = (instants: readonly Date[]): string[] => {
    const differ = new Set<string>();
    for (const d of instants) {
      if (d.getFullYear() !== d.getUTCFullYear()) differ.add('year');
      if (d.getMonth() !== d.getUTCMonth()) differ.add('month');
      if (d.getDate() !== d.getUTCDate()) differ.add('day');
      if (d.getHours() !== d.getUTCHours()) differ.add('hour');
    }
    return [...differ].sort();
  };

  it('the same boundaries in every zone for instants where the local calendar reads a different year, month, day or hour', () => {
    process.env.TZ = 'UTC';
    const utc = STRADDLING.map(([s, k]) => iso(addUtcMonths(at(s), k)));
    const anchors = STRADDLING.map(([s]) => at(s));
    // Where UTC itself is exercised: a Jan 31 anchor two months on, and New Year.
    expect(iso(addUtcMonths(at('2027-01-31T00:15:00.000Z'), 2))).toBe('2027-03-31T00:15:00.000Z');
    expect(iso(addUtcMonths(at('2027-12-31T23:45:00.000Z'), 2))).toBe('2028-02-29T23:45:00.000Z');

    // London is UTC+0 over New Year, so its local year never differs there.
    const expectedDiffering: Record<string, string[]> = {
      'America/New_York': ['day', 'hour', 'month', 'year'],
      'Europe/London': ['day', 'hour', 'month'],
      'Australia/Lord_Howe': ['day', 'hour', 'month', 'year'],
    };
    for (const [zone, fields] of Object.entries(expectedDiffering)) {
      process.env.TZ = zone;
      // Positive control: in this zone the set really does read differently in
      // local time, so agreement below is a UTC calendar and not an easy input.
      expect(localFieldsThatDiffer(anchors), zone).toEqual(fields);
      const local = STRADDLING.map(([s, k]) => iso(addUtcMonths(at(s), k)));
      const disagreements = STRADDLING.map(([s, k], i) => ({
        anchor: s,
        k,
        utc: utc[i],
        local: local[i],
      }))
        .filter((row) => row.utc !== row.local)
        .slice(0, 5);
      expect(disagreements, zone).toEqual([]);
    }
  });
});
