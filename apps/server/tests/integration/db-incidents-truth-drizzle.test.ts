// Real-PostgreSQL proof for the incident truth contracts that an in-memory
// repository cannot establish: lifecycle filtering before LIMIT, composite
// keyset pagination, same-id concurrency, and incident+initial-update atomicity.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleIncidentsRepo } from '../../src/db/incidents-repo.js';
import * as schema from '../../src/db/schema.js';
import type { CreateIncidentInput } from '../../src/services/incidents.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const TEST_SCHEMA = `incidents_truth_${randomUUID().replaceAll('-', '')}`;
const READER_APP = `incident_truth_reader_${randomUUID().slice(0, 8)}`;

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
let repo: DrizzleIncidentsRepo | null = null;

function input(overrides: Partial<CreateIncidentInput> = {}): CreateIncidentInput {
  return {
    title: 'Incident truth probe',
    description: 'Atomic initial timeline entry.',
    severity: 'minor',
    status: 'investigating',
    affectedComponents: ['api'],
    public: true,
    startedAt: new Date('2026-07-17T12:00:00.000Z'),
    createdByAdminId: null,
    createdByAdminKeyId: null,
    ...overrides,
  };
}

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  admin = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  await admin`SELECT 1`;
  await admin.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  await admin.unsafe(
    `CREATE TABLE "${TEST_SCHEMA}".incidents (LIKE public.incidents INCLUDING ALL)`,
  );
  await admin.unsafe(
    `CREATE TABLE "${TEST_SCHEMA}".incident_updates (LIKE public.incident_updates INCLUDING ALL)`,
  );
  client = postgres(DB_URL, {
    max: 8,
    connection: { application_name: READER_APP, options: `-c search_path=${TEST_SCHEMA}` },
  });
  const db = drizzle(client, { schema });
  repo = new DrizzleIncidentsRepo({ client, db, close: async () => {} });
  const [current] = await client<Array<{ value: string }>>`SELECT current_schema() AS value`;
  expect(current?.value).toBe(TEST_SCHEMA);
});

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (admin) {
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
    await admin.end({ timeout: 5 });
  }
});

