// Resolving and reopening an incident, and what must move together.
//
// v8 coverage: `resolve` and `reopen` in `db/incidents-repo.ts` execute zero
// statements in the suite. They are what clears and re-raises the banner the
// public feed exposes, so a half-applied transition is visible to every
// customer looking at the status page.
//
// Each transition changes TWO things about the incident and posts a third, and
// the failures are the ones where only some of them move:
//
//   resolve   status → 'resolved' AND resolvedAt → now. Status without the
//             timestamp leaves a resolved incident with no resolution time, so
//             anything reading "when did this end" gets null for an incident
//             the page says is over.
//   reopen    status → 'investigating' AND resolvedAt → NULL. Clearing the
//             status but leaving resolvedAt set is the split-brain: the
//             incident is open, and still carries the moment it ended. Two
//             readers disagree depending on which column they trust.
//   both      post a timeline update carrying the NEW status, so the audit
//             trail explains the transition rather than just recording it.
//
// And the one that only a real database shows: both run in a transaction that
// inserts the update BEFORE touching the incident. Against an id that does not
// exist the insert violates the incident_updates → incidents foreign key, the
// transaction rolls back, and nothing is left behind. Without the transaction a
// failed resolve would post "resolved" to a timeline forever.
//
// Round-trip matters too — resolve then reopen must return the row to a state
// indistinguishable from never-resolved, because that is exactly the
// false-alarm correction the reopen path was added for.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleIncidentsRepo } from '../../src/db/incidents-repo.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let sql: ReturnType<typeof postgres> | null = null;
let repo: DrizzleIncidentsRepo | null = null;
let dbReachable = false;
const seeded: string[] = [];
const adminAccounts: string[] = [];

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
    await sql`SELECT 1 FROM incident_updates LIMIT 0`;
    dbReachable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    return;
  }
  repo = new DrizzleIncidentsRepo({ db: drizzle(sql) } as unknown as never);
  await seedAdmin();
});

afterAll(async () => {
  if (sql && seeded.length > 0) {
    await sql`DELETE FROM incident_updates WHERE incident_id = ANY(${sql.array(seeded)}::uuid[])`.catch(
      () => undefined,
    );
    await sql`DELETE FROM incidents WHERE id = ANY(${sql.array(seeded)}::uuid[])`.catch(
      () => undefined,
    );
  }
  if (sql && adminAccounts.length > 0) {
    await sql`DELETE FROM accounts WHERE id = ANY(${sql.array(adminAccounts)}::uuid[])`.catch(
      () => undefined,
    );
  }
  await sql?.end({ timeout: 2 }).catch(() => undefined);
});

async function seedOpenIncident(): Promise<string> {
  const id = randomUUID();
  await sql!`
    INSERT INTO incidents (id, title, description, severity, status, public, started_at)
    VALUES (${id}, ${`resolve-reopen ${id}`}, 'seeded by the transition test',
            'major'::incident_severity, 'investigating'::incident_status, true, now())`;
  seeded.push(id);
  return id;
}

/**
 * `posted_by_admin_id` and `posted_by_admin_key_id` carry FKs to accounts and
 * api_keys, so the poster has to be a real pair of rows rather than two uuids.
 */
let ADMIN: { postedByAdminId: string; postedByAdminKeyId: string };

async function seedAdmin(): Promise<void> {
  const accountId = randomUUID();
  await sql!`
    INSERT INTO accounts (id, email, status)
    VALUES (${accountId}, ${`incident-admin-${accountId}@test.local`}, 'active')`;
  adminAccounts.push(accountId);
  const keyId = randomUUID();
  await sql!`
    INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash, scopes)
    VALUES (${keyId}, ${accountId}, 'incident-admin', ${`inc_${keyId.slice(0, 8)}`},
            ${randomUUID()}, ARRAY['read','write']::api_key_scope[])`;
  ADMIN = { postedByAdminId: accountId, postedByAdminKeyId: keyId };
}

async function readIncident(id: string): Promise<{ status: string; resolved_at: Date | null }> {
  const [row] = await sql!<{ status: string; resolved_at: Date | null }[]>`
    SELECT status, resolved_at FROM incidents WHERE id = ${id}`;
  return row!;
}

describe('incident resolve and reopen transitions', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL resolve sets the status AND the resolution time together', async () => {
    if (!dbReachable || !repo) return;
    const incidentId = await seedOpenIncident();
    const { incident } = await repo.resolve({ incidentId, message: 'fixed', ...ADMIN });
    expect(incident.status).toBe('resolved');
    const row = await readIncident(incidentId);
    expect(row.status).toBe('resolved');
    expect(
      row.resolved_at,
      'the incident reads as resolved with no resolution time — anything asking when it ended ' +
        'gets null for an incident the page says is over',
    ).not.toBeNull();
  });

  it('CRITICAL resolve posts a timeline update carrying the new status', async () => {
    if (!dbReachable || !repo) return;
    const incidentId = await seedOpenIncident();
    await repo.resolve({ incidentId, message: 'root cause was the pool', ...ADMIN });
    const updates = await sql!<{ status: string; message: string }[]>`
      SELECT status, message FROM incident_updates WHERE incident_id = ${incidentId}`;
    expect(updates.map((u) => u.status)).toEqual(['resolved']);
    expect(updates[0]?.message).toBe('root cause was the pool');
  });

  it('CRITICAL reopen clears the resolution time, not just the status', async () => {
    if (!dbReachable || !repo) return;
    const incidentId = await seedOpenIncident();
    await repo.resolve({ incidentId, message: 'fixed', ...ADMIN });
    await repo.reopen({ incidentId, message: 'came back', ...ADMIN });
    const row = await readIncident(incidentId);
    expect(row.status).toBe('investigating');
    expect(
      row.resolved_at,
      'the incident is open again and still carries the moment it ended — two readers disagree ' +
        'depending on which column they trust',
    ).toBeNull();
  });

  it('CRITICAL a resolve/reopen round trip is indistinguishable from never-resolved', async () => {
    if (!dbReachable || !repo) return;
    const incidentId = await seedOpenIncident();
    const before = await readIncident(incidentId);
    await repo.resolve({ incidentId, message: 'fixed', ...ADMIN });
    await repo.reopen({ incidentId, message: 'false alarm', ...ADMIN });
    expect(await readIncident(incidentId)).toEqual(before);
  });

  it('CRITICAL reopen posts an investigating update, so the audit trail has both sides', async () => {
    if (!dbReachable || !repo) return;
    const incidentId = await seedOpenIncident();
    await repo.resolve({ incidentId, message: 'fixed', ...ADMIN });
    await repo.reopen({ incidentId, message: 'regression', ...ADMIN });
    const updates = await sql!<{ status: string }[]>`
      SELECT status FROM incident_updates WHERE incident_id = ${incidentId} ORDER BY posted_at`;
    expect(
      updates.map((u) => u.status),
      'the timeline does not record both sides of the transition',
    ).toEqual(['resolved', 'investigating']);
  });

  it('CRITICAL resolving an incident that does not exist leaves no orphan update', async () => {
    if (!dbReachable || !repo) return;
    const ghost = randomUUID();
    await expect(repo.resolve({ incidentId: ghost, message: 'fixed', ...ADMIN })).rejects.toThrow();
    const orphans = await sql!`SELECT 1 FROM incident_updates WHERE incident_id = ${ghost}`;
    expect(
      orphans.length,
      'a failed resolve left a "resolved" update posted against an incident that does not exist — ' +
        'the transaction did not roll back',
    ).toBe(0);
  });
});
