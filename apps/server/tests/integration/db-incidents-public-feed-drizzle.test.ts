// What the public status page is allowed to show, and in what order.
//
// v8 coverage: `publicFeed` is one of twelve functions in
// `db/incidents-repo.ts` with zero statements executed by the suite. It is the
// customer-facing one — during an outage it IS the status page — so it is the
// one taken first.
//
// The property that matters most is the quiet one. Every read inside the feed
// passes `scope: 'public'`, which `readListPage` turns into
// `incidents.public = true`. Drop that from any of the three reads and an
// incident marked private — the ones written while staff are still working out
// what broke, with a customer name or a vendor in the title — is published to
// anyone loading the status page. Nothing else in the feed would look wrong.
//
// Then the ordering contract the page depends on:
//
//   open first     open incidents take the slots; resolved ones fill only what
//                  is left of `limit`. Reversed, a page-sized run of resolved
//                  history pushes the LIVE outage off the feed entirely.
//   since window   resolved incidents older than `since` are excluded, so the
//                  page shows recent history and not the whole year.
//   openOutageCount counted separately over open + severity=outage, which is
//                  what a banner keys on. It must not count resolved outages
//                  or open incidents of lesser severity.
//   truncated      true exactly when fewer rows are returned than exist.
//
// Against a real Postgres: the feed runs in a `repeatable read`, `read only`
// transaction and its filters are SQL. A double would assert my re-reading of
// the where-clause rather than the statement the page runs.

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
    await sql`SELECT 1 FROM incidents LIMIT 0`;
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

/**
 * The feed reads every incident in the table, so each arm seeds its own marker
 * into the title and asserts only over its own rows. Sharing a database with
 * whatever else is present is the realistic condition anyway.
 */
async function seedIncident(args: {
  marker: string;
  isPublic: boolean;
  status: 'investigating' | 'resolved';
  severity?: 'minor' | 'major' | 'outage';
  startedAgoMs?: number;
}): Promise<string> {
  const id = randomUUID();
  const startedAt = new Date(Date.now() - (args.startedAgoMs ?? HOUR));
  await sql!`
    INSERT INTO incidents (id, title, description, severity, status, public, started_at, resolved_at)
    VALUES (${id}, ${`${args.marker} ${id}`}, 'seeded by the public-feed test',
            ${args.severity ?? 'minor'}::incident_severity,
            ${args.status}::incident_status, ${args.isPublic},
            ${startedAt.toISOString()}::timestamptz,
            ${args.status === 'resolved' ? startedAt.toISOString() : null})`;
  seeded.push(id);
  return id;
}

const titles = (feed: { rows: { title: string }[] }): string[] => feed.rows.map((r) => r.title);

describe('the public incident feed', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL a private incident never reaches the public feed', async () => {
    if (!dbReachable || !repo) return;
    const marker = `priv-${randomUUID()}`;
    await seedIncident({ marker, isPublic: false, status: 'investigating', severity: 'outage' });
    const feed = await repo.publicFeed({ since: new Date(Date.now() - 24 * HOUR), limit: 50 });
    expect(
      titles(feed).filter((t) => t.startsWith(marker)),
      'an incident marked private was published on the status page — these are written while staff ' +
        'are still working out what broke',
    ).toEqual([]);
  });

  it('CRITICAL a private OPEN OUTAGE does not raise the public outage banner', async () => {
    if (!dbReachable || !repo) return;
    const before = await repo.publicFeed({ since: new Date(Date.now() - 24 * HOUR), limit: 50 });
    await seedIncident({
      marker: `priv-outage-${randomUUID()}`,
      isPublic: false,
      status: 'investigating',
      severity: 'outage',
    });
    const after = await repo.publicFeed({ since: new Date(Date.now() - 24 * HOUR), limit: 50 });
    expect(
      after.openOutageCount,
      'a private outage moved the public outage count — the banner would announce an incident the ' +
        'page cannot show',
    ).toBe(before.openOutageCount);
  });

  it('CRITICAL an open incident is never pushed off the feed by resolved history', async () => {
    if (!dbReachable || !repo) return;
    const since = new Date(Date.now() - 24 * HOUR);
    // The slot budget is measured, not assumed to be one.
    //
    // This used to pass `limit: 1` and read as "the single available slot". That
    // is only true when this test's incident is the sole open PUBLIC one, and
    // the incidents table is shared: any other suite that leaves an open public
    // incident behind takes the slot first, and the failure then reads as
    // "displaced by resolved history" when it was displaced by another OPEN
    // incident — which is the feed behaving correctly. Observed as an
    // order-dependent red in a full run that passed this file in isolation.
    //
    // Counting the incumbents and asking for exactly one slot beyond them keeps
    // the property intact: the resolved rows below still have to lose that slot
    // to the open one. What changes is that the premise is now measured.
    const incumbentOpen = (await repo.publicFeed({ since, limit: 200 })).openCount;
    const open = `open-${randomUUID()}`;
    // Resolved rows are seeded FIRST and more recently, so any ordering that is
    // not "open first" would let them take the one remaining slot.
    for (let i = 0; i < 3; i++) {
      await seedIncident({
        marker: `resolved-${randomUUID()}`,
        isPublic: true,
        status: 'resolved',
        startedAgoMs: HOUR / 2,
      });
    }
    await seedIncident({ marker: open, isPublic: true, status: 'investigating' });
    const feed = await repo.publicFeed({ since, limit: incumbentOpen + 1 });
    expect(
      titles(feed).some((t) => t.startsWith(open)),
      'the live incident was displaced by resolved history — the page would show an all-clear ' +
        'while the outage is ongoing',
    ).toBe(true);
  });

  it('CRITICAL resolved incidents older than the since window are excluded', async () => {
    if (!dbReachable || !repo) return;
    const stale = `stale-${randomUUID()}`;
    await seedIncident({
      marker: stale,
      isPublic: true,
      status: 'resolved',
      startedAgoMs: 90 * 24 * HOUR,
    });
    const feed = await repo.publicFeed({ since: new Date(Date.now() - 24 * HOUR), limit: 50 });
    expect(
      titles(feed).filter((t) => t.startsWith(stale)),
      'a resolved incident from outside the requested window appeared in the feed',
    ).toEqual([]);
  });

  it('CRITICAL a public open outage is counted, and only while it is open', async () => {
    if (!dbReachable || !repo) return;
    const since = new Date(Date.now() - 24 * HOUR);
    const before = await repo.publicFeed({ since, limit: 50 });
    const id = await seedIncident({
      marker: `pub-outage-${randomUUID()}`,
      isPublic: true,
      status: 'investigating',
      severity: 'outage',
    });
    const during = await repo.publicFeed({ since, limit: 50 });
    expect(during.openOutageCount, 'a public open outage was not counted').toBe(
      before.openOutageCount + 1,
    );
    await sql!`UPDATE incidents SET status = 'resolved', resolved_at = now() WHERE id = ${id}`;
    const after = await repo.publicFeed({ since, limit: 50 });
    expect(
      after.openOutageCount,
      'a resolved outage still counted as open — the banner would never clear',
    ).toBe(before.openOutageCount);
  });
});
