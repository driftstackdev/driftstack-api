// The natural-month calendar in api-types agrees with Postgres's own month
// arithmetic, instant for instant.
//
// Included AI credits follow natural months counted from an anchor, and the
// database draws those boundaries itself, as
//
//   (S AT TIME ZONE 'UTC' + make_interval(months => k)) AT TIME ZONE 'UTC'
//
// while the server and the clients draw them with `addUtcMonths`. If the two
// ever disagree — on the 31st, on Feb 29, across a daylight-saving change — a
// window the database granted ends on a different instant from the one a
// customer is shown, or one the server checks. So the database is asked
// directly, for thousands of anchors and offsets, under two session time zones,
// and every answer must match to the millisecond.
//
// The last arm is the positive control: the same sum WITHOUT the explicit UTC
// conversion, in a New York session, must disagree somewhere — otherwise this
// comparison could not tell a UTC calendar from a local one.

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUtcMonths } from '@driftstack/api-types';
import { ensureIsolatedDatabase } from './_helpers/isolated-database.js';

const ISOLATED_DB_NAME = 'driftstack_iso_ai_credit_calendar';

let client: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  const isolated = await ensureIsolatedDatabase(ISOLATED_DB_NAME);
  if (isolated === null) return;
  const probe = postgres(isolated, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(isolated, { max: 1 });
});

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
});

/** mulberry32, seeded so a failing case reproduces. */
function seeded(seed: number): (min: number, max: number) => number {
  let state = seed >>> 0;
  return (min, max) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return min + Math.floor(r * (max - min + 1));
  };
}

interface Case {
  anchor: string;
  months: number;
}

function cases(): Case[] {
  const int = seeded(0xca1e_5a1);
  const out: Case[] = [];
  // The shapes that break calendars: month ends, Feb 29, century years, the
  // minutes around UTC midnight, and US/EU daylight-saving weekends.
  const pinned = [
    '2027-01-31T10:15:30.250Z',
    '2028-01-31T00:00:00.000Z',
    '2028-02-29T23:59:59.999Z',
    '2100-01-31T00:00:00.000Z',
    '2000-01-31T00:00:00.000Z',
    '2027-03-14T06:59:59.999Z',
    '2027-10-31T00:30:00.000Z',
    '2027-01-31T02:00:00.000Z',
  ];
  for (const anchor of pinned) {
    for (let k = -3; k <= 50; k += 1) out.push({ anchor, months: k });
  }
  for (let i = 0; i < 3_000; i += 1) {
    const day = int(0, 3) === 0 ? int(28, 31) : int(1, 31);
    const anchor = new Date(
      Date.UTC(int(1990, 2150), int(0, 11), day, int(0, 23), int(0, 59), int(0, 59), int(0, 999)),
    );
    out.push({ anchor: anchor.toISOString(), months: int(0, 60) });
  }
  return out;
}

async function postgresMonths(
  sql: postgres.TransactionSql,
  input: Case[],
  expression: 'utc' | 'session',
): Promise<string[]> {
  const anchors = input.map((c) => c.anchor);
  const months = input.map((c) => c.months);
  const rows =
    expression === 'utc'
      ? await sql<Array<{ r: string }>>`
          SELECT to_char((((t.a AT TIME ZONE 'UTC') + make_interval(months => t.k)) AT TIME ZONE 'UTC')
                           AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS r
            FROM unnest(${anchors}::timestamptz[], ${months}::int[]) WITH ORDINALITY AS t(a, k, i)
           ORDER BY t.i`
      : await sql<Array<{ r: string }>>`
          SELECT to_char((t.a + make_interval(months => t.k)) AT TIME ZONE 'UTC',
                         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS r
            FROM unnest(${anchors}::timestamptz[], ${months}::int[]) WITH ORDINALITY AS t(a, k, i)
           ORDER BY t.i`;
  return rows.map((row) => row.r);
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'the natural-month calendar agrees with Postgres',
  () => {
    it('CRITICAL the database is reachable, so nothing below can pass vacuously', () => {
      expect(client, 'postgres unreachable — the comparisons below never ran').not.toBeNull();
    });

    it('addUtcMonths equals the database month arithmetic for every case, under a UTC and a New York session', async () => {
      if (!client) return;
      const input = cases();
      const ours = input.map((c) => addUtcMonths(new Date(c.anchor), c.months).toISOString());
      for (const zone of ['UTC', 'America/New_York']) {
        const theirs = await client.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL TIME ZONE '${zone}'`);
          return postgresMonths(tx, input, 'utc');
        });
        expect(theirs).toHaveLength(input.length);
        const disagreements = input
          .map((c, i) => ({ ...c, ours: ours[i], theirs: theirs[i] }))
          .filter((row) => row.ours !== row.theirs);
        expect(disagreements.slice(0, 10), `${zone}: calendar disagreements`).toEqual([]);
      }
    });

    it('positive control: the same sum in a New York session WITHOUT the UTC conversion disagrees somewhere', async () => {
      if (!client) return;
      const input = cases();
      const ours = input.map((c) => addUtcMonths(new Date(c.anchor), c.months).toISOString());
      const local = await client.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL TIME ZONE 'America/New_York'`);
        return postgresMonths(tx, input, 'session');
      });
      const differing = input.filter((_, i) => ours[i] !== local[i]).length;
      expect(differing, 'a local-time calendar must be told apart from a UTC one').toBeGreaterThan(
        0,
      );
    });
  },
);
