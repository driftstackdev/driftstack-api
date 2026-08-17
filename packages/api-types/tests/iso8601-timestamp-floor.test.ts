// A timestamp this API accepts must be one Postgres can store.
//
// `Iso8601Schema` is the shared type behind every timestamp field, including the
// request filters that reach a query directly. `z.string().datetime()` refuses
// the extended ±YYYYYY form, so the accepted set is four-digit years — but it
// accepts `0000-…`, and there is no year zero.
//
// That was reachable and measured, not theorised: `GET /v1/admin/audit-log`
// parses `from` into a Date and hands it to `gte(adminAuditLog.timestamp, …)`.
// Against a real Postgres, `2026-01-01T00:00:00.000Z` returns rows and
// `0000-01-01T00:00:00.000Z` fails the query — "date/time field value out of
// range" — which surfaces as a 500 produced by a query string. The sibling
// keyset cursor carried the same defect and is fixed in lib/keyset-cursor.ts.
//
// The floor is the epoch rather than year 1 because every timestamp this API
// accepts or emits describes something the system recorded. Postgres stores
// years 1..1969 without complaint; they are refused because they cannot be
// legitimate, and refusing them turns a 500 into a 400 naming the field.
//
// Both directions are pinned. A floor that rejected everything would satisfy the
// first arm alone while breaking every client that sends a timestamp.

import { describe, expect, it } from 'vitest';
import { Iso8601Schema } from '../src/common.js';

describe('the shared ISO-8601 timestamp refuses values Postgres cannot store', () => {
  it.each([
    ['year zero — no such year exists', '0000-01-01T00:00:00.000Z'],
    ['year one — storable, but predates everything this system records', '0001-01-01T00:00:00Z'],
    ['the day before the epoch', '1969-12-31T23:59:59Z'],
  ])('CRITICAL rejects %s', (_label, value) => {
    expect(
      Iso8601Schema.safeParse(value).success,
      `${value} was accepted. Timestamp filters are handed straight to a timestamptz comparison, ` +
        'so a value Postgres will not store becomes a 500 produced by a query string rather than ' +
        'a 400 naming the field',
    ).toBe(false);
  });

  it.each([
    ['the epoch boundary itself', '1970-01-01T00:00:00Z'],
    ['an ordinary timestamp', '2026-05-02T09:15:00Z'],
    ['a non-UTC offset, which the schema explicitly allows', '2026-05-02T09:15:00+02:00'],
    ['millisecond precision', '2026-05-02T09:15:00.123Z'],
    ['the far end of the four-digit range', '9999-12-31T23:59:59.999Z'],
  ])('CRITICAL still accepts %s', (_label, value) => {
    expect(
      Iso8601Schema.safeParse(value).success,
      `${value} was refused — the floor is rejecting legitimate timestamps, which breaks every ` +
        'client that sends one',
    ).toBe(true);
  });

  it('CRITICAL the extended ±YYYYYY form stays refused', () => {
    // Refused by `.datetime()` rather than by the floor. Asserted so that a
    // future relaxation of the format cannot quietly reopen the same hole from
    // the other end: those values also fail a timestamptz comparison, with
    // "time zone displacement out of range".
    for (const value of ['-271821-04-20T00:00:00.000Z', '+275760-09-13T00:00:00.000Z']) {
      expect(Iso8601Schema.safeParse(value).success, `${value} was accepted`).toBe(false);
    }
  });
});
