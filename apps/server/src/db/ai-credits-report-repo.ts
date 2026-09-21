// What the shadow era has to be able to show before an account is moved (§8).
//
// Two reads, counts and sums only, and NOTHING that can name one customer. The
// shadow report answers "is the measurement right?"; the census answers "who is
// there to move?". Both are staff-only aggregates and neither returns an
// account id, an email, a session or a task.
//
// ⛔ THE REPORT IS A JOIN, AND THE JOIN IS THE WHOLE POINT. `credit_model_calls`
// knows what a call was CHARGED and cannot know what the provider listed it at;
// `usage_records` knows the list price and cannot know the charge. §8 step 3's
// exit criterion — "shadow charge = 2× list price" — is a ratio between them,
// and the only thing saying the two sides are the SAME turn is the reservation
// id S11 writes onto the usage row. Compared without that join it would be two
// populations that merely overlap: a turn on the customer's own key contributes
// usage rows and no calls, a turn whose measurement was lost contributes calls
// and no usage, and the ratio would drift toward whatever the window held.
//
// ⛔ THE CENSUS RUNS IN A READ-ONLY TRANSACTION, on purpose rather than by
// convention. It is the surface an operator opens repeatedly during a cutover,
// and "read-only" asserted in a comment is a claim; `SET TRANSACTION READ ONLY`
// is the database refusing. A later edit that added a write here would fail
// loudly instead of quietly mutating accounts during a census of them.
//
// ⛔ A LOST MEASUREMENT LEAVES NO ROW, so the report cannot count one. A
// reservation that failed rolls its transaction back — there is nothing in the
// database to find. `driftstack_ai_credits_shadow_lost_total` is the authority
// for losses, and it is the ONLY one: settling a task force-settles every
// `started` call on it, so a call whose shadow settle was lost ends as
// `settle_basis='no_record'`, which a call that really was sent and never
// reported ends as too. What this report can see instead is
// `tasks_not_closed_by_the_turn` — a task the lease keeper had to finish
// because the route never did — and `calls_never_settled`, which is the count
// of calls in flight at the instant it ran. Both are named for the row shape
// they count, not for the loss they would stand in for.

import { sql } from 'drizzle-orm';
import type { Database } from './client.js';

/**
 * One credit is one cent, and a list price is recorded in millicents, so a
 * millicent is a thousandth of a credit — a thousand microcredits.
 *
 * Both sides of the ratio are converted to MICROCREDITS before they are
 * divided. Dividing a µcr charge by a millicent cost would read as a ratio of
 * 2,000 and look like a catastrophic overcharge; the unit is in both field
 * names for the same reason the usage row keeps `cost_usd_cents` and
 * `list_price_cost_millicents` apart.
 */
export const MICROCREDITS_PER_MILLICENT = 1_000;

/** What the rate card's markup is, and therefore what every ratio below must equal. */
export const SHADOW_CHARGE_MARKUP = 2;

export interface AiCreditsShadowReportRow {
  /** UTC calendar day of the task's `created_at`. */
  day: string;
  /** The model the task was reserved on; every call of a task is on that model. */
  model: string;
  tasks: number;
  /**
   * SETTLED tasks the route did not settle — the lease keeper finished them
   * (M1). A task still running is not counted: it is `state='open'` with no
   * settle reason, the same row shape an orphan has, and the window ends at
   * `now()`.
   */
  tasksNotClosedByTheTurn: number;
  shadowCalls: number;
  /**
   * Call rows not in the `settled` state when the report ran.
   *
   * ⛔ THIS IS "IN FLIGHT", NOT "LOST", and the difference matters because the
   * shape it looks like it counts is one it cannot see: settling a task force-
   * settles every `started` call on it (`settleStartedCallsAfterACrash`), so a
   * call whose shadow settle was lost ends as `settle_basis='no_record'` —
   * indistinguishable, in the row, from a call that really was sent and whose
   * usage the provider never reported. `driftstack_ai_credits_shadow_lost_total`
   * stays the only authority for a lost leg.
   */
  callsNeverSettled: number;
  shadowChargeMicro: number;
  /** The same turns' real cost at the provider's list price, in microcredits. */
  listPriceMicro: number;
  /**
   * `shadowChargeMicro / listPriceMicro`. Must be {@link SHADOW_CHARGE_MARKUP}.
   * NULL over a day with no priced usage — a rate over nothing is not zero.
   */
  ratio: number | null;
  /** Calls whose measured cost passed the bound they were admitted under (§4.6). */
  callsOverBound: number;
  /**
   * Usage rows of these turns whose list price could not be computed — an
   * unpriced model, or a call the provider never reported. Counted rather than
   * treated as zero: "unknown" read as "free" would pull the ratio up and look
   * like an overcharge.
   */
  usageRowsWithNoListPrice: number;
}

