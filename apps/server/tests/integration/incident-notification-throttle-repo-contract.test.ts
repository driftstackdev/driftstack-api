// V-1232 — one contract for the incident-notification throttle key, against BOTH implementations of
// `IncidentUpdateNotificationsRepo`.
//
// The twenty-second of the twenty-nine. This is the record of "have we already mailed THIS
// subscriber about THIS incident?", read before every incident notification goes out. The whole
// surface is two methods and one composite key, and everything that can go wrong is that key being
// too narrow or too wide.
//
//   Drizzle  INSERT … ON CONFLICT (subscriber_id, incident_id) DO UPDATE
//                SET last_sent_at = excluded.last_sent_at
//            SELECT last_sent_at WHERE subscriber_id = $1 AND incident_id = $2
//
//   double   Map keyed on `${subscriberId}::${incidentId}`, set() and get()
//
// TOO WIDE (keyed on the subscriber alone) and the first incident a subscriber hears about silences
// every later one — during a real outage, that is the customer who is told the API is degraded and
// never told it is fixed. TOO NARROW (keyed on the incident alone) and one subscriber's send
// suppresses everyone else's, so the first person on the list is the only person notified.
//
// Both failures are silent: the throttle reports "already sent" and the mail simply does not go.
// So the arms hold the key from both sides — same subscriber different incident, different
// subscriber same incident — rather than only asserting that a repeat is suppressed.
//
// A NOTE ON THE UPSERT. `markSent` is not a claim: it returns void, and calling it twice is
// expected on a re-notify. The Drizzle side takes the ON CONFLICT path and the double overwrites a
// Map entry; both must advance `last_sent_at` rather than keep the first value, because the
// throttle window is measured FROM it and a stuck timestamp turns a throttle into a permanent mute.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { IncidentUpdateNotificationsRepo } from '../../src/db/incident-update-notifications-repo.js';
import { DrizzleIncidentUpdateNotificationsRepo } from '../../src/db/incident-update-notifications-repo.js';
import { InMemoryIncidentUpdateNotificationsRepo } from './_helpers/in-memory-incident-update-notifications-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const FIRST_AT = new Date('2026-08-20T12:00:00.000Z');
const LATER_AT = new Date('2026-08-20T13:00:00.000Z');

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seededSubscribers: string[] = [];
const seededIncidents: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM incident_update_notifications LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const s of seededSubscribers) {
      await client`DELETE FROM incident_update_notifications WHERE subscriber_id = ${s}::uuid`.catch(
        () => {},
      );
      await client`DELETE FROM status_subscribers WHERE id = ${s}::uuid`.catch(() => {});
    }
    for (const i of seededIncidents) {
      await client`DELETE FROM incident_updates WHERE incident_id = ${i}::uuid`.catch(() => {});
      await client`DELETE FROM incidents WHERE id = ${i}::uuid`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Subject {
  repo: IncidentUpdateNotificationsRepo;
  subscriber: () => Promise<string>;
  incident: () => Promise<string>;
}

function inMemorySubject(): Subject {
  return {
    repo: new InMemoryIncidentUpdateNotificationsRepo(),
    subscriber: () => Promise.resolve(randomUUID()),
    incident: () => Promise.resolve(randomUUID()),
  };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    repo: new DrizzleIncidentUpdateNotificationsRepo({ client: c, db, close: async () => {} }),
    subscriber: async () => {
      const id = randomUUID();
      seededSubscribers.push(id);
      await c`INSERT INTO status_subscribers (id, email, confirmed_at)
              VALUES (${id}::uuid, ${`notif-${id}@test.local`}, now())`;
      return id;
    },
    incident: async () => {
      const id = randomUUID();
      seededIncidents.push(id);
      await c`INSERT INTO incidents
                (id, title, description, severity, status, affected_components, public, started_at)
              VALUES (${id}::uuid, ${`notif-${id.slice(0, 8)}`}, 'd', 'major', 'investigating',
                      '{}', true, now())`;
      return id;
    },
  };
}

function throttleContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`IncidentUpdateNotificationsRepo throttle contract — ${label}`, () => {
    it('CRITICAL an unseen (subscriber, incident) pair reports null, in both. Null is what permits the FIRST notification, so an implementation inventing a timestamp would silence every incident before anyone heard about it.', async () => {
      if (!enabled()) return;
      const s = make();
      const sub = await s.subscriber();
      const inc = await s.incident();

      expect(
        await s.repo.findLastSentAt(sub, inc),
        'an unseen pair reported a previous send',
      ).toBeNull();
    });

    it('CRITICAL the SAME subscriber for a DIFFERENT incident is not throttled, in both. Keyed on the subscriber alone, the first incident someone hears about silences every later one — during a real outage that is the customer told the API is degraded and never told it is fixed.', async () => {
      if (!enabled()) return;
      const s = make();
      const sub = await s.subscriber();
      const first = await s.incident();
      const second = await s.incident();
      await s.repo.markSent(sub, first, FIRST_AT);

      expect(
        await s.repo.findLastSentAt(sub, second),
        'a send for one incident throttled a different incident',
      ).toBeNull();
    });

    it("CRITICAL a DIFFERENT subscriber for the SAME incident is not throttled, in both. Keyed on the incident alone, one subscriber's send suppresses everyone else's and the first person on the list is the only person notified.", async () => {
      if (!enabled()) return;
      const s = make();
      const first = await s.subscriber();
      const second = await s.subscriber();
      const inc = await s.incident();
      await s.repo.markSent(first, inc, FIRST_AT);

      expect(
        await s.repo.findLastSentAt(second, inc),
        "one subscriber's send throttled another subscriber",
      ).toBeNull();
    });

    it('CRITICAL a recorded send is readable back for that exact pair, in both. Without this the three arms above are satisfied by an implementation that records nothing at all and reports null forever.', async () => {
      if (!enabled()) return;
      const s = make();
      const sub = await s.subscriber();
      const inc = await s.incident();
      await s.repo.markSent(sub, inc, FIRST_AT);

      expect(
        (await s.repo.findLastSentAt(sub, inc))?.getTime(),
        'the recorded send was not readable back',
      ).toBe(FIRST_AT.getTime());
    });

    it('CRITICAL re-sending ADVANCES last_sent_at rather than keeping the first value, in both. The throttle window is measured from this timestamp, so an implementation that kept the original turns a throttle into a permanent mute for that pair.', async () => {
      if (!enabled()) return;
      const s = make();
      const sub = await s.subscriber();
      const inc = await s.incident();
      await s.repo.markSent(sub, inc, FIRST_AT);

      await s.repo.markSent(sub, inc, LATER_AT);

      expect(
        (await s.repo.findLastSentAt(sub, inc))?.getTime(),
        'the second send did not advance last_sent_at',
      ).toBe(LATER_AT.getTime());
    });
  });
}

throttleContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'IncidentUpdateNotificationsRepo throttle contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    throttleContract('drizzle', drizzleSubject, () => dbReachable);
  },
);
