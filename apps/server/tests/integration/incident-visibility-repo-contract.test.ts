// V-1230 — one contract for incident visibility and the create-with-update invariant, against BOTH
// implementations of `IncidentsRepo`.
//
// The twentieth of the twenty-nine. Two properties, and they fail in opposite directions.
//
// VISIBILITY IS A DISCLOSURE BOUNDARY. `incidents.public` decides whether an incident appears on the
// public status page at all. An internal incident carries operational detail written for staff —
// which customer tripped it, which node, what the operator suspects — and `get(id, { publicOnly })`
// is what stops that reaching an unauthenticated reader who happens to know or guess an id. The
// status page is the one surface with no authentication in front of it, so this predicate is the
// entire control.
//
// THE CREATE INVARIANT FAILS THE OTHER WAY. `createWithInitialUpdate` writes the incident AND its
// first update together, so an incident never exists with zero updates. The Drizzle repo treats the
// absence of that update as unreachable and throws — "existing incident is missing its atomic
// initial update" — which is the right posture for a state nothing should produce, and also means
// nothing ever checks that the write actually produces it. A double that created the incident and
// forgot the update would satisfy every test that only reads the incident, and the status page
// would render an incident with no story attached.
//
// So the arms are: an internal incident is invisible through the public path and visible through the
// unrestricted one — both halves, because "returns null" is equally satisfied by an implementation
// that finds nothing at all — and a freshly created incident has exactly one update.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { IncidentsRepo } from '../../src/services/incidents.js';
import { DrizzleIncidentsRepo, INCIDENT_PAGE_DEFAULT } from '../../src/db/incidents-repo.js';
import { InMemoryIncidentsRepo } from './_helpers/in-memory-incidents-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const STARTED = new Date('2026-08-20T12:00:00.000Z');

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seeded: string[] = [];
// V-1274 — `reopen` is admin-only and types its poster ids as non-null (only V-295b auto-resolve
// is nullable), and both columns carry an FK. So the Drizzle half needs a real account and key;
// the double needs nothing and hands back bare uuids.
const seededAccounts: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM incidents LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const id of seeded) {
      await client`DELETE FROM incident_updates WHERE incident_id = ${id}::uuid`.catch(() => {});
      await client`DELETE FROM incidents WHERE id = ${id}::uuid`.catch(() => {});
    }
    // After the updates that reference them, or the FK refuses the delete.
    for (const a of seededAccounts) {
      await client`DELETE FROM api_keys WHERE account_id = ${a}::uuid`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${a}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Subject {
  repo: IncidentsRepo;
  track: (id: string) => void;
  admin: () => Promise<{ id: string; keyId: string }>;
}

function inMemorySubject(): Subject {
  return {
    repo: new InMemoryIncidentsRepo(),
    track: () => {},
    admin: () => Promise.resolve({ id: randomUUID(), keyId: randomUUID() }),
  };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    repo: new DrizzleIncidentsRepo({ client: c, db, close: async () => {} }),
    track: (id) => seeded.push(id),
    admin: async () => {
      const id = randomUUID();
      const keyId = randomUUID();
      seededAccounts.push(id);
      const tag = id.slice(0, 8);
      await c`INSERT INTO accounts (id, email)
              VALUES (${id}, ${`incident-${id}@test.local`})`;
      await c`INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash, scopes)
              VALUES (${keyId}::uuid, ${id}::uuid, ${`k-${tag}`},
                      ${`ds_in_${tag}`}, ${`hash-${tag}`}, ${['driftstack_internal_admin']})`;
      return { id, keyId };
    },
  };
}

async function openIncident(s: Subject, isPublic: boolean) {
  // createWithInitialUpdate returns { outcome, incident, update } — NOT the incident row. The
  // first draft used `row.id` and got undefined, so listUpdates(undefined) returned nothing and
  // read as "the double never wrote the initial update". A fixture bug wearing a finding's clothes.
  const result = await s.repo.createWithInitialUpdate({
    title: `contract-${randomUUID().slice(0, 8)}`,
    description: 'initial description',
    severity: 'major',
    affectedComponents: ['api'],
    public: isPublic,
    startedAt: STARTED,
    createdByAdminId: null,
    createdByAdminKeyId: null,
  });
  s.track(result.incident.id);
  return result.incident;
}

function incidentContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`IncidentsRepo visibility contract — ${label}`, () => {
    it('CRITICAL an omitted limit falls back to the repo INCIDENT_PAGE_DEFAULT, in both. The default decides what an unparameterised incident listing returns, and both sides used to carry their own copy of the number — so moving it in production would have served a different page while every test on the double kept asserting the old one. The arm imports the constant rather than naming 100, so it follows the default instead of becoming a third copy.', async () => {
      if (!enabled()) return;
      const s = make();
      // One past the default, so the fallback is observable rather than a no-op.
      for (let i = 0; i < INCIDENT_PAGE_DEFAULT + 1; i += 1) await openIncident(s, true);

      const page = await s.repo.list({ scope: 'all' });
      expect(page.length, 'the default page size does not match the repo default').toBe(
        INCIDENT_PAGE_DEFAULT,
      );
    });

    it('CRITICAL an incident row already handed to a caller does NOT change when someone resolves it, in both. Postgres returns a point-in-time copy, so the row a caller is holding keeps saying what it said; the double bound the stored object and mutated it in place, so the same read silently became "resolved" underneath the holder. The damage is not a crash, it is that every before/after comparison written against this double compares one object with itself and passes forever whatever resolve() does.', async () => {
      if (!enabled()) return;
      const s = make();
      const held = await openIncident(s, true);
      const statusWhenCreated = held.status;
      expect(
        statusWhenCreated,
        'a new incident is already resolved — the arm proves nothing',
      ).not.toBe('resolved');

      await s.repo.resolve({
        incidentId: held.id,
        message: 'root cause addressed',
        postedByAdminId: null,
        postedByAdminKeyId: null,
      });

      expect(held.status, 'the caller\u2019s incident changed status underneath it').toBe(
        statusWhenCreated,
      );
      expect(
        held.resolvedAt,
        'the caller\u2019s incident gained a resolvedAt underneath it',
      ).toBeNull();

      // ...and the repo really did resolve it, so the arm above is about aliasing rather than
      // about resolve() quietly doing nothing.
      const reread = await s.repo.get(held.id);
      expect(reread?.status, 'resolve() did not actually resolve the incident').toBe('resolved');
    });

    it('CRITICAL the row RESOLVE hands back does not change when the incident is reopened, in both. Three methods returned the live incident and the arm above only reaches the one that creates it, so proving that one leaves the other two asserted by nothing — which is how a repaired file kept the same defect in the methods nobody wrote an arm for.', async () => {
      if (!enabled()) return;
      const s = make();
      const opened = await openIncident(s, true);

      const { incident: resolved } = await s.repo.resolve({
        incidentId: opened.id,
        message: 'root cause addressed',
        postedByAdminId: null,
        postedByAdminKeyId: null,
      });
      expect(resolved.status, 'resolve() did not return a resolved incident').toBe('resolved');

      const admin = await s.admin();
      await s.repo.reopen({
        incidentId: opened.id,
        message: 'it came back',
        postedByAdminId: admin.id,
        postedByAdminKeyId: admin.keyId,
      });

      expect(
        resolved.status,
        'the row resolve() returned changed status underneath the caller',
      ).toBe('resolved');
      expect(
        resolved.resolvedAt,
        'the row resolve() returned lost its resolvedAt underneath the caller',
      ).not.toBeNull();
    });

    it('CRITICAL an INTERNAL incident is invisible through the public path, in both. The status page is the one surface with no authentication in front of it, and an internal incident carries operator detail — which customer, which node, what is suspected — so this predicate is the entire control between that text and anyone who guesses an id.', async () => {
      if (!enabled()) return;
      const s = make();
      const internal = await openIncident(s, false);

      expect(
        await s.repo.get(internal.id, { publicOnly: true }),
        'an internal incident resolved through the public path',
      ).toBeNull();
    });

    it('CRITICAL the SAME internal incident is visible through the unrestricted path, in both. Without this half, "returns null" is equally satisfied by an implementation that finds nothing at all, and the arm above would pass on a repo that had simply lost the row.', async () => {
      if (!enabled()) return;
      const s = make();
      const internal = await openIncident(s, false);

      expect(
        (await s.repo.get(internal.id))?.id,
        'the internal incident is not readable by staff either — it was not stored',
      ).toBe(internal.id);
    });

    it('CRITICAL a PUBLIC incident resolves through the public path, in both. The mirror of the first arm: an implementation hiding everything satisfies the disclosure check while taking the status page down.', async () => {
      if (!enabled()) return;
      const s = make();
      const shown = await openIncident(s, true);

      expect(
        (await s.repo.get(shown.id, { publicOnly: true }))?.id,
        'a public incident was hidden from the public path',
      ).toBe(shown.id);
    });

    it('CRITICAL creating an incident writes its FIRST update atomically, in both. The Drizzle repo treats a missing initial update as unreachable and throws, which is the right posture and also means nothing checks that the write produces one. A double that created the incident and forgot the update satisfies every test that only reads the incident, and the status page renders an incident with no story attached.', async () => {
      if (!enabled()) return;
      const s = make();
      const incident = await openIncident(s, true);

      const updates = await s.repo.listUpdates(incident.id);
      expect(updates.length, 'the incident was created without its initial update').toBe(1);
      expect(
        updates[0]?.message,
        'the initial update does not carry the incident description',
      ).toBe('initial description');
    });

    it('CRITICAL listUpdates is scoped to one incident, in both. Two incidents open at once is the normal case during a real outage, and updates crossing between them would tell customers the wrong story about the wrong thing.', async () => {
      if (!enabled()) return;
      const s = make();
      const first = await openIncident(s, true);
      const second = await openIncident(s, true);

      const updates = await s.repo.listUpdates(first.id);
      expect(
        updates.every((u) => u.incidentId === first.id),
        "another incident's updates leaked into this one",
      ).toBe(true);
      expect(updates.length, 'the scoped list lost its own update').toBe(1);
      expect(second.id, 'the two incidents collided').not.toBe(first.id);
    });
  });
}

incidentContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'IncidentsRepo visibility contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    incidentContract('drizzle', drizzleSubject, () => dbReachable);
  },
);
