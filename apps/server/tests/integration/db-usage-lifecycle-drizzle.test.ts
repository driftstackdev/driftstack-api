// Lifecycle-derived session-minute aggregation against isolated real PostgreSQL.
//
// UsageRepo intentionally ignores legacy usage_records.session_minute rows and
// derives elapsed minutes from durable browser ownership instead. The tests use
// a fixed injected clock so active rows are deterministic, and an isolated
// schema so parallel connected tests cannot contribute sibling lifecycle rows.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleUsageRepo } from '../../src/db/usage-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const TEST_SCHEMA = `usage_lifecycle_${randomUUID().replaceAll('-', '')}`;

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  admin = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  await admin`SELECT 1`;
  await admin.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  await admin.unsafe(`CREATE TABLE "${TEST_SCHEMA}".sessions (LIKE public.sessions INCLUDING ALL)`);
  await admin.unsafe(
    `CREATE TABLE "${TEST_SCHEMA}".agent_sessions (LIKE public.agent_sessions INCLUDING ALL)`,
  );
  await admin.unsafe(
    `CREATE TABLE "${TEST_SCHEMA}".usage_records (LIKE public.usage_records INCLUDING ALL)`,
  );
  client = postgres(DB_URL, {
    max: 3,
    connection: { options: `-c search_path=${TEST_SCHEMA}` },
  });
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

function usageRepo(asOf: Date): DrizzleUsageRepo {
  if (!client) throw new Error('real PostgreSQL setup failed');
  const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return new DrizzleUsageRepo({ client, db, close: async () => {} }, () => asOf);
}

async function insertDirect(args: {
  accountId: string;
  driverSessionId: string;
  status: 'creating' | 'ready' | 'busy' | 'destroyed' | 'errored';
  createdAt: string;
  updatedAt?: string;
  destroyedAt?: string | null;
}): Promise<string> {
  if (!client) throw new Error('real PostgreSQL setup failed');
  const [row] = await client<Array<{ id: string }>>`
    INSERT INTO sessions (
      account_id,
      api_key_id,
      driver_session_id,
      status,
      created_at,
      updated_at,
      destroyed_at
    ) VALUES (
      ${args.accountId}::uuid,
      ${randomUUID()}::uuid,
      ${args.driverSessionId},
      ${args.status}::public.session_status,
      ${args.createdAt}::timestamptz,
      ${args.updatedAt ?? args.createdAt}::timestamptz,
      ${args.destroyedAt ?? null}::timestamptz
    )
    RETURNING id::text AS id
  `;
  if (!row) throw new Error('direct-session insert returned no row');
  return row.id;
}

async function insertAgent(args: {
  accountId: string;
  id?: string;
  status: 'active' | 'paused' | 'closed';
  createdAt: string;
  updatedAt?: string;
  closedAt?: string | null;
  nodeId?: string | null;
  driftstackSessionId?: string | null;
}): Promise<void> {
  if (!client) throw new Error('real PostgreSQL setup failed');
  await client`
    INSERT INTO agent_sessions (
      id,
      account_id,
      driftstack_session_id,
      status,
      token_budget_total,
      token_budget_remaining,
      created_at,
      updated_at,
      closed_at,
      node_id
    ) VALUES (
      ${args.id ?? `agt_${randomUUID()}`},
      ${args.accountId}::uuid,
      ${args.driftstackSessionId ?? null}::uuid,
      ${args.status},
      100,
      100,
      ${args.createdAt}::timestamptz,
      ${args.updatedAt ?? args.createdAt}::timestamptz,
      ${args.closedAt ?? null}::timestamptz,
      ${args.nodeId ?? null}
    )
  `;
}

async function insertUsage(args: {
  accountId: string;
  recordType:
    | 'session_minute'
    | 'navigate'
    | 'interact'
    | 'agent_decomposer'
    | 'agent_decomposer_bundled';
  quantity: number;
  recordedAt: string;
}): Promise<void> {
  if (!client) throw new Error('real PostgreSQL setup failed');
  await client`
    INSERT INTO usage_records (account_id, record_type, quantity, recorded_at)
    VALUES (
      ${args.accountId}::uuid,
      ${args.recordType}::public.usage_record_type,
      ${args.quantity},
      ${args.recordedAt}::timestamptz
    )
  `;
}

