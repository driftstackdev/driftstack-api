// Drizzle-backed integration test for DrizzleIncidentUpdateNotificationsRepo.
//
// Fourth of the zero-coverage repos (item 5e). This table is the throttle marker
// behind "max 1 status-incident-updated email per subscriber per incident per
// hour", so what it gets wrong is what a subscriber receives during an incident:
// either a stream of duplicates, or nothing.
//
// The arm that matters most is the upsert advancing `last_sent_at`. It is written
// as raw SQL inside the conflict clause —
//
//     set: { lastSentAt: sql`excluded.last_sent_at` }
//
// — which is not type-checked against the schema, and whose failure is quiet in
// the worst way. If the timestamp never advanced, the throttle would keep
// measuring from the FIRST send forever: an hour into a long incident every
// subsequent update would clear the window and dispatch, so the customer gets
// spammed precisely while they are already anxious about an outage. Nothing
// throws; the marker simply stops moving.
//
// The two isolation arms are each a single `eq` clause, the same shape that made
// the email-preferences pair worth separate arms: one subscriber's send must not
// throttle another's, and one incident's must not throttle a different incident.
//
// Shared-database discipline: every arm uses subscribers and incidents this file
// seeded, and nothing counts rows globally.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleIncidentUpdateNotificationsRepo } from '../../src/db/incident-update-notifications-repo.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

const EARLIER = new Date('2026-08-16T10:00:00.000Z');
const LATER = new Date('2026-08-16T11:30:00.000Z');

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let repo: DrizzleIncidentUpdateNotificationsRepo | null = null;
const seededSubscribers: string[] = [];
const seededIncidents: string[] = [];

async function seedSubscriber(): Promise<string> {
  if (!client) throw new Error('no client');
  const id = randomUUID();
  await client`
    INSERT INTO status_subscribers (id, email, created_at)
    VALUES (${id}, ${`incnotif-${id.slice(0, 8)}@example.test`}, now())`;
  seededSubscribers.push(id);
  return id;
}

async function seedIncident(): Promise<string> {
  if (!client) throw new Error('no client');
  const id = randomUUID();
  // severity is a NOT NULL enum with no default; status, public and
  // affected_components all default, so those are left to the schema.
  await client`
    INSERT INTO incidents (id, title, description, severity, started_at, created_at, updated_at)
    VALUES (${id}, ${'Fixture incident'}, ${'fixture'}, 'minor'::incident_severity,
            now(), now(), now())`;
  seededIncidents.push(id);
  return id;
}

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 1 });
  try {
    await client`SELECT 1 FROM incident_update_notifications LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
    return;
  }
  repo = new DrizzleIncidentUpdateNotificationsRepo({
    client,
    db: drizzle(client, { schema }),
    close: async () => {},
  });
});

afterAll(async () => {
  if (client) {
    // incident_update_notifications cascades from both parents.
    for (const id of seededIncidents) {
      await client`DELETE FROM incidents WHERE id = ${id}`.catch(() => {});
    }
    for (const id of seededSubscribers) {
      await client`DELETE FROM status_subscribers WHERE id = ${id}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleIncidentUpdateNotificationsRepo (Drizzle path against real Postgres)',
  () => {
    it('CRITICAL the database is reachable and migrated. In CI the service and migrate step are part of the job, so an unreachable database must FAIL rather than let every arm below pass vacuously.', () => {
      if (!process.env.CI && !process.env.DATABASE_URL) return;
      expect(dbReachable, 'postgres reachable and the table present').toBe(true);
      expect(repo, 'repo constructed').not.toBeNull();
    });

    it('CRITICAL an unsent pair reports null, which is what permits the FIRST email. Every incident notification begins here, so a read that returned a timestamp for a pair with no row would throttle a subscriber out of the very first update about an outage.', async () => {
      if (!dbReachable || !repo) return;
      const sub = await seedSubscriber();
      const inc = await seedIncident();
      expect(await repo.findLastSentAt(sub, inc), 'nothing sent yet').toBeNull();
    });

    it('CRITICAL markSent records the timestamp the throttle then reads back. The marker and the check are separate statements, so this is the only arm proving they agree about the pair they key on.', async () => {
      if (!dbReachable || !repo) return;
      const sub = await seedSubscriber();
      const inc = await seedIncident();
      await repo.markSent(sub, inc, EARLIER);
      const got = await repo.findLastSentAt(sub, inc);
      expect(got?.getTime(), 'reads back what was written').toBe(EARLIER.getTime());
    });

    it('CRITICAL a second markSent ADVANCES the timestamp rather than keeping the first. The conflict clause takes `excluded.last_sent_at`, and if it kept the existing value the throttle would measure from the first send forever — an hour into a long incident every later update would clear the window and dispatch, spamming the subscriber exactly while they are anxious about an outage. Nothing throws when this breaks; the marker just stops moving.', async () => {
      if (!dbReachable || !repo) return;
      const sub = await seedSubscriber();
      const inc = await seedIncident();
      await repo.markSent(sub, inc, EARLIER);
      await repo.markSent(sub, inc, LATER);
      const got = await repo.findLastSentAt(sub, inc);
      expect(got?.getTime(), 'the later send wins').toBe(LATER.getTime());
    });

    it('CRITICAL a repeated markSent does not violate the unique index. The pair is UNIQUE, so an upsert that degraded to a plain insert would raise a constraint error on the second update of any incident — turning a throttle into an outage in the notifier itself.', async () => {
      if (!dbReachable || !repo) return;
      const sub = await seedSubscriber();
      const inc = await seedIncident();
      await repo.markSent(sub, inc, EARLIER);
      await expect(repo.markSent(sub, inc, LATER)).resolves.toBeUndefined();
    });

    it("CRITICAL one subscriber's send never throttles another. Everyone subscribed to the same incident is a separate row, and a missing subscriber predicate would deliver the update to whoever was emailed first and silence the rest.", async () => {
      if (!dbReachable || !repo) return;
      const mine = await seedSubscriber();
      const theirs = await seedSubscriber();
      const inc = await seedIncident();
      await repo.markSent(theirs, inc, EARLIER);

      expect(await repo.findLastSentAt(mine, inc), 'not throttled by a neighbour').toBeNull();
      expect((await repo.findLastSentAt(theirs, inc))?.getTime(), 'their own marker holds').toBe(
        EARLIER.getTime(),
      );
    });

    it('CRITICAL a send for one incident never throttles a different incident. Two incidents can be open at once, and a missing incident predicate would suppress updates about the second outage because the subscriber had already heard about the first.', async () => {
      if (!dbReachable || !repo) return;
      const sub = await seedSubscriber();
      const first = await seedIncident();
      const second = await seedIncident();
      await repo.markSent(sub, first, EARLIER);

      expect(
        await repo.findLastSentAt(sub, second),
        'the other incident is unthrottled',
      ).toBeNull();
    });
  },
);
