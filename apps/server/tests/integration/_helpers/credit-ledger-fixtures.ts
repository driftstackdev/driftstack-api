// Fixtures for the AI credits ledger tests (migration 0128).
//
// Each ledger test file gets its own database, REBUILT from the migrations on
// every run: ledger rows cannot be deleted (the database refuses), so a kept
// database accumulates every earlier run's rows, and a kept database also keeps
// whatever text of the migration it first applied — an edited trigger would
// never reach it, and its tests would go on proving the old one.
//
// Rows are written with raw SQL here on purpose. The tests prove what the
// DATABASE guarantees on its own, so the fixtures must not route through the
// repository whose checks would stop a bad row before Postgres saw it.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { assertIsolatedDatabase } from './isolated-database.js';
import { ensureFreshIsolatedDatabase } from './fresh-isolated-database.js';
import { refusal, type DatabaseRefusal } from './database-refusal.js';

export const MICRO = 1_000_000;

type Sql = postgres.Sql | postgres.TransactionSql;

/**
 * Rebuild `name` from the migrations and connect to it. Null when Postgres is
 * unreachable; the caller's reachability arm turns that into a failure.
 */
export async function openLedgerDatabase(
  name: string,
  max = 4,
): Promise<{ sql: postgres.Sql; url: string } | null> {
  const url = await ensureFreshIsolatedDatabase(name);
  if (url === null) return null;
  const candidate = postgres(url, { max, onnotice: () => undefined });
  try {
    await candidate`SELECT 1`;
  } catch {
    await candidate.end({ timeout: 1 }).catch(() => {});
    return null;
  }
  await assertIsolatedDatabase(candidate, name);
  return { sql: candidate, url };
}

/** A new account row; every ledger table references one. */
export async function newAccount(sql: Sql): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO accounts (id, email) VALUES (${id}::uuid, ${`ledger-${id}@example.test`})`;
  return id;
}

/** The account's credit row, as the database creates it. */
export async function newCreditAccount(sql: Sql): Promise<string> {
  const id = await newAccount(sql);
  await sql`INSERT INTO credit_accounts (account_id) VALUES (${id}::uuid)`;
  return id;
}

export interface RawLot {
  readonly kind?: 'adjustment' | 'top_up';
  readonly credits?: number;
  /** SQL for starts_at; default one hour ago. */
  readonly starts?: string;
  /** SQL for expires_at; default thirty days on. */
  readonly expires?: string;
}

/**
 * A window-less lot (goodwill by default), EMPTY as the database creates it.
 * Included (monthly) lots need a month window, whose table does not exist yet.
 */
export async function insertLot(sql: Sql, accountId: string, lot: RawLot = {}): Promise<string> {
  const kind = lot.kind ?? 'adjustment';
  const rank = kind === 'adjustment' ? 1 : 2;
  const granted = (lot.credits ?? 100) * MICRO;
  const [row] = await sql.unsafe<Array<{ id: string }>>(
    `INSERT INTO credit_lots (account_id, kind, spend_rank, grant_key, granted_micro, starts_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, ${lot.starts ?? "now() - interval '1 hour'"}, ${lot.expires ?? "now() + interval '30 days'"})
     RETURNING id`,
    [accountId, kind, rank, `test:${randomUUID()}`, granted],
  );
  if (row === undefined) throw new Error('lot insert returned nothing');
  return row.id;
}

/** Fund a lot with a grant row for all it was granted. */
export async function grantAll(sql: Sql, accountId: string, lotId: string): Promise<void> {
  await sql`
    INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
    SELECT ${accountId}::uuid, 'grant', id, granted_micro, ${`grant:${lotId}`}
      FROM credit_lots WHERE id = ${lotId}::uuid`;
}

/** A funded lot: inserted empty, then granted in full. */
export async function fundedLot(sql: Sql, accountId: string, lot: RawLot = {}): Promise<string> {
  const id = await insertLot(sql, accountId, lot);
  await grantAll(sql, accountId, id);
  return id;
}

export async function remainingOf(sql: Sql, lotId: string): Promise<number> {
  const [row] = await sql<Array<{ n: string }>>`
    SELECT remaining_micro::text AS n FROM credit_lots WHERE id = ${lotId}::uuid`;
  if (row === undefined) throw new Error(`lot ${lotId} not found`);
  return Number(row.n);
}

export async function debtOf(sql: Sql, accountId: string): Promise<number> {
  const [row] = await sql<Array<{ n: string }>>`
    SELECT debt_micro::text AS n FROM credit_accounts WHERE account_id = ${accountId}::uuid`;
  if (row === undefined) throw new Error(`credit account ${accountId} not found`);
  return Number(row.n);
}

export async function ledgerCount(sql: Sql, accountId: string): Promise<number> {
  const [row] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM credit_ledger WHERE account_id = ${accountId}::uuid`;
  return row?.n ?? -1;
}

/**
 * `refusal`, for a call that goes through drizzle: drizzle wraps the Postgres
 * error in one that quotes the query, with the SQLSTATE on its `cause`.
 */
export function repoRefusal(run: () => Promise<unknown>, what?: string): Promise<DatabaseRefusal> {
  return refusal(async () => {
    try {
      await run();
    } catch (err) {
      const cause = (err as { cause?: { code?: unknown } }).cause;
      throw cause !== undefined && typeof cause.code === 'string' ? cause : err;
    }
  }, what);
}

/**
 * Wait until backend `pid` is blocked on a lock — the proof that a second
 * writer really is waiting on the first, rather than having raced past it.
 */
export async function waitUntilBlocked(watcher: postgres.Sql, pid: number): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const [row] = await watcher<Array<{ wait: string | null }>>`
      SELECT wait_event_type AS wait FROM pg_stat_activity WHERE pid = ${pid}`;
    if (row?.wait === 'Lock') return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`backend ${String(pid)} never blocked on a lock`);
}

/** A promise with its resolver, to hold a transaction open until a test says so. */
export function gate(): { readonly opened: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}
