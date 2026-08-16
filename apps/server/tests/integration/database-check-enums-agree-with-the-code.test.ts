// The value sets Postgres will accept are the value sets the code validates.
//
// Ten CHECK constraints in the database are enumerations — `status = ANY
// (ARRAY['active', 'paused', 'closed'])` and the like. They are the last word on
// what can be stored, and they are enforced by the database rather than by any
// code path a test can reach through a repo fixture. When one disagrees with the
// validator in front of it, the failure is a Postgres constraint violation on
// INSERT: a 500 rather than a 400, on a request that passed validation, for a
// value the API documents as accepted.
//
// `agent_sessions_model_check` is the clearest example of why this is worth a
// guard. It pins the four model names, and `AgentModelSchema` in `api-types`
// pins the same four. Adding a fifth model is a one-line change to that zod
// enum, everything type-checks, every unit test passes because they run against
// in-memory repos — and every session created with the new model fails at the
// database. Nothing in the repository compared those two lists.
//
// The pairing is DERIVED, not hand-kept. Every exported zod enum in `api-types`
// is read at runtime through `.options`, every enumerated CHECK is parsed out of
// `pg_get_constraintdef`, and a pair that currently agrees exactly is required
// to keep agreeing. That is what makes this self-maintaining: a hand-written
// mapping of constraint name to constant is a third copy, and it goes stale
// while every test stays green.
//
// The near-miss arm is the one that catches the drift. Two sets that agree
// exactly are a pair; two that overlap heavily but not exactly are the SAME pair
// after someone edited one side. Adding a model to the zod enum moves
// `AgentModelSchema` from exact to 4-of-5, which is reported by name with the
// values that differ. MEASURED: zero near-misses today, across 10 constraints
// and 35 exported enums.
//
// What this cannot see: eight of the ten enumerations have no exported constant
// anywhere in `api-types` — their values live in the database and again as
// inline `z.enum([...])` or `'a' | 'b'` unions inside route and repo files.
// Those are listed below by name rather than silently skipped, because a
// comparison that walks only the pairs it happens to find reports everything
// verified while covering two of ten. Giving them shared constants is the real
// fix and is a larger change than this file.

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as apiTypes from '@driftstack/api-types';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

/**
 * Enumerated CHECK constraints with no exported constant to compare against.
 *
 * MEASURED at 8 of 10. Named individually so that a new enumerated constraint
 * fails the completeness arm below rather than joining a count nobody reads.
 */
const NO_EXPORTED_CONSTANT = new Set([
  'agent_sessions_status_check',
  'agent_sessions_mode_check',
  'agent_turn_receipts_state',
  'atlas_priority_events_status_check',
  'atlas_priority_events_api_check',
  'session_operations_kind',
  'session_operations_status',
  'session_operations_terminal_shape',
]);

interface DbEnum {
  table: string;
  name: string;
  values: string[];
}

/**
 * True for the transient catalog error a concurrent DDL causes.
 *
 * `pg_get_constraintdef(oid)` resolves the constraint's relation at CALL time,
 * while the surrounding scan of `pg_constraint` was planned earlier. If another
 * connection drops or recreates that relation in between — which the rest of
 * this suite does constantly, since files run in parallel and several apply
 * migrations on boot — Postgres raises `could not open relation with OID …`.
 *
 * This is a property of reading a live catalog, not of the constraints being
 * wrong, and it took down the whole FILE: the read is in `beforeAll`, so the
 * suite failed and all four tests reported as skipped.
 *
 * Deliberately NARROW. Any other error propagates on the first attempt, so a
 * genuine failure is never retried into silence.
 */
export function isTransientCatalogError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /could not open relation with OID/i.test(message);
}

