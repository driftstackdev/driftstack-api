// Two small tools for tests that prove what the DATABASE refuses on its own.
//
// `refusal` runs one statement and returns the error Postgres raised, failing
// the test if the statement was accepted. Its result carries the SQLSTATE and
// the constraint name, so an arm can require "refused BY THIS CHECK" rather
// than "refused somehow" — a different constraint firing first is a different
// guarantee, and reads identically from a bare `rejects.toThrow()`.
//
// `inRolledBackTransaction` runs a body in a transaction that is always rolled
// back, for arms whose rows must not outlive them.

import type postgres from 'postgres';

export interface DatabaseRefusal {
  /** SQLSTATE, e.g. 23514 check_violation, 23505 unique_violation, 55000 from a guard trigger. */
  readonly code: string;
  readonly constraint: string | null;
  readonly message: string;
}

/**
 * The error the database raised for `run`; throws if it did not refuse. `what`
 * names the case in that failure, for arms that loop over many.
 */
export async function refusal(
  run: () => Promise<unknown>,
  what = 'this statement',
): Promise<DatabaseRefusal> {
  try {
    await run();
  } catch (err) {
    const e = err as { code?: unknown; constraint_name?: unknown; message?: unknown };
    if (typeof e.code !== 'string') throw err;
    return {
      code: e.code,
      constraint: typeof e.constraint_name === 'string' ? e.constraint_name : null,
      message: String(e.message),
    };
  }
  throw new Error(`expected the database to refuse ${what}, and it was accepted`);
}

class RolledBack extends Error {}

/** Run `body` in a transaction that is rolled back whatever happens. */
export async function inRolledBackTransaction<T>(
  sql: postgres.Sql,
  body: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  let result: { value: T } | null = null;
  try {
    await sql.begin(async (tx) => {
      result = { value: await body(tx) };
      throw new RolledBack('rollback');
    });
  } catch (err) {
    if (!(err instanceof RolledBack)) throw err;
  }
  if (result === null) throw new Error('the rolled-back transaction produced no result');
  return (result as { value: T }).value;
}