describe.skipIf(!RUN_DB_TESTS)(
  'DrizzleUsageRepo lifecycle minutes (isolated real PostgreSQL)',
  () => {
    it('derives period minutes from real direct + assigned standalone lifecycles and floors only after summing seconds', async () => {
      const accountId = randomUUID();
      const asOf = new Date('2026-07-03T12:00:00.000Z');

      // Two independently sub-minute direct rows contribute one minute only
      // after their clipped seconds have been summed.
      await insertDirect({
        accountId,
        driverSessionId: `drv_${randomUUID()}`,
        status: 'destroyed',
        createdAt: '2026-06-30T23:59:30.000Z',
        updatedAt: '2026-07-01T00:00:30.000Z',
        destroyedAt: '2026-07-01T00:00:30.000Z',
      });
      await insertDirect({
        accountId,
        driverSessionId: `drv_${randomUUID()}`,
        status: 'errored',
        createdAt: '2026-07-01T00:00:30.000Z',
        updatedAt: '2026-07-01T00:01:00.000Z',
        destroyedAt: null,
      });

      // Active direct and standalone agent rows stop at the injected clock.
      const linkedDirectId = await insertDirect({
        accountId,
        driverSessionId: `drv_${randomUUID()}`,
        status: 'ready',
        createdAt: '2026-07-03T11:30:00.000Z',
      });
      await insertAgent({
        accountId,
        status: 'active',
        createdAt: '2026-07-03T11:00:00.000Z',
        nodeId: 'node_usage',
      });

      // A closed legacy row without closed_at uses updated_at as its terminal
      // fallback (59 seconds, still summed before the final floor).
      await insertAgent({
        accountId,
        status: 'closed',
        createdAt: '2026-07-02T00:00:00.000Z',
        updatedAt: '2026-07-02T00:00:59.000Z',
        closedAt: null,
        nodeId: 'node_usage',
      });

      // Reservation placeholders, unassigned rows and agent rows linked to a
      // direct session are not independent browser lifecycles.
      await insertDirect({
        accountId,
        driverSessionId: `reserving:${randomUUID()}`,
        status: 'creating',
        createdAt: '2026-07-01T00:00:00.000Z',
      });
      await insertAgent({
        accountId,
        status: 'active',
        createdAt: '2026-07-01T00:00:00.000Z',
        nodeId: null,
      });
      await insertAgent({
        accountId,
        status: 'active',
        createdAt: '2026-07-01T00:00:00.000Z',
        nodeId: 'node_usage',
        driftstackSessionId: linkedDirectId,
      });

      await insertUsage({
        accountId,
        recordType: 'navigate',
        quantity: 4,
        recordedAt: '2026-07-02T12:00:00.000Z',
      });
      await insertUsage({
        accountId,
        recordType: 'session_minute',
        quantity: 9_999,
        recordedAt: '2026-07-02T12:00:00.000Z',
      });
      await insertUsage({
        accountId,
        recordType: 'agent_decomposer',
        quantity: 111,
        recordedAt: '2026-07-02T12:00:00.000Z',
      });
      await insertUsage({
        accountId,
        recordType: 'agent_decomposer_bundled',
        quantity: 222,
        recordedAt: '2026-07-02T12:00:00.000Z',
      });

      const result = await usageRepo(asOf).totalsForPeriod(
        accountId,
        new Date('2026-07-01T00:00:00.000Z'),
        new Date('2026-07-04T00:00:00.000Z'),
      );

      // 30s + 30s + 30m + 60m + 59s = 91 full minutes.
      expect(result.totals).toEqual({ navigate: 4, session_minute: 91 });
    });

    it('splits lifecycle overlap into complete UTC days and keeps both window edges half-open', async () => {
      const accountId = randomUUID();
      const asOf = new Date('2026-07-10T12:00:00.000Z');

      // Jul 1 receives 30s from each direct row. Jul 2 receives 30s from
      // the cross-midnight direct row plus 30s from the standalone agent.
      await insertDirect({
        accountId,
        driverSessionId: `drv_${randomUUID()}`,
        status: 'destroyed',
        createdAt: '2026-06-30T23:59:30.000Z',
        updatedAt: '2026-07-01T00:00:30.000Z',
        destroyedAt: '2026-07-01T00:00:30.000Z',
      });
      await insertDirect({
        accountId,
        driverSessionId: `drv_${randomUUID()}`,
        status: 'destroyed',
        createdAt: '2026-07-01T23:59:30.000Z',
        updatedAt: '2026-07-02T00:00:30.000Z',
        destroyedAt: '2026-07-02T00:00:30.000Z',
      });
      await insertAgent({
        accountId,
        status: 'closed',
        createdAt: '2026-07-02T23:59:30.000Z',
        updatedAt: '2026-07-03T00:00:30.000Z',
        closedAt: '2026-07-03T00:00:30.000Z',
        nodeId: 'node_daily',
      });

      await insertUsage({
        accountId,
        recordType: 'navigate',
        quantity: 2,
        recordedAt: '2026-07-01T12:00:00.000Z',
      });
      await insertUsage({
        accountId,
        recordType: 'interact',
        quantity: 3,
        recordedAt: '2026-07-02T12:00:00.000Z',
      });
      await insertUsage({
        accountId,
        recordType: 'session_minute',
        quantity: 9_999,
        recordedAt: '2026-07-01T12:00:00.000Z',
      });
      await insertUsage({
        accountId,
        recordType: 'navigate',
        quantity: 99,
        recordedAt: '2026-07-03T00:00:00.000Z',
      });

      const result = await usageRepo(asOf).dailyBucketsForRange(
        accountId,
        new Date('2026-07-01T00:00:00.000Z'),
        new Date('2026-07-03T00:00:00.000Z'),
      );

      expect(result).toEqual([
        { date: '2026-07-01', totals: { navigate: 2, session_minute: 1 } },
        { date: '2026-07-02', totals: { interact: 3, session_minute: 1 } },
      ]);
    });
  },
);
