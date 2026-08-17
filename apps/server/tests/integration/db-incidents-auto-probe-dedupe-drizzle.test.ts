// Whether a failing probe opens a NEW incident or joins the open one.
//
// v8 coverage: `findOpenAutoIncident` executes zero statements in the suite.
// `health-probe.ts` gates auto-creation on `!open`, so this one lookup decides
// between two opposite failures, both of them loud:
//
//   returns something it should not   →  `open` is truthy, NO incident is
//                                        created, and the status page stays
//                                        silent through a real outage.
//   returns null when one is open     →  a fresh incident every probe cycle.
//                                        A sustained outage becomes a wall of
//                                        duplicates on the public feed.
//
// The three ways to wrongly return something are the arms below: a RESOLVED
// incident for the same target (the next outage after a fixed one would never
// be announced), an open incident belonging to a DIFFERENT target (one probe's
// outage suppresses another's), and a MANUAL incident with no probe target at
// all (an operator writing an unrelated incident would mute auto-detection
// entirely).
//
// `ORDER BY started_at DESC LIMIT 1` is asserted too: with more than one open
// incident for a target, joining the oldest would attach new updates to a stale
// row while the recent one sits untouched.
//
// Against a real Postgres: the whole function is a where-clause plus an order,
// and a double would assert my re-reading of it rather than the query.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleIncidentsRepo } from '../../src/db/incidents-repo.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const HOUR = 60 * 60 * 1000;

let sql: ReturnType<typeof postgres> | null = null;
let repo: DrizzleIncidentsRepo | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  sql = postgres(DB_URL, { max: 2 });
  try {
    await sql`SELECT auto_probe_target FROM incidents LIMIT 0`;
    dbReachable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    return;
  }
  repo = new DrizzleIncidentsRepo({ db: drizzle(sql) } as unknown as never);
});

afterAll(async () => {
  if (sql && seeded.length > 0) {
    await sql`DELETE FROM incidents WHERE id = ANY(${sql.array(seeded)}::uuid[])`.catch(
      () => undefined,
    );
  }
  await sql?.end({ timeout: 2 }).catch(() => undefined);
});

async function seedIncident(args: {
  autoProbeTarget: string | null;
  status: 'investigating' | 'resolved';
  startedAgoMs?: number;
}): Promise<string> {
  const id = randomUUID();
  const startedAt = new Date(Date.now() - (args.startedAgoMs ?? HOUR));
  await sql!`
    INSERT INTO incidents
      (id, title, description, severity, status, public, started_at, resolved_at, auto_probe_target)
    VALUES (${id}, ${`auto-dedupe ${id}`}, 'seeded by the auto-probe dedupe test',
            'major'::incident_severity, ${args.status}::incident_status, true,
            ${startedAt.toISOString()}::timestamptz,
            ${args.status === 'resolved' ? startedAt.toISOString() : null},
            ${args.autoProbeTarget})`;
  seeded.push(id);
  return id;
}

/** A target id unique to each arm, so arms cannot see each other's rows. */
const freshTarget = (): string => `probe-target-${randomUUID()}`;

describe('auto-probe incident dedupe', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL an open incident for the target is found, so no duplicate is opened', async () => {
    if (!dbReachable || !repo) return;
    const target = freshTarget();
    const id = await seedIncident({ autoProbeTarget: target, status: 'investigating' });
    const found = await repo.findOpenAutoIncident(target);
    expect(
      found?.id,
      'the open incident for this target was not found — the probe would open a fresh incident ' +
        'on every cycle for as long as the outage lasts',
    ).toBe(id);
  });

  it('CRITICAL a RESOLVED incident for the target is not found, so the next outage is announced', async () => {
    if (!dbReachable || !repo) return;
    const target = freshTarget();
    await seedIncident({ autoProbeTarget: target, status: 'resolved' });
    expect(
      await repo.findOpenAutoIncident(target),
      'a resolved incident was treated as still open. The probe gates creation on this being ' +
        'null, so the next outage on this target would never be announced',
    ).toBeNull();
  });

  it('CRITICAL another target’s open incident is not found', async () => {
    if (!dbReachable || !repo) return;
    const mine = freshTarget();
    const theirs = freshTarget();
    await seedIncident({ autoProbeTarget: theirs, status: 'investigating' });
    expect(
      await repo.findOpenAutoIncident(mine),
      'one probe target’s outage suppressed incident creation for a different target',
    ).toBeNull();
  });

  it('CRITICAL a manual incident with no probe target is not found', async () => {
    if (!dbReachable || !repo) return;
    const target = freshTarget();
    await seedIncident({ autoProbeTarget: null, status: 'investigating' });
    expect(
      await repo.findOpenAutoIncident(target),
      'a hand-written incident with no probe target was matched — an operator opening an ' +
        'unrelated incident would mute auto-detection',
    ).toBeNull();
  });

  it('CRITICAL the most recent open incident wins when several exist', async () => {
    if (!dbReachable || !repo) return;
    const target = freshTarget();
    await seedIncident({
      autoProbeTarget: target,
      status: 'investigating',
      startedAgoMs: 6 * HOUR,
    });
    const newest = await seedIncident({
      autoProbeTarget: target,
      status: 'investigating',
      startedAgoMs: HOUR,
    });
    expect(
      (await repo.findOpenAutoIncident(target))?.id,
      'the older open incident was returned — new updates would attach to a stale row while the ' +
        'recent one sits untouched',
    ).toBe(newest);
  });
});
