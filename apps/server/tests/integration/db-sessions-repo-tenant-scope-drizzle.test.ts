// Tenant isolation for browser-session reads and control, against real Postgres.
//
// Same boundary shape as the profiles sibling, and the same reason it matters:
// `SessionsService` fetches with `repo.findSession(sessionId, accountId)` and
// throws NotFound purely on a null row. It never re-checks ownership itself, so
// the `eq(sessions.accountId, …)` predicate in the repo IS the isolation
// boundary.
//
// Measured before writing this. Neutralising that predicate:
//   - route + service tests stay GREEN (they run against InMemory repos)
//   - only the two SOURCE-TEXT pins red, and only because the text changed
//
// And nothing in the suite constructs `DrizzleSessionRepo` at all, so no test
// executed a line of the shipped session SQL. A rewritten WHERE clause could hand
// account A account B's live browser session — its proxy configuration, its
// archetype, the key material it was launched with — past a fully green suite.
//
// Three arms, chosen because they are three different FAILURE SHAPES:
//   read    `findSession`             — returns a row, or null
//   control `claimSessionOperation`   — returns a tagged result, `not_found`
//   silent  `touchSessionLastStateAt` — returns void, so only reading the row
//                                        back can prove a stranger did not move it

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionStatusSchema } from '@driftstack/api-types';
import { DrizzleSessionRepo } from '../../src/db/sessions-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seeded: string[] = [];

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
    await client`SELECT 1 FROM sessions LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    // FK order: sessions → api_keys → accounts.
    for (const accountId of seeded) {
      await client`DELETE FROM sessions WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM api_keys WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleSessionRepo tenant scoping (real Postgres)',
  () => {
    it("CRITICAL another account's session cannot be read, claimed for an operation, or touched — the repo WHERE clause is the boundary, since the service throws NotFound purely on a null row and never re-checks ownership", async () => {
      if (!dbReachable || !client) {
        // Quiet skip locally, hard failure in CI: a vacuous pass on a
        // tenant-isolation test reports the boundary as proven when nothing ran.
        if (process.env.CI) {
          throw new Error(
            'real-PG session tenant-scope test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleSessionRepo({ client, db, close: async () => {} });

      const owner = randomUUID();
      const stranger = randomUUID();
      seeded.push(owner, stranger);
      for (const [id, who] of [
        [owner, 'owner'],
        [stranger, 'stranger'],
      ] as const) {
        await client`INSERT INTO accounts (id, email) VALUES (${id}, ${`sess-${who}-${id}@test.local`})`;
      }
      const [key] = await client`
        INSERT INTO api_keys (account_id, name, key_prefix, key_hash)
        VALUES (${owner}, 'tenant-scope', ${`dk_${owner.slice(0, 8)}`}, ${`hash-${owner}`})
        RETURNING id`;
      const [row] = await client`
        INSERT INTO sessions (account_id, api_key_id, driver_session_id, status)
        VALUES (${owner}, ${key?.id as string}, ${`drv-${owner}`}, 'ready')
        RETURNING id`;
      const sessionId = row?.id as string;
      expect(sessionId).toBeTruthy();

      // Positive control first — without it the arms below could pass because
      // the fixture was never visible to anyone.
      expect((await repo.findSession(sessionId, owner))?.id).toBe(sessionId);

      // READ — the IDOR case: a session that exists, asked for by another account.
      expect(
        await repo.findSession(sessionId, stranger),
        "another account's session must not be readable by id",
      ).toBeNull();

      // CONTROL — claiming the operation lock is how a session is started,
      // stopped or driven. A stranger must not be able to take it.
      const stolen = await repo.claimSessionOperation(sessionId, stranger);
      expect(stolen.kind, 'a stranger must not claim the operation lock').toBe('not_found');

      // SILENT — returns void, so a wrong-account call cannot be caught by its
      // return value. Read the column back instead.
      const stamp = new Date('2031-01-02T03:04:05.000Z');
      await repo.touchSessionLastStateAt({
        id: sessionId,
        accountId: stranger,
        driverSessionId: `drv-${owner}`,
        lastStateAt: stamp,
      });
      const [afterStranger] = await client`
        SELECT last_state_at FROM sessions WHERE id = ${sessionId}`;
      expect(
        afterStranger?.last_state_at ?? null,
        "a stranger must not stamp another account's session",
      ).toBeNull();

      // …and the owner CAN, so the arm above is a boundary and not a broken call.
      await repo.touchSessionLastStateAt({
        id: sessionId,
        accountId: owner,
        driverSessionId: `drv-${owner}`,
        lastStateAt: stamp,
      });
      const [afterOwner] = await client`
        SELECT last_state_at FROM sessions WHERE id = ${sessionId}`;
      expect(afterOwner?.last_state_at ?? null).not.toBeNull();
    });

    it('CRITICAL countAllByStatus zero-fills from the ENUM and setEgressCapabilityReport round-trips its jsonb, both against real Postgres. Neither had executed a line of SQL. The count claim is pinned by source text only, and text cannot show that the query groups correctly or that every enum member survives the zero-fill. The report writes TWO jsonb columns, which is the exact shape where a past double-encode defect lived, so a round-trip is what proves the value comes back an object rather than a JSON string.', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleSessionRepo({ client, db, close: async () => {} });

      const owner = randomUUID();
      seeded.push(owner);
      await client`INSERT INTO accounts (id, email) VALUES (${owner}, ${`egr-${owner}@test.local`})`;
      const [key] = await client`
        INSERT INTO api_keys (account_id, name, key_prefix, key_hash)
        VALUES (${owner}, 'egress-report', ${`dk_${owner.slice(0, 8)}`}, ${`hash-egr-${owner}`})
        RETURNING id`;
      const [srow] = await client`
        INSERT INTO sessions (account_id, api_key_id, driver_session_id, status)
        VALUES (${owner}, ${key?.id as string}, ${`drv-egr-${owner}`}, 'ready')
        RETURNING id`;
      const sessionId = srow?.id as string;

      // countAllByStatus - every enum member present, not just the ones with rows.
      const counts = await repo.countAllByStatus();
      expect(
        Object.keys(counts).sort(),
        'the zero-fill must cover every SessionStatusSchema member, not only statuses that have rows',
      ).toEqual([...SessionStatusSchema.options].sort());
      expect(counts.ready, 'the seeded ready session must be counted').toBeGreaterThanOrEqual(1);

      // setEgressCapabilityReport - jsonb round-trip on BOTH columns.
      const derived = {
        udp_associate: true,
        quic_route: 'proxy' as const,
        dns_remote_resolve: false,
        warnings: ['probe-timeout'],
      };
      const raw = { probe: { attempts: 2 }, note: 'round-trip' };
      const updated = await repo.setEgressCapabilityReport({ sessionId, derived, raw });
      expect(updated, 'the report write must return the updated session').not.toBeNull();

      const [back] = await client`
        SELECT egress_capabilities, egress_capability_report FROM sessions WHERE id = ${sessionId}`;
      expect(
        typeof back?.egress_capabilities,
        'a double-encoded jsonb comes back a string, not an object',
      ).toBe('object');
      expect(back?.egress_capabilities).toEqual(derived);
      expect(back?.egress_capability_report).toEqual(raw);

      // An unknown id is a no-op returning null, not a throw.
      expect(
        await repo.setEgressCapabilityReport({ sessionId: randomUUID(), derived, raw }),
        'an unknown session id must be a null no-op',
      ).toBeNull();
    });
  },
);