/** Read the enumerated CHECK constraints, retrying only the catalog race. */
async function readEnumeratedChecks(
  sql: ReturnType<typeof postgres>,
  attempts = 3,
): Promise<{ tbl: string; name: string; def: string }[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await sql<{ tbl: string; name: string; def: string }[]>`
        SELECT t.relname AS tbl, c.conname AS name, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.contype = 'c' AND n.nspname = 'public'
          AND pg_get_constraintdef(c.oid) LIKE '%= ANY (ARRAY%'`;
    } catch (err) {
      if (!isTransientCatalogError(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let dbEnums: DbEnum[] = [];

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
  const rows = await readEnumeratedChecks(client);
  dbEnums = rows.map((r) => ({
    table: r.tbl,
    name: r.name,
    // `'active'::text, 'paused'::text` — the cast is how Postgres renders a
    // text enumeration, and it is what distinguishes these from a numeric or
    // boolean CHECK that happens to use ANY.
    values: [...new Set([...r.def.matchAll(/'([^']*)'::text/g)].map((m) => m[1]!))].sort(),
  }));
});

afterAll(async () => {
  if (client) await client.end({ timeout: 1 }).catch(() => {});
});

/** Every exported zod enum in `api-types`, by its runtime `.options`. */
function exportedEnums(): { name: string; values: string[] }[] {
  const out: { name: string; values: string[] }[] = [];
  for (const [name, value] of Object.entries(apiTypes)) {
    const options = (value as { options?: unknown } | null)?.options;
    if (!Array.isArray(options)) continue;
    if (!options.every((o) => typeof o === 'string')) continue;
    out.push({ name, values: [...new Set(options)].sort() });
  }
  return out;
}

function guardUnreachable(): boolean {
  if (!dbReachable) {
    console.warn(`[check-enums] Postgres unreachable at ${DB_URL}; comparison skipped.`);
    return true;
  }
  return false;
}

const overlap = (a: string[], b: string[]): number =>
  a.filter((x) => b.includes(x)).length / new Set([...a, ...b]).size;

describe('the database CHECK enumerations agree with the code', () => {
  it('CRITICAL the catalog-race retry is NARROW — it must not swallow a real failure', () => {
    // The retry above exists for one transient condition and must not become a
    // general "try again" that hides a genuine error. Asserted in both
    // directions: the race message retries, and everything else — including a
    // constraint violation or a connection failure — propagates on the first
    // attempt.
    expect(
      isTransientCatalogError(new Error('could not open relation with OID 4878539')),
      'the concurrent-DDL catalog race is retryable',
    ).toBe(true);
    for (const other of [
      new Error('duplicate key value violates unique constraint'),
      new Error('permission denied for table accounts'),
      new Error('connection refused'),
      new Error('relation "pg_constraint" does not exist'),
      'a bare string',
    ]) {
      expect(
        isTransientCatalogError(other),
        `${String(other)} must NOT be retried — a retried real failure is a silent pass`,
      ).toBe(false);
    }
  });

  it('CRITICAL both sides were read and are non-trivial. Every comparison below reports disagreement, and an empty list of constraints disagrees with nothing — a parse that recovered no values would report all ten enumerations verified having read none of them.', () => {
    if (guardUnreachable()) return;

    // MEASURED: 10 enumerated constraints, 35 exported zod enums.
    expect(
      dbEnums.length,
      'enumerated CHECK constraints read from the database',
    ).toBeGreaterThanOrEqual(10);
    expect(exportedEnums().length, 'exported zod enums read from api-types').toBeGreaterThanOrEqual(
      30,
    );
    expect(
      dbEnums.filter((e) => e.values.length === 0).map((e) => e.name),
      'constraint(s) that matched the enumerated shape but yielded no values:',
    ).toEqual([]);

    // The value extraction, on a constraint whose answer is not in doubt. A
    // reader that returned every quoted token — including the `::text` casts —
    // would still produce a non-empty set and compare equal to nothing.
    const model = dbEnums.find((e) => e.name === 'agent_sessions_model_check');
    expect(model?.values, 'the model enumeration, parsed').toEqual([
      'claude-haiku-4-5',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
    ]);
  });

  it('CRITICAL every enumerated constraint is either compared to an exported constant or named as having none. A comparison that walks only the pairs it happens to find covers two of ten and reports itself clean, so a new enumeration has to arrive loudly rather than joining the eight this file cannot check.', () => {
    if (guardUnreachable()) return;

    const enums = exportedEnums();
    const unaccounted = dbEnums
      .filter((d) => !enums.some((c) => c.values.join('|') === d.values.join('|')))
      .filter((d) => !NO_EXPORTED_CONSTANT.has(d.name))
      .map((d) => `${d.table}.${d.name} [${d.values.join(', ')}]`);
    expect(
      unaccounted.sort(),
      'enumerated constraint(s) with neither a matching constant nor an entry in NO_EXPORTED_CONSTANT:',
    ).toEqual([]);

    // The other direction: an entry here that has since GAINED a constant is
    // stale, and leaving it would suppress a comparison that could now run.
    const nowPaired = dbEnums
      .filter((d) => NO_EXPORTED_CONSTANT.has(d.name))
      .filter((d) => enums.some((c) => c.values.join('|') === d.values.join('|')))
      .map((d) => d.name);
    expect(
      nowPaired.sort(),
      'constraint(s) listed as having no exported constant that now match one — remove them from NO_EXPORTED_CONSTANT:',
    ).toEqual([]);
  });

  it('CRITICAL no exported enum ALMOST matches a constraint. An exact match is a pair; a near match is that same pair after one side was edited. Adding a model to AgentModelSchema without the migration lands here by name, which is the whole point — it is a 500 from Postgres on a request that passed validation.', () => {
    if (guardUnreachable()) return;

    // MEASURED: zero near-misses across 10 constraints and 35 enums. A new
    // entry is either a real drift or two unrelated sets that have grown
    // similar; the message carries both sets so the difference is readable
    // without re-running anything.
    const near: string[] = [];
    for (const d of dbEnums) {
      for (const c of exportedEnums()) {
        const j = overlap(c.values, d.values);
        if (j < 0.5 || j === 1) continue;
        const onlyCode = c.values.filter((v) => !d.values.includes(v));
        const onlyDb = d.values.filter((v) => !c.values.includes(v));
        near.push(
          `${c.name} vs ${d.table}.${d.name}: only in code [${onlyCode.join(', ')}], only in database [${onlyDb.join(', ')}]`,
        );
      }
    }
    expect(near.sort(), 'exported enum(s) that nearly match a database constraint:').toEqual([]);
  });

  it('CRITICAL the pairs that agree today keep agreeing. AgentModelSchema and the model CHECK are the same four names in two places, and CryptoOrderStatusSchema and the order-status CHECK are the same six; both are enforced at different layers and neither reads the other.', () => {
    if (guardUnreachable()) return;

    const enums = exportedEnums();
    const pairs: string[] = [];
    const broken: string[] = [];
    for (const d of dbEnums) {
      const match = enums.find((c) => c.values.join('|') === d.values.join('|'));
      if (match === undefined) continue;
      pairs.push(`${match.name}=${d.name}`);
      if (match.values.join('|') !== d.values.join('|')) {
        broken.push(`${match.name} vs ${d.name}`);
      }
    }
    expect(broken, 'paired enum(s) that stopped agreeing:').toEqual([]);

    // MEASURED: 2 pairs. Floored so that losing a pair — by renaming the export
    // or dropping the constraint — fails here rather than quietly reducing this
    // arm to comparing nothing, which is indistinguishable from success.
    expect(pairs.sort(), 'the enumerations compared on both sides:').toEqual([
      'AgentModelSchema=agent_sessions_model_check',
      'CryptoOrderStatusSchema=crypto_orders_status_check',
    ]);
  });
});
