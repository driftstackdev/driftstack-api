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
import {
  CREDIT_LEDGER_ACTORS,
  CREDIT_LEDGER_KINDS,
  CREDIT_PLAN_OVERRIDE_REASONS,
} from '../../src/db/credit-ledger-repo.js';
import {
  CREDIT_CALL_BOUND_BASES,
  CREDIT_CALL_SETTLE_BASES,
  CREDIT_MODEL_CALL_PURPOSES,
  CREDIT_MODEL_CALL_STATES,
  CREDIT_RESERVATION_MODES,
  CREDIT_RESERVATION_STATES,
  CREDIT_SETTLE_REASONS,
  CREDIT_WOULD_REFUSE_REASONS,
} from '../../src/db/credit-reservations-repo.js';
import {
  CREDIT_CLAWBACK_SOURCES,
  CREDIT_CLAWBACK_STATES,
  CREDIT_WINDOW_LEVEL_CHANGE_REASONS,
  CREDIT_WINDOW_SOURCES,
} from '../../src/db/credit-windows-repo.js';
import {
  BILLING_INTERVALS,
  BILLING_INVOICE_LINE_KINDS,
  PERIOD_START_SOURCES,
} from '../../src/lib/stripe-billing-facts.js';
import {
  AGENT_TURN_DEATH_REASONS,
  AGENT_TURN_PERSISTED_OUTCOMES,
  AGENT_TURN_PERSISTED_STEP_KINDS,
  AGENT_TURN_TRANSPORTS,
} from '../../src/services/agent-turn-telemetry.js';

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

/**
 * Server-side constants that a CHECK constraint mirrors but that are NOT part of
 * the public api-types surface, so the `.options` sweep below cannot see them.
 *
 * ⛔ THIS IS THE STRONG REGISTRATION, AND IT IS THE ONE TO PREFER. The telemetry
 * table's four enumerations arrived with exported constants, so they are compared
 * here — live constraint against live constant, both directions, plus the
 * near-match arm — rather than being added to NO_EXPORTED_CONSTANT, which would
 * have recorded "nothing to compare" about values that have something. A unit
 * test already compares these constants to the migration's TEXT; this compares
 * them to what the database actually enforces, which is the copy that refuses a
 * row in production when the two drift.
 */
//
// ⚠️ THE PERSISTED SUBSETS, NOT THE FULL UNIONS. Two outcomes (`manual_note`,
// `replayed`) are counted in metrics and never written as a row, and the step
// kind `none` is a metric label the table spells NULL. Registering the full
// unions made this file's own near-match arm fire — correctly: "only in code
// [manual_note, replayed]" is exactly what a drifted pair looks like. The
// exception is real, so it is NAMED in src and compared here by name, instead
// of being re-derived as a filter in each place that needs it.
const SERVER_SIDE_ENUMS: { name: string; values: readonly string[] }[] = [
  { name: 'AGENT_TURN_PERSISTED_OUTCOMES', values: AGENT_TURN_PERSISTED_OUTCOMES },
  { name: 'AGENT_TURN_DEATH_REASONS', values: AGENT_TURN_DEATH_REASONS },
  { name: 'AGENT_TURN_PERSISTED_STEP_KINDS', values: AGENT_TURN_PERSISTED_STEP_KINDS },
  { name: 'AGENT_TURN_TRANSPORTS', values: AGENT_TURN_TRANSPORTS },
  // The AI credits ledger core (0128). CREDIT_LOT_KINDS is an api-types TUPLE,
  // not a zod enum, so the `.options` sweep below cannot see it and it is named
  // here. The kind lists pair twice each: the plain kind CHECK, and the shape
  // CHECK that names every kind in its branches (for lots, the spend rank per
  // kind; for ledger rows, the sign of each delta per kind).
  { name: 'CREDIT_LOT_KINDS', values: apiTypes.CREDIT_LOT_KINDS },
  { name: 'CREDIT_LEDGER_KINDS', values: CREDIT_LEDGER_KINDS },
  { name: 'CREDIT_LEDGER_ACTORS', values: CREDIT_LEDGER_ACTORS },
  { name: 'CREDIT_PLAN_OVERRIDE_REASONS', values: CREDIT_PLAN_OVERRIDE_REASONS },
  // Billing periods and paid invoices (0129). BILLING_INTERVALS pairs twice: the
  // subscription mirror's interval and the paid-invoice line's are one value set.
  { name: 'BILLING_INTERVALS', values: BILLING_INTERVALS },
  { name: 'BILLING_INVOICE_LINE_KINDS', values: BILLING_INVOICE_LINE_KINDS },
  { name: 'PERIOD_START_SOURCES', values: PERIOD_START_SOURCES },
  // Credit windows, their level history and clawbacks (0130).
  { name: 'CREDIT_WINDOW_SOURCES', values: CREDIT_WINDOW_SOURCES },
  { name: 'CREDIT_WINDOW_LEVEL_CHANGE_REASONS', values: CREDIT_WINDOW_LEVEL_CHANGE_REASONS },
  { name: 'CREDIT_CLAWBACK_SOURCES', values: CREDIT_CLAWBACK_SOURCES },
  { name: 'CREDIT_CLAWBACK_STATES', values: CREDIT_CLAWBACK_STATES },
  // Task reservations, their holds and their model calls (0131). Eight
  // enumerations, each registered rather than listed as unchecked: this is the
  // strong form, and the one the header above says to prefer. ⛔ The two shape
  // CHECKs they sit beside — a reservation's terminal shape and a call's — are
  // deliberately SEPARATE constraints from the vocabularies, so that each
  // enumeration is a clean value set. Written as one constraint each, the shape
  // would mix `open`/`settled`/`shadow` into the settle-reason list and this
  // file's own near-match arm would fire on a set that is correct.
  { name: 'CREDIT_RESERVATION_MODES', values: CREDIT_RESERVATION_MODES },
  { name: 'CREDIT_RESERVATION_STATES', values: CREDIT_RESERVATION_STATES },
  { name: 'CREDIT_WOULD_REFUSE_REASONS', values: CREDIT_WOULD_REFUSE_REASONS },
  { name: 'CREDIT_SETTLE_REASONS', values: CREDIT_SETTLE_REASONS },
  { name: 'CREDIT_MODEL_CALL_PURPOSES', values: CREDIT_MODEL_CALL_PURPOSES },
  { name: 'CREDIT_CALL_BOUND_BASES', values: CREDIT_CALL_BOUND_BASES },
  { name: 'CREDIT_MODEL_CALL_STATES', values: CREDIT_MODEL_CALL_STATES },
  { name: 'CREDIT_CALL_SETTLE_BASES', values: CREDIT_CALL_SETTLE_BASES },
];

