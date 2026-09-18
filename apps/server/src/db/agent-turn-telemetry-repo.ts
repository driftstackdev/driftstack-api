// Storage for the per-request AI diagnostics rows (migration 0125).
//
// Three operations and no fourth: insert one row, aggregate a time window,
// prune by age. There is deliberately NO method that returns rows. The table is
// content-free and unjoinable by construction, and the read side keeps the same
// promise from the other end — an operator surface built on this repo can show
// counts, rates and percentiles, and cannot be extended into a per-customer
// drill-down without first adding a method here, where that decision is visible.
//
// Two implementations, held to one answer. The Drizzle one aggregates in SQL
// (`percentile_cont`, FILTER) because a 30-day window must not be dragged into
// the process to be counted; the in-memory one computes the same figures in
// JavaScript for fixtures without Postgres. `agent-turn-telemetry-repo`
// (integration) seeds both with identical rows and requires identical output.

import { lt, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { agentTurnTelemetry } from './schema.js';
import {
  AGENT_TURN_DEATH_OUTCOMES,
  AGENT_TURN_RAN_OUTCOMES,
  AGENT_TURN_TURNED_AWAY_OUTCOMES,
  turnRan,
  type AgentTurnOutcome,
  type AgentTurnTelemetryRow,
  type AgentTurnTelemetryWriter,
} from '../services/agent-turn-telemetry.js';

export interface Percentiles {
  /** Null when no row in the window had the measurement. */
  p50: number | null;
  p95: number | null;
}

/** Raw figures for one window. Rates are derived from these by
 *  `buildAgentTurnSummary`, so both repo implementations stay arithmetic-free. */
export interface AgentTurnTelemetryAggregates {
  byOutcome: Record<string, number>;
  /** Turns that reached a verdict other than `completed` (failed / refused /
   *  stopped / error), grouped by why. "Where tasks die." */
  deaths: Array<{ reason: string; stepKind: string | null; count: number }>;
  /** Requests answered before any task existed (409 / 429 / other 4xx), grouped
   *  by why. Apart from `deaths` so a burst of 409s cannot dilute its shares. */
  turnedAway: Array<{ reason: string; stepKind: string | null; count: number }>;
  /** Over the turns that ran. */
  byModel: Array<{ model: string; count: number }>;
  ran: {
    count: number;
    /** Turns with at least one re-plan attempt. */
    replanned: number;
    replansSum: number;
    recoveredAfterReplan: number;
    customerStopped: number;
    viewerDisconnected: number;
    modelCallsSum: number;
    stepsRunSum: number;
    stepsSucceededSum: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costMillicents: number;
  };
  percentilesMs: {
    turn: Percentiles;
    /** Streaming requests only: the transport on which a customer sees it. */
    firstProgressStream: Percentiles;
    firstProgressAll: Percentiles;
    planning: Percentiles;
    startingBrowser: Percentiles;
    executing: Percentiles;
    readingPage: Percentiles;
    answering: Percentiles;
    /** duration − time to first progress − every phase: what the route did
     *  after the runtime returned (storage), over turns that ran and showed
     *  progress. */
    afterTurn: Percentiles;
  };
}

export interface AgentTurnTelemetryRepo extends AgentTurnTelemetryWriter {
  aggregate(args: { since: Date; until: Date }): Promise<AgentTurnTelemetryAggregates>;
  /** Delete rows older than `cutoff`, at most `limit` of them. Returns the count. */
  pruneOlderThan(cutoff: Date, limit: number): Promise<number>;
}

const DEATH: ReadonlySet<string> = new Set(AGENT_TURN_DEATH_OUTCOMES);
const TURNED_AWAY: ReadonlySet<string> = new Set(AGENT_TURN_TURNED_AWAY_OUTCOMES);

function afterTurnMs(r: AgentTurnTelemetryRow): number {
  return Math.max(
    0,
    r.durationMs -
      (r.timeToFirstProgressMs ?? 0) -
      r.planningMs -
      r.startingBrowserMs -
      r.executingMs -
      r.readingPageMs -
      r.answeringMs,
  );
}

// ── in-memory ─────────────────────────────────────────────────────────────

/** `percentile_cont`: linear interpolation between the two nearest ranks. */
function percentileCont(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = fraction * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return Math.round(low + (high - low) * (rank - lower));
}

function percentilesOf(values: number[]): Percentiles {
  return { p50: percentileCont(values, 0.5), p95: percentileCont(values, 0.95) };
}

export class InMemoryAgentTurnTelemetryRepo implements AgentTurnTelemetryRepo {
  private rows: AgentTurnTelemetryRow[] = [];

  insert(row: AgentTurnTelemetryRow): Promise<void> {
    this.rows.push({ ...row });
    return Promise.resolve();
  }

  /** Test-only. The production interface has no row read, on purpose. */
  allForTest(): ReadonlyArray<AgentTurnTelemetryRow> {
    return this.rows;
  }

  aggregate(args: { since: Date; until: Date }): Promise<AgentTurnTelemetryAggregates> {
    const inWindow = this.rows.filter(
      (r) => r.occurredAt >= args.since && r.occurredAt <= args.until,
    );
    const ran = inWindow.filter((r) => turnRan(r));
    const byOutcome: Record<string, number> = {};
    for (const r of inWindow) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;

    const groupByReason = (
      among: ReadonlySet<string>,
    ): Array<{ reason: string; stepKind: string | null; count: number }> => {
      const counts = new Map<string, { reason: string; stepKind: string | null; count: number }>();
      for (const r of inWindow) {
        if (!among.has(r.outcome)) continue;
        const key = `${r.deathReason}|${r.diedStepKind ?? ''}`;
        const entry = counts.get(key) ?? {
          reason: r.deathReason,
          stepKind: r.diedStepKind,
          count: 0,
        };
        entry.count += 1;
        counts.set(key, entry);
      }
      return sortDeaths([...counts.values()]);
    };
    const modelCounts = new Map<string, number>();
    for (const r of ran) modelCounts.set(r.model, (modelCounts.get(r.model) ?? 0) + 1);

    const sum = (pick: (r: AgentTurnTelemetryRow) => number): number =>
      ran.reduce((total, r) => total + pick(r), 0);
    const positive = (pick: (r: AgentTurnTelemetryRow) => number): number[] =>
      inWindow.map(pick).filter((v) => v > 0);
    const firstProgress = (rows: AgentTurnTelemetryRow[]): number[] =>
      rows.flatMap((r) => (r.timeToFirstProgressMs === null ? [] : [r.timeToFirstProgressMs]));

    return Promise.resolve({
      byOutcome,
      deaths: groupByReason(DEATH),
      turnedAway: groupByReason(TURNED_AWAY),
      byModel: sortModels([...modelCounts.entries()].map(([model, count]) => ({ model, count }))),
      ran: {
        count: ran.length,
        replanned: ran.filter((r) => r.replans > 0).length,
        replansSum: sum((r) => r.replans),
        recoveredAfterReplan: ran.filter((r) => r.recoveredAfterReplan).length,
        customerStopped: ran.filter((r) => r.customerStopped).length,
        viewerDisconnected: ran.filter((r) => r.viewerDisconnected).length,
        modelCallsSum: sum((r) => r.modelCalls),
        stepsRunSum: sum((r) => r.stepsRun),
        stepsSucceededSum: sum((r) => r.stepsSucceeded),
        inputTokens: sum((r) => r.inputTokens),
        outputTokens: sum((r) => r.outputTokens),
        cacheReadTokens: sum((r) => r.cacheReadTokens),
        cacheWriteTokens: sum((r) => r.cacheWriteTokens),
        costMillicents: sum((r) => r.estimatedCostMillicents),
      },
      percentilesMs: {
        turn: percentilesOf(ran.map((r) => r.durationMs)),
        firstProgressStream: percentilesOf(
          firstProgress(inWindow.filter((r) => r.transport === 'stream')),
        ),
        firstProgressAll: percentilesOf(firstProgress(inWindow)),
        planning: percentilesOf(positive((r) => r.planningMs)),
        startingBrowser: percentilesOf(positive((r) => r.startingBrowserMs)),
        executing: percentilesOf(positive((r) => r.executingMs)),
        readingPage: percentilesOf(positive((r) => r.readingPageMs)),
        answering: percentilesOf(positive((r) => r.answeringMs)),
        afterTurn: percentilesOf(
          ran.filter((r) => r.timeToFirstProgressMs !== null).map(afterTurnMs),
        ),
      },
    });
  }

  pruneOlderThan(cutoff: Date, limit: number): Promise<number> {
    const doomed = this.rows.filter((r) => r.occurredAt < cutoff).slice(0, limit);
    const doomedSet = new Set(doomed);
    this.rows = this.rows.filter((r) => !doomedSet.has(r));
    return Promise.resolve(doomed.length);
  }
}

/** One ordering for both implementations: most frequent first, then by name. */
function sortDeaths<T extends { reason: string; stepKind: string | null; count: number }>(
  deaths: T[],
): T[] {
  return deaths.sort(
    (a, b) =>
      b.count - a.count ||
      a.reason.localeCompare(b.reason) ||
      (a.stepKind ?? '').localeCompare(b.stepKind ?? ''),
  );
}

function sortModels<T extends { model: string; count: number }>(models: T[]): T[] {
  return models.sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
}

// ── Drizzle ───────────────────────────────────────────────────────────────

/** Rows out of a raw `db.execute()`, which the driver returns either as an array
 *  or as `{ rows }` depending on the adapter. */
function rawRows(result: unknown): Array<Record<string, unknown>> {
  const rows = (result as { rows?: unknown[] }).rows ?? (result as unknown[]);
  return rows as Array<Record<string, unknown>>;
}

/** Postgres returns `count`/`sum` as strings (bigint/numeric). A NULL sum over
 *  no rows is zero, which is what an empty window honestly holds. */
function int(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function nullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// Outcome lists reach SQL as BOUND PARAMETERS — Drizzle renders an array as
// `($1, $2, …)` — never as text spliced into the statement. They are source
// constants and could not carry input either way, but "no raw SQL anywhere in
// src" is a rule that is only checkable while it has no exceptions
// (`no-raw-sql-injection-surface`).
//
// `turnRan`, in SQL: a ran outcome, or an `error` that had already called the
// model. One fragment, used by every per-turn figure below.
const RAN_SQL = sql`("outcome" IN ${[...AGENT_TURN_RAN_OUTCOMES]} OR ("outcome" = 'error' AND "model_calls" > 0))`;
const DEATH_OUTCOMES: AgentTurnOutcome[] = [...AGENT_TURN_DEATH_OUTCOMES];
const TURNED_AWAY_OUTCOMES: AgentTurnOutcome[] = [...AGENT_TURN_TURNED_AWAY_OUTCOMES];
const AFTER_TURN_SQL = sql`GREATEST(0, "duration_ms" - COALESCE("time_to_first_progress_ms", 0) - "planning_ms" - "starting_browser_ms" - "executing_ms" - "reading_page_ms" - "answering_ms")`;

export class DrizzleAgentTurnTelemetryRepo implements AgentTurnTelemetryRepo {
  constructor(private readonly database: Database) {}

  async insert(row: AgentTurnTelemetryRow): Promise<void> {
    await this.database.db.insert(agentTurnTelemetry).values({
      occurredAt: row.occurredAt,
      outcome: row.outcome,
      deathReason: row.deathReason,
      diedStepIndex: row.diedStepIndex,
      diedStepKind: row.diedStepKind,
      httpStatus: row.httpStatus,
      transport: row.transport,
      model: row.model,
      stepsPlanned: row.stepsPlanned,
      stepsRun: row.stepsRun,
      stepsSucceeded: row.stepsSucceeded,
      replans: row.replans,
      modelCalls: row.modelCalls,
      recoveredAfterReplan: row.recoveredAfterReplan,
      durationMs: row.durationMs,
      timeToFirstProgressMs: row.timeToFirstProgressMs,
      planningMs: row.planningMs,
      startingBrowserMs: row.startingBrowserMs,
      executingMs: row.executingMs,
      readingPageMs: row.readingPageMs,
      answeringMs: row.answeringMs,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      estimatedCostMillicents: row.estimatedCostMillicents,
      customerStopped: row.customerStopped,
      viewerDisconnected: row.viewerDisconnected,
    });
  }

  async aggregate(args: { since: Date; until: Date }): Promise<AgentTurnTelemetryAggregates> {
    const since = args.since.toISOString();
    const until = args.until.toISOString();
    const db = this.database.db;
    // INCLUSIVE at `until`. The caller passes "now", and a request that ended in
    // this same millisecond is part of "up to now"; excluding it made the row a
    // summary was asked about the one row it could not see.
    const window = sql`"occurred_at" >= ${since}::timestamptz AND "occurred_at" <= ${until}::timestamptz`;

    const [outcomes, deaths, turnedAway, models, totals] = await Promise.all([
      db.execute(sql`
        SELECT "outcome", count(*) AS n
          FROM "agent_turn_telemetry"
         WHERE ${window}
         GROUP BY "outcome"
         ORDER BY "outcome"`),
      db.execute(sql`
        SELECT "death_reason", "died_step_kind", count(*) AS n
          FROM "agent_turn_telemetry"
         WHERE ${window} AND "outcome" IN ${DEATH_OUTCOMES}
         GROUP BY "death_reason", "died_step_kind"
         ORDER BY n DESC, "death_reason", "died_step_kind"`),
      db.execute(sql`
        SELECT "death_reason", "died_step_kind", count(*) AS n
          FROM "agent_turn_telemetry"
         WHERE ${window} AND "outcome" IN ${TURNED_AWAY_OUTCOMES}
         GROUP BY "death_reason", "died_step_kind"
         ORDER BY n DESC, "death_reason", "died_step_kind"`),
      db.execute(sql`
        SELECT "model", count(*) AS n
          FROM "agent_turn_telemetry"
         WHERE ${window} AND ${RAN_SQL}
         GROUP BY "model"
         ORDER BY n DESC, "model"`),
      db.execute(sql`
        SELECT
          count(*) FILTER (WHERE ${RAN_SQL}) AS ran,
          count(*) FILTER (WHERE ${RAN_SQL} AND "replans" > 0) AS replanned,
          sum("replans") FILTER (WHERE ${RAN_SQL}) AS replans_sum,
          count(*) FILTER (WHERE ${RAN_SQL} AND "recovered_after_replan") AS recovered,
          count(*) FILTER (WHERE ${RAN_SQL} AND "customer_stopped") AS customer_stopped,
          count(*) FILTER (WHERE ${RAN_SQL} AND "viewer_disconnected") AS viewer_disconnected,
          sum("model_calls") FILTER (WHERE ${RAN_SQL}) AS model_calls_sum,
          sum("steps_run") FILTER (WHERE ${RAN_SQL}) AS steps_run_sum,
          sum("steps_succeeded") FILTER (WHERE ${RAN_SQL}) AS steps_succeeded_sum,
          sum("input_tokens") FILTER (WHERE ${RAN_SQL}) AS input_tokens,
          sum("output_tokens") FILTER (WHERE ${RAN_SQL}) AS output_tokens,
          sum("cache_read_tokens") FILTER (WHERE ${RAN_SQL}) AS cache_read_tokens,
          sum("cache_write_tokens") FILTER (WHERE ${RAN_SQL}) AS cache_write_tokens,
          sum("estimated_cost_millicents") FILTER (WHERE ${RAN_SQL}) AS cost_millicents,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY "duration_ms")
            FILTER (WHERE ${RAN_SQL}) AS turn_p50,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY "duration_ms")
            FILTER (WHERE ${RAN_SQL}) AS turn_p95,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY "time_to_first_progress_ms")
            FILTER (WHERE "transport" = 'stream') AS first_stream_p50,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY "time_to_first_progress_ms")
            FILTER (WHERE "transport" = 'stream') AS first_stream_p95,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY "time_to_first_progress_ms") AS first_all_p50,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY "time_to_first_progress_ms") AS first_all_p95,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY "planning_ms")
            FILTER (WHERE "planning_ms" > 0) AS planning_p50,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY "planning_ms")
            FILTER (WHERE "planning_ms" > 0) AS planning_p95,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY "starting_browser_ms")
            FILTER (WHERE "starting_browser_ms" > 0) AS starting_browser_p50,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY "starting_browser_ms")
            FILTER (WHERE "starting_browser_ms" > 0) AS starting_browser_p95,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY "executing_ms")
            FILTER (WHERE "executing_ms" > 0) AS executing_p50,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY "executing_ms")
            FILTER (WHERE "executing_ms" > 0) AS executing_p95,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY "reading_page_ms")
            FILTER (WHERE "reading_page_ms" > 0) AS reading_page_p50,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY "reading_page_ms")
            FILTER (WHERE "reading_page_ms" > 0) AS reading_page_p95,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY "answering_ms")
            FILTER (WHERE "answering_ms" > 0) AS answering_p50,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY "answering_ms")
            FILTER (WHERE "answering_ms" > 0) AS answering_p95,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY ${AFTER_TURN_SQL})
            FILTER (WHERE ${RAN_SQL} AND "time_to_first_progress_ms" IS NOT NULL) AS after_turn_p50,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY ${AFTER_TURN_SQL})
            FILTER (WHERE ${RAN_SQL} AND "time_to_first_progress_ms" IS NOT NULL) AS after_turn_p95
          FROM "agent_turn_telemetry"
         WHERE ${window}`),
    ]);

    const byOutcome: Record<string, number> = {};
    for (const r of rawRows(outcomes)) byOutcome[String(r['outcome'])] = int(r['n']);
    const t = rawRows(totals)[0] ?? {};
    const pair = (prefix: string): Percentiles => ({
      p50: nullableInt(t[`${prefix}_p50`]),
      p95: nullableInt(t[`${prefix}_p95`]),
    });
    const reasonRows = (
      result: unknown,
    ): Array<{ reason: string; stepKind: string | null; count: number }> =>
      sortDeaths(
        rawRows(result).map((r) => ({
          reason: String(r['death_reason']),
          stepKind: typeof r['died_step_kind'] === 'string' ? r['died_step_kind'] : null,
          count: int(r['n']),
        })),
      );
    return {
      byOutcome,
      deaths: reasonRows(deaths),
      turnedAway: reasonRows(turnedAway),
      byModel: sortModels(
        rawRows(models).map((r) => ({ model: String(r['model']), count: int(r['n']) })),
      ),
      ran: {
        count: int(t['ran']),
        replanned: int(t['replanned']),
        replansSum: int(t['replans_sum']),
        recoveredAfterReplan: int(t['recovered']),
        customerStopped: int(t['customer_stopped']),
        viewerDisconnected: int(t['viewer_disconnected']),
        modelCallsSum: int(t['model_calls_sum']),
        stepsRunSum: int(t['steps_run_sum']),
        stepsSucceededSum: int(t['steps_succeeded_sum']),
        inputTokens: int(t['input_tokens']),
        outputTokens: int(t['output_tokens']),
        cacheReadTokens: int(t['cache_read_tokens']),
        cacheWriteTokens: int(t['cache_write_tokens']),
        costMillicents: int(t['cost_millicents']),
      },
      percentilesMs: {
        turn: pair('turn'),
        firstProgressStream: pair('first_stream'),
        firstProgressAll: pair('first_all'),
        planning: pair('planning'),
        startingBrowser: pair('starting_browser'),
        executing: pair('executing'),
        readingPage: pair('reading_page'),
        answering: pair('answering'),
        afterTurn: pair('after_turn'),
      },
    };
  }

  async pruneOlderThan(cutoff: Date, limit: number): Promise<number> {
    // Bounded, so a long-neglected backlog cannot hold the job poller: the
    // oldest `limit` ids first, and the next tick takes the rest.
    const doomed = this.database.db
      .select({ id: agentTurnTelemetry.id })
      .from(agentTurnTelemetry)
      .where(lt(agentTurnTelemetry.occurredAt, cutoff))
      .orderBy(agentTurnTelemetry.occurredAt)
      .limit(limit);
    const deleted = await this.database.db
      .delete(agentTurnTelemetry)
      .where(sql`${agentTurnTelemetry.id} IN (${doomed})`)
      .returning({ id: agentTurnTelemetry.id });
    return deleted.length;
  }
}