export interface AiCreditsShadowReport {
  window: { since: string; until: string };
  /** What every `ratio` must equal, published beside them so the check is readable. */
  markup: number;
  rows: AiCreditsShadowReportRow[];
  /** What enforcement WOULD have refused, by reason. `none` is "it would have run". */
  wouldRefuse: Array<{ reason: string; tasks: number }>;
}

/** §8's cutover cohorts. Every account lands in exactly one — see the comment on the query. */
export const AI_CREDITS_COHORTS = ['C0', 'C1', 'C2', 'C3', 'C4'] as const;
export type AiCreditsCohort = (typeof AI_CREDITS_COHORTS)[number];

export interface AiCreditsCensus {
  /** Every cohort, zero-filled, so a missing key never reads as a cohort with nobody in it. */
  cohorts: Array<{ cohort: AiCreditsCohort; accounts: number; alreadyMoved: number }>;
  accounts: number;
  alreadyMoved: number;
}

export interface AiCreditsReportReader {
  shadowReport(args: { since: Date; until: Date }): Promise<AiCreditsShadowReport>;
  census(): Promise<AiCreditsCensus>;
}

/** Rows out of a raw `db.execute()`, which the driver returns as an array or as `{ rows }`. */
function rawRows(result: unknown): Array<Record<string, unknown>> {
  const rows = (result as { rows?: unknown[] }).rows ?? (result as unknown[]);
  return rows as Array<Record<string, unknown>>;
}