/**
 * Every exported zod enum in `api-types`, by its runtime `.options`, plus the
 * server-side constants named above.
 */
function exportedEnums(): { name: string; values: string[] }[] {
  const out: { name: string; values: string[] }[] = SERVER_SIDE_ENUMS.map((e) => ({
    name: e.name,
    values: [...new Set(e.values)].sort(),
  }));
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
  // V-1328 — every arm below calls `guardUnreachable()`, which warns to the
  // console and returns. A console warning is not a test result: with Postgres
  // unreachable this file reported all of its comparisons green having made
  // none of them, in CI as readily as locally. Verified by pointing DATABASE_URL
  // at a dead port with CI set — the file passed.
  //
  // Locally an absent database is a legitimate skip. In CI it is a broken job,
  // and a broken job that reports success is the failure this whole series keeps
  // re-deriving.
  it('CRITICAL the database was reachable, so a green run here is not "no database". Every comparison below returns early when the connection failed, so without this arm an unreachable Postgres reports ten enumerations verified having read neither side.', () => {
    if (!process.env.CI && !dbReachable) return;
    expect(dbReachable, `could not reach ${DB_URL} — no enumeration below was compared`).toBe(true);
  });

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
      'claude-opus-5',
      'claude-sonnet-4-6',
      'claude-sonnet-5',
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
      'AGENT_TURN_DEATH_REASONS=agent_turn_telemetry_death_reason',
      'AGENT_TURN_PERSISTED_OUTCOMES=agent_turn_telemetry_outcome',
      'AGENT_TURN_PERSISTED_STEP_KINDS=agent_turn_telemetry_died_step_kind',
      'AGENT_TURN_TRANSPORTS=agent_turn_telemetry_transport',
      'AgentModelSchema=agent_sessions_model_check',
      'AiBillingSchema=credit_accounts_billing_mode',
      'AiDebtReasonSchema=credit_ledger_debt_reason',
      'AiSourceSchema=credit_accounts_ai_source',
      'AiSourceSetBySchema=credit_accounts_ai_source_set_by',
      'BILLING_INTERVALS=billing_invoice_payments_line_interval',
      'BILLING_INTERVALS=subscriptions_billing_interval',
      'BILLING_INVOICE_LINE_KINDS=billing_invoice_payments_line_kind',
      'CREDIT_CALL_BOUND_BASES=credit_model_calls_basis',
      'CREDIT_CALL_SETTLE_BASES=credit_model_calls_settle_basis',
      'CREDIT_CLAWBACK_SOURCES=credit_clawbacks_source',
      // The shape CHECK names two of the three states and the 'unmatched' TARGET
      // KEY, which spells the third state: the same three words, so it pairs.
      'CREDIT_CLAWBACK_STATES=credit_clawbacks_applied_shape',
      'CREDIT_CLAWBACK_STATES=credit_clawbacks_state',
      'CREDIT_LEDGER_ACTORS=credit_ledger_actor',
      'CREDIT_LEDGER_KINDS=credit_ledger_kind',
      'CREDIT_LEDGER_KINDS=credit_ledger_shape',
      'CREDIT_LOT_KINDS=credit_lots_kind',
      'CREDIT_LOT_KINDS=credit_lots_rank_matches_kind',
      'CREDIT_MODEL_CALL_PURPOSES=credit_model_calls_purpose',
      'CREDIT_MODEL_CALL_STATES=credit_model_calls_state',
      'CREDIT_PLAN_OVERRIDE_REASONS=credit_plan_overrides_reason',
      'CREDIT_RESERVATION_MODES=credit_reservations_mode',
      'CREDIT_RESERVATION_STATES=credit_reservations_state',
      'CREDIT_SETTLE_REASONS=credit_reservations_settle_reason',
      'CREDIT_WINDOW_LEVEL_CHANGE_REASONS=credit_window_level_changes_reason',
      'CREDIT_WINDOW_SOURCES=credit_windows_source',
      'CREDIT_WOULD_REFUSE_REASONS=credit_reservations_would_refuse_reason',
      'CryptoOrderStatusSchema=crypto_orders_status_check',
      'PERIOD_START_SOURCES=subscriptions_period_start_source',
    ]);
  });
});
