// V-1235 — one contract for the probe SLA aggregate, against BOTH implementations of `ProbesRepo`.
//
// The twenty-fifth of the twenty-nine. `countByTargetSince` is what the SLA report reads: ok versus
// failed probes per target over a window, plus when each target last failed. Those numbers become
// an uptime figure on a page customers use to decide whether the platform is behaving.
//
// THREE PROPERTIES, AND THE FIRST IS INVISIBLE TO TYPESCRIPT.
//
//   Drizzle  count(*) filter (where ok = true)   -> declared `sql<string>`, then Number(...)
//   double   cur.okCount += 1                    -> a number all along
//
// The SQL count is a bigint, and postgres-js hands bigints back as STRINGS. The repo is honest about
// it — the annotation says `sql<string>` and the mapping calls `Number()` — but the honesty is a
// convention, not a guarantee: drop the conversion and the field is typed `number`, holds `"7"`, and
// the first arithmetic on it concatenates. `okCount + failCount` becomes `"70"` and the uptime
// percentage derived from it is nonsense that still renders. So the arm checks `typeof` at RUNTIME,
// which is the only place the difference exists. Same class as V-1204, seen from the consuming side.
//
// LAST-FAILURE IS NOT LAST-PROBE. Computed as `max(probed_at)` overall rather than
// `max(probed_at) filter (where ok = false)`, a target that failed and then RECOVERED reports its
// recovery moment as the last failure — the incident looks like it is still happening. Both
// implementations get this right; nothing asserted it.
//
// `recordProbe` takes `probedAt` as a parameter, so unlike the last four contracts the timestamps
// are chosen outright and every boundary arm is exact without reading a stamp back.
//
// `countByTargetSince` takes no target filter — it aggregates the whole table — so every arm scopes
// to targets it generated itself.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { ProbesRepo } from '../../src/services/health-probe.js';
import { DrizzleProbesRepo } from '../../src/db/health-probes-repo.js';
import { InMemoryProbesRepo } from './_helpers/in-memory-probes-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

const WINDOW_START = new Date('2026-08-20T12:00:00.000Z');
const BEFORE = new Date(WINDOW_START.getTime() - 1);
const MID = new Date(WINDOW_START.getTime() + 60_000);
const LATE = new Date(WINDOW_START.getTime() + 120_000);

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM system_health_probes LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const t of seeded) {
      await client`DELETE FROM system_health_probes WHERE target = ${t}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Row {
  target: string;
  okCount: number;
  failCount: number;
  lastFailureAt: Date | null;
}

interface Subject {
  repo: ProbesRepo;
  target: () => string;
}

function makeTargeter(track: boolean): () => string {
  return () => {
    const t = `contract-${randomUUID().slice(0, 12)}`;
    if (track) seeded.push(t);
    return t;
  };
}

function inMemorySubject(): Subject {
  return { repo: new InMemoryProbesRepo(), target: makeTargeter(false) };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    repo: new DrizzleProbesRepo({ client: c, db, close: async () => {} }),
    target: makeTargeter(true),
  };
}

async function probe(s: Subject, target: string, ok: boolean, probedAt: Date): Promise<void> {
  await s.repo.recordProbe({
    target,
    ok,
    latencyMs: null,
    httpStatus: null,
    errorMessage: null,
    probedAt,
  });
}

const rowFor = async (s: Subject, target: string, since: Date): Promise<Row | undefined> =>
  ((await s.repo.countByTargetSince(since)) as Row[]).find((r) => r.target === target);

function probeAggregateContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`ProbesRepo SLA aggregate contract — ${label}`, () => {
    it('CRITICAL the counts are NUMBERS at runtime, in both. The SQL count is a bigint and postgres-js returns bigints as strings, so a dropped Number() leaves a field typed `number` holding "7" — and the first arithmetic on it concatenates. `okCount + failCount` becomes "70" and the uptime percentage derived from it is nonsense that still renders. TypeScript cannot see this; only typeof can.', async () => {
      if (!enabled()) return;
      const s = make();
      const target = s.target();
      await probe(s, target, true, MID);
      await probe(s, target, false, LATE);

      const row = await rowFor(s, target, WINDOW_START);
      expect(row, 'the target produced no aggregate row').toBeDefined();
      expect(typeof row?.okCount, 'okCount is not a number at runtime').toBe('number');
      expect(typeof row?.failCount, 'failCount is not a number at runtime').toBe('number');
      expect((row?.okCount ?? 0) + (row?.failCount ?? 0), 'the counts do not add up').toBe(2);
    });

    it('CRITICAL ok and failed probes are counted separately, in both. One number is the uptime and the other is the outage; folding them together makes a perfectly-failing target look perfectly healthy.', async () => {
      if (!enabled()) return;
      const s = make();
      const target = s.target();
      await probe(s, target, true, MID);
      await probe(s, target, true, MID);
      await probe(s, target, false, LATE);

      const row = await rowFor(s, target, WINDOW_START);
      expect(row?.okCount, 'the ok count is wrong').toBe(2);
      expect(row?.failCount, 'the fail count is wrong').toBe(1);
    });

    it('CRITICAL the window start is INCLUSIVE and earlier probes are excluded, in both. The report is "since this moment", so a probe stamped exactly at the boundary belongs to the window and one a millisecond earlier does not — an off-by-one here silently shifts every published uptime figure.', async () => {
      if (!enabled()) return;
      const s = make();
      const target = s.target();
      await probe(s, target, true, BEFORE);
      await probe(s, target, true, WINDOW_START);

      const row = await rowFor(s, target, WINDOW_START);
      expect(row?.okCount, 'the window boundary is not inclusive-start, exclusive-before').toBe(1);
    });

    it('CRITICAL lastFailureAt is the newest FAILURE, not the newest probe, in both. Computed as max(probed_at) overall, a target that failed and then RECOVERED reports its recovery moment as the last failure — the incident reads as still happening after it is over.', async () => {
      if (!enabled()) return;
      const s = make();
      const target = s.target();
      await probe(s, target, false, MID);
      await probe(s, target, true, LATE);

      const row = await rowFor(s, target, WINDOW_START);
      expect(
        row?.lastFailureAt?.getTime(),
        'lastFailureAt followed the recovery instead of staying at the failure',
      ).toBe(MID.getTime());
    });

    it('CRITICAL a target with no failures reports lastFailureAt null, in both. Null is what "never failed in this window" looks like, and inventing a timestamp puts a phantom incident on a healthy target.', async () => {
      if (!enabled()) return;
      const s = make();
      const target = s.target();
      await probe(s, target, true, MID);

      const row = await rowFor(s, target, WINDOW_START);
      expect(row?.lastFailureAt ?? null, 'a healthy target reported a failure time').toBeNull();
    });

    it("CRITICAL each target aggregates independently, in both. One target failing must not raise another target's fail count — the status page shows them as separate components and an operator reads them as separate.", async () => {
      if (!enabled()) return;
      const s = make();
      const healthy = s.target();
      const broken = s.target();
      await probe(s, healthy, true, MID);
      await probe(s, broken, false, MID);
      await probe(s, broken, false, LATE);

      const row = await rowFor(s, healthy, WINDOW_START);
      expect(row?.failCount, "another target's failures were counted here").toBe(0);
      expect(row?.okCount, 'the healthy target lost its own probe').toBe(1);
    });
  });
}

probeAggregateContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'ProbesRepo SLA aggregate contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    probeAggregateContract('drizzle', drizzleSubject, () => dbReachable);
  },
);