/** Postgres hands back `count`/`sum` as strings. A NULL sum over no rows is zero. */
function int(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * A millicent total, in microcredits.
 *
 * ⛔ SCALE FIRST, ROUND ONCE. A list price is almost never a whole millicent:
 * `listPriceCostMillicents` returns `Math.round(microcents) / 1000`, so a real
 * call prices at 3034.66 or 883.07 and only a fixture built out of round token
 * counts lands on an integer. Rounding the millicent total BEFORE scaling it
 * throws away up to 500 microcredits per row — and the number this feeds is
 * read against 2.0 exactly (§8 step 3), so the operator would see 1.99977 and
 * have no way to tell an arithmetic artefact from a real overcharge. Scaled
 * first, a day whose every call was measured correctly reads exactly 2.
 */
function micro(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value) * MICROCREDITS_PER_MILLICENT;
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export class DrizzleAiCreditsReportRepo implements AiCreditsReportReader {
  constructor(
    private readonly database: Database,
    /**
     * Lower-cased emails of the deployment's own accounts — cohort C0, the only
     * one the database cannot recognise on its own (staff are configuration, not
     * a column). Empty is honest: C0 is then zero rather than guessed at.
     */
    private readonly internalEmails: ReadonlySet<string> = new Set(),
  ) {}

  async shadowReport(args: { since: Date; until: Date }): Promise<AiCreditsShadowReport> {
    const db = this.database.db;
    const since = args.since.toISOString();
    const until = args.until.toISOString();
    // A task lives at most 30 minutes (`max_until`), and its usage rows are
    // written while it runs, so an hour either side of the task window contains
    // every row that can belong to one. It is there to bound the scan, not to
    // decide membership — the join does that.
    const window = sql`"created_at" >= ${since}::timestamptz AND "created_at" < ${until}::timestamptz`;

    const [report, refusals] = await Promise.all([
      db.execute(sql`
        WITH tasks AS (
          SELECT "id", "model", "state", "settle_reason",
                 ("created_at" AT TIME ZONE 'UTC')::date AS day
            FROM "credit_reservations"
           WHERE "mode" = 'shadow' AND ${window}
        ),
        per_task AS (
          -- The settled half of this condition is the half a turn IN FLIGHT
          -- needs. An open task has no settle reason yet, so "the reason is
          -- not completed" is true of a turn that is still running exactly as
          -- it is of one nobody came back for. The window ends at now(), so
          -- without it the criterion section 8 reads from here could never be
          -- zero on a deployment serving anybody, and a criterion that cannot
          -- be met reads, on the page, like one that is being missed. An open
          -- task is not yet evidence: when it closes it is counted by
          -- whichever of the two closed it.
          SELECT t.day, t."model", t."id" AS reservation_id,
                 (t."state" = 'settled' AND t."settle_reason" IS DISTINCT FROM 'completed')
                   AS keeper_closed,
                 count(c."id") FILTER (WHERE c."state" = 'settled') AS settled_calls,
                 count(c."id") FILTER (WHERE c."state" <> 'settled') AS unsettled_calls,
                 COALESCE(sum(c."charged_micro") FILTER (WHERE c."state" = 'settled'), 0)
                   AS charge_micro,
                 count(c."id") FILTER (
                   WHERE c."actual_micro" IS NOT NULL AND c."actual_micro" > c."bound_micro"
                 ) AS over_bound
            FROM tasks t
            LEFT JOIN "credit_model_calls" c ON c."reservation_id" = t."id"
           GROUP BY t.day, t."model", t."id", t."state", t."settle_reason"
        ),
        per_task_usage AS (
          SELECT "metadata"->>'credit_reservation_id' AS reservation_id,
                 COALESCE(
                   sum(("metadata"->>'list_price_cost_millicents')::numeric), 0
                 ) AS list_millicents,
                 count(*) FILTER (
                   WHERE "metadata"->>'list_price_cost_millicents' IS NULL
                 ) AS unpriced
            FROM "usage_records"
           WHERE "metadata"->>'credit_reservation_id' IS NOT NULL
             AND "recorded_at" >= ${since}::timestamptz - interval '1 hour'
             AND "recorded_at" < ${until}::timestamptz + interval '1 hour'
           GROUP BY 1
        )
        SELECT p.day::text AS day,
               p."model" AS model,
               count(*) AS tasks,
               count(*) FILTER (WHERE p.keeper_closed) AS keeper_closed,
               COALESCE(sum(p.settled_calls), 0) AS shadow_calls,
               COALESCE(sum(p.unsettled_calls), 0) AS calls_never_settled,
               COALESCE(sum(p.charge_micro), 0) AS charge_micro,
               COALESCE(sum(p.over_bound), 0) AS over_bound,
               COALESCE(sum(u.list_millicents), 0) AS list_millicents,
               COALESCE(sum(u.unpriced), 0) AS unpriced_rows
          FROM per_task p
          LEFT JOIN per_task_usage u ON u.reservation_id = p.reservation_id::text
         GROUP BY p.day, p."model"
         ORDER BY p.day DESC, p."model"`),
      db.execute(sql`
        SELECT COALESCE("would_refuse_reason", 'none') AS reason, count(*) AS tasks
          FROM "credit_reservations"
         WHERE "mode" = 'shadow' AND ${window}
         GROUP BY 1
         ORDER BY 1`),
    ]);

    return {
      window: { since, until },
      markup: SHADOW_CHARGE_MARKUP,
      rows: rawRows(report).map((r) => {
        const listPriceMicro = micro(r.list_millicents);
        const shadowChargeMicro = int(r.charge_micro);
        return {
          day: text(r.day),
          model: text(r.model),
          tasks: int(r.tasks),
          tasksNotClosedByTheTurn: int(r.keeper_closed),
          shadowCalls: int(r.shadow_calls),
          callsNeverSettled: int(r.calls_never_settled),
          shadowChargeMicro,
          listPriceMicro,
          // A rate over nothing is null, not zero: a day whose usage rows were
          // all unpriced and a day that cost nothing are different facts.
          ratio: listPriceMicro === 0 ? null : shadowChargeMicro / listPriceMicro,
          callsOverBound: int(r.over_bound),
          usageRowsWithNoListPrice: int(r.unpriced_rows),
        };
      }),
      wouldRefuse: rawRows(refusals).map((r) => ({
        reason: text(r.reason),
        tasks: int(r.tasks),
      })),
    };
  }

  /**
   * Who is there to move (§8 step 4's cohorts), and how many are already moved.
   *
   * ⛔ FIRST MATCH WINS, AND THE ORDER IS THIS FILE'S DECISION. §8 lists the
   * cohorts as a cutover SEQUENCE, and as written they overlap: an account with
   * a stored key AND bundled consent is described by both C2 and C3, and an
   * internal account is described by whichever of C1–C4 also fits it. A census
   * whose buckets overlap does not sum to the population it is counting, and the
   * number an operator reads before a cutover has to. So the CASE is ordered
   * C0 → C1 → C2 → C3 → C4 and each account is counted exactly once, in the
   * earliest cohort that describes it — which is also the order they are moved
   * in, so the count answers "how many does the next wave touch".
   *
   * DELETED accounts are excluded. They are not moved, and counting them would
   * inflate every wave's size with rows nobody will cut over.
   */
  async census(): Promise<AiCreditsCensus> {
    const internal = [...this.internalEmails].map((e) => e.toLowerCase());
    // ⛔ `IN ()` is a syntax error, so an empty roster becomes a FALSE predicate
    // rather than an empty list. No internal emails configured means C0 is
    // empty, which is the truth; it must not mean the statement fails or —
    // worse — that the branch silently matches everyone.
    const isInternal = internal.length > 0 ? sql`lower(a."email") IN ${internal}` : sql`false`;

    const rows = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      return rawRows(
        await tx.execute(sql`
          SELECT CASE
                   WHEN ${isInternal} THEN 'C0'
                   WHEN a."tier" = 'solo_manual' THEN 'C1'
                   WHEN a."tier" IN ('team_manual', 'agency_manual', 'api_starter')
                        AND a."byok_anthropic_api_key_ciphertext" IS NULL THEN 'C1'
                   WHEN a."byok_anthropic_api_key_ciphertext" IS NOT NULL THEN 'C2'
                   WHEN a."bundled_llm_consent" THEN 'C3'
                   ELSE 'C4'
                 END AS cohort,
                 count(*) AS accounts,
                 count(*) FILTER (WHERE ca."billing_mode" = 'credits') AS moved
            FROM "accounts" a
            LEFT JOIN "credit_accounts" ca ON ca."account_id" = a."id"
           WHERE a."status" <> 'deleted'
           GROUP BY 1
           ORDER BY 1`),
      );
    });

    const byCohort = new Map(rows.map((r) => [text(r.cohort), r]));
    const cohorts = AI_CREDITS_COHORTS.map((cohort) => {
      const row = byCohort.get(cohort);
      return {
        cohort,
        accounts: int(row?.accounts),
        alreadyMoved: int(row?.moved),
      };
    });
    return {
      cohorts,
      accounts: cohorts.reduce((n, c) => n + c.accounts, 0),
      alreadyMoved: cohorts.reduce((n, c) => n + c.alreadyMoved, 0),
    };
  }
}