describe.skipIf(!RUN_DB_TESTS)('Drizzle incident list/create truth (real PostgreSQL)', () => {
  it('applies open state before LIMIT, so 100 newer resolved rows cannot hide one old open row', async () => {
    if (!repo) return;
    const repository = repo;
    const resolvedWrites = Array.from({ length: 100 }, (_, index) =>
      repository.createWithInitialUpdate(
        input({
          title: `resolved-${index.toString().padStart(3, '0')}`,
          status: 'resolved',
          startedAt: new Date(Date.UTC(2026, 6, 17, 12, index)),
        }),
      ),
    );
    await Promise.all(resolvedWrites);
    const resolvedPage = await repository.listPage({
      scope: 'public',
      state: 'resolved',
      limit: 1,
    });
    expect(resolvedPage.rows[0]?.resolvedAt).toBeInstanceOf(Date);
    expect(resolvedPage.openCount).toBe(0);
    await repository.createWithInitialUpdate(
      input({ title: 'old-open', startedAt: new Date('2025-01-01T00:00:00.000Z') }),
    );

    const page = await repository.listPage({ scope: 'public', state: 'open', limit: 1 });
    expect(page.total).toBe(1);
    expect(page.openCount).toBe(1);
    expect(page.rows.map((row) => row.title)).toEqual(['old-open']);
    expect(page.nextCursor).toBeNull();
  });

  it('composite (started_at,id) cursor has no gaps or duplicates for timestamp ties', async () => {
    if (!repo) return;
    const repository = repo;
    const startedAt = new Date('2026-07-18T00:00:00.000Z');
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await Promise.all(
      ids.map((id, index) =>
        repository.createWithInitialUpdate(
          input({ title: `cursor-${index.toString()}`, severity: 'outage', startedAt }),
          id,
        ),
      ),
    );

    const first = await repository.listPage({
      scope: 'all',
      state: 'open',
      severity: 'outage',
      limit: 2,
    });
    expect(first.total).toBe(3);
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await repository.listPage({
      scope: 'all',
      state: 'open',
      severity: 'outage',
      cursor: first.nextCursor ?? undefined,
      limit: 2,
    });
    expect(second.total).toBe(3);
    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.rows, ...second.rows].map((row) => row.id))).toEqual(new Set(ids));
  });

  it('keeps page rows, total, and all-time openCount on one repeatable-read snapshot', async () => {
    if (!repo || !admin) return;
    const repository = repo;
    const lockKey = Math.floor(Math.random() * 1_000_000_000) + 1;
    const blocker = postgres(DB_URL, {
      max: 1,
      connection: { application_name: `incident_truth_blocker_${lockKey.toString()}` },
    });
    const readerRole = `incident_truth_reader_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const readerPassword = randomUUID().replaceAll('-', '');
    const readerUrl = new URL(DB_URL);
    readerUrl.username = readerRole;
    readerUrl.password = readerPassword;
    const readerClient = postgres(readerUrl.toString(), {
      max: 1,
      connection: {
        application_name: READER_APP,
        options: `-c search_path=${TEST_SCHEMA}`,
      },
    });
    const readerRepo = new DrizzleIncidentsRepo({
      client: readerClient,
      db: drizzle(readerClient, { schema }),
      close: async () => {},
    });
    const targetId = randomUUID();
    await repository.createWithInitialUpdate(
      input({ title: 'snapshot-barrier', startedAt: new Date('2030-01-01T00:00:00.000Z') }),
      targetId,
    );
    const expectedOpenCount = (
      await repository.listPage({ scope: 'public', state: 'open', limit: 1 })
    ).openCount;
    try {
      await admin.unsafe(`
        CREATE ROLE "${readerRole}" LOGIN PASSWORD '${readerPassword}';
        GRANT USAGE ON SCHEMA "${TEST_SCHEMA}" TO "${readerRole}";
        GRANT SELECT ON "${TEST_SCHEMA}".incidents TO "${readerRole}";
        ALTER TABLE "${TEST_SCHEMA}".incidents ENABLE ROW LEVEL SECURITY;
        ALTER TABLE "${TEST_SCHEMA}".incidents FORCE ROW LEVEL SECURITY;
        CREATE FUNCTION "${TEST_SCHEMA}".hold_incident_truth_reader() RETURNS boolean
        LANGUAGE plpgsql VOLATILE AS $$
        BEGIN
          IF current_setting('application_name', true) = '${READER_APP}' THEN
            PERFORM pg_advisory_lock(${lockKey.toString()});
            PERFORM pg_advisory_unlock(${lockKey.toString()});
          END IF;
          RETURN true;
        END;
        $$;
        CREATE POLICY incident_truth_select ON "${TEST_SCHEMA}".incidents
          FOR SELECT USING ("${TEST_SCHEMA}".hold_incident_truth_reader());
      `);
      await blocker`SELECT pg_advisory_lock(${lockKey})`;
      const pending = readerRepo.listPage({
        scope: 'public',
        state: 'open',
        since: new Date('2029-01-01T00:00:00.000Z'),
        limit: 10,
      });
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [row] = await admin<Array<{ waiting: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE application_name = ${READER_APP}
              AND wait_event = 'advisory'
          ) AS waiting
        `;
        if (row?.waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await admin.unsafe(`
        UPDATE "${TEST_SCHEMA}".incidents
        SET status = 'resolved', resolved_at = now(), updated_at = now()
        WHERE id = '${targetId}'
      `);
      await blocker`SELECT pg_advisory_unlock(${lockKey})`;
      const heldPage = await pending;
      expect(heldPage.rows.map((row) => row.id)).toContain(targetId);
      expect(heldPage.total).toBe(1);
      expect(heldPage.openCount).toBe(expectedOpenCount);

      const freshPage = await readerRepo.listPage({
        scope: 'public',
        state: 'open',
        since: new Date('2029-01-01T00:00:00.000Z'),
        limit: 10,
      });
      expect(freshPage.rows).toEqual([]);
      expect(freshPage.total).toBe(0);
      expect(freshPage.openCount).toBe(expectedOpenCount - 1);
    } finally {
      await blocker`SELECT pg_advisory_unlock_all()`;
      await readerClient.end({ timeout: 5 });
      await admin.unsafe(`
        ALTER TABLE "${TEST_SCHEMA}".incidents NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE "${TEST_SCHEMA}".incidents DISABLE ROW LEVEL SECURITY;
        DROP OWNED BY "${readerRole}";
        DROP ROLE IF EXISTS "${readerRole}";
      `);
      await blocker.end({ timeout: 5 });
    }
  });

  it('five concurrent identical same-id creates produce one row/update and authoritative replays', async () => {
    if (!repo || !client) return;
    const id = randomUUID();
    const createInput = input({ title: 'five-way same-id create' });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => repo!.createWithInitialUpdate(createInput, id)),
    );
    expect(results.filter((result) => result.outcome === 'created')).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'replayed')).toHaveLength(4);
    expect(new Set(results.map((result) => result.update.id)).size).toBe(1);
    const [counts] = await client<Array<{ incidents: number; updates: number }>>`
      SELECT
        (SELECT count(*)::int FROM incidents WHERE id = ${id}) AS incidents,
        (SELECT count(*)::int FROM incident_updates WHERE incident_id = ${id}) AS updates
    `;
    expect(counts).toEqual({ incidents: 1, updates: 1 });

    const mismatch = await repo.createWithInitialUpdate(
      { ...createInput, description: 'different body' },
      id,
    );
    expect(mismatch.outcome).toBe('mismatch');
    expect(mismatch.incident.description).toBe(createInput.description);
  });

  it('rolls back the incident if its initial timeline insert fails', async () => {
    if (!repo || !client) return;
    await client.unsafe(`
      CREATE FUNCTION reject_incident_truth_update() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.message = 'rollback-probe' THEN
          RAISE EXCEPTION 'synthetic initial update failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_incident_truth_update
      BEFORE INSERT ON incident_updates
      FOR EACH ROW EXECUTE FUNCTION reject_incident_truth_update();
    `);
    const id = randomUUID();
    await expect(
      repo.createWithInitialUpdate(
        input({ title: 'must roll back', description: 'rollback-probe' }),
        id,
      ),
    ).rejects.toThrow();
    const [counts] = await client<Array<{ incidents: number; updates: number }>>`
      SELECT
        (SELECT count(*)::int FROM incidents WHERE id = ${id}) AS incidents,
        (SELECT count(*)::int FROM incident_updates WHERE incident_id = ${id}) AS updates
    `;
    expect(counts).toEqual({ incidents: 0, updates: 0 });
  });
});
