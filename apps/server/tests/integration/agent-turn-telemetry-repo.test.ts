// agent_turn_telemetry on real Postgres.
//
// Four things only the database can prove:
//
//   1. CONTENT-FREE, END TO END. A turn built out of sentinels, written through
//      the real collector and the real Drizzle writer, leaves a row in which no
//      column — read back raw, as text — contains any of them.
//   2. THE CHECK CONSTRAINTS ARE REAL. Parsing the migration shows what it SAYS;
//      only an INSERT shows what Postgres ENFORCES. Free text in any text column
//      is refused, and every member of every source union is accepted.
//   3. SQL AND JAVASCRIPT AGREE. The operator view is computed by
//      `percentile_cont` in production and by arithmetic in every fixture; the
//      same rows must give the same answer, or the fixture-based tests describe
//      a different product.
//   4. The prune is bounded and takes the oldest first.
//
// Runs in its own database: `aggregate` and `pruneOlderThan` are global sweeps
// over the table, and on the shared database their answers would depend on
// whichever other file happened to be running.

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentIntent } from '@driftstack/api-types';
import {
  DrizzleAgentTurnTelemetryRepo,
  InMemoryAgentTurnTelemetryRepo,
} from '../../src/db/agent-turn-telemetry-repo.js';
import type * as schema from '../../src/db/schema.js';
import {
  AGENT_TURN_DEATH_REASONS,
  AGENT_TURN_MODEL_LABELS,
  AGENT_TURN_OUTCOMES,
  AGENT_TURN_STEP_KINDS,
  AgentTurnTelemetry,
  type AgentTurnTelemetryRow,
} from '../../src/services/agent-turn-telemetry.js';
import type { AgentSessionRecord } from '../../src/services/agent-sessions.js';
import { assertIsolatedDatabase, ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import { AGENT_TURN_ROW_NOW, row } from '../unit/_helpers/agent-turn-telemetry-row.js';

const ISOLATED_DB_NAME = 'driftstack_iso_agent_turn_telemetry';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: ReturnType<typeof postgres> | null = null;

function repo(): DrizzleAgentTurnTelemetryRepo {
  if (client === null) throw new Error('no database client');
  return new DrizzleAgentTurnTelemetryRepo({
    client,
    db: drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>,
    close: async () => {},
  });
}

beforeAll(async () => {
  const isolated = await ensureIsolatedDatabase(ISOLATED_DB_NAME);
  if (isolated === null || !RUN_DB_TESTS) return;
  const candidate = postgres(isolated, { max: 3, onnotice: () => undefined });
  try {
    await candidate`SELECT 1`;
  } catch {
    await candidate.end({ timeout: 1 }).catch(() => {});
    return;
  }
  // This file TRUNCATEs; prove which database that will land on first.
  await assertIsolatedDatabase(candidate, ISOLATED_DB_NAME);
  client = candidate;
});

afterAll(async () => {
  await client?.end({ timeout: 1 }).catch(() => {});
});

beforeEach(async () => {
  if (client !== null) await client`TRUNCATE agent_turn_telemetry`;
});

const WINDOW = {
  since: new Date(AGENT_TURN_ROW_NOW - 24 * 3_600_000),
  until: new Date(AGENT_TURN_ROW_NOW),
};

describe.skipIf(!RUN_DB_TESTS)('agent_turn_telemetry on real Postgres', () => {
  it('the database is reachable — otherwise every arm below would pass by skipping its own body', () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
  });

  it('CRITICAL content-free end to end: a sentinel turn through the real collector and writer leaves no sentinel in ANY column', async () => {
    const SENTINELS = {
      task: 'SENTINEL_TASK find my order',
      url: 'https://sentinel.example/SENTINEL_URL?k=SENTINEL_QUERY',
      selector: '#SENTINEL_SELECTOR',
      page: 'SENTINEL_PAGE_TEXT',
      answer: 'SENTINEL_ANSWER 203.0.113.9',
      credential: 'SENTINEL_CREDENTIAL_NAME',
      session: 'ags_SENTINEL_SESSION',
      model: 'SENTINEL_MODEL',
    };
    const telemetry = new AgentTurnTelemetry({ writer: repo() });
    const navigate: AgentIntent = { kind: 'navigate', url: SENTINELS.url };
    const type = {
      kind: 'interact',
      action: 'type',
      selector: SENTINELS.selector,
      text: `{{${SENTINELS.credential}}}`,
    } as unknown as AgentIntent;

    const c = telemetry.begin({ agentSessionId: SENTINELS.session, transport: 'stream' });
    const progress = (e: Parameters<typeof c.recordProgress>[0]): void => c.recordProgress(e);
    progress({ kind: 'phase', phase: 'planning' });
    telemetry.observeModelCall({
      agentSessionId: SENTINELS.session,
      usage: { model: SENTINELS.model, anthropicInputTokens: 10, anthropicOutputTokens: 5 },
    });
    progress({ kind: 'plan', intents: [navigate, type], total: 2 });
    progress({ kind: 'phase', phase: 'answering' });
    progress({ kind: 'answer', answer: SENTINELS.answer });
    c.observeResult({
      kind: 'plan-executed',
      decomposer: { kind: 'plan', intents: [navigate, type], tokensConsumed: 15 },
      executor: {
        ok: false,
        results: [
          { kind: 'success', intent: navigate, summary: SENTINELS.page },
          { kind: 'failure', intent: type, reason: `${SENTINELS.page} never became visible` },
        ],
      },
      session: { id: SENTINELS.session } as unknown as AgentSessionRecord,
      answer: SENTINELS.answer,
    });
    c.finish({
      status: 200,
      body: { answer: SENTINELS.answer, detail: SENTINELS.task, user_message: SENTINELS.task },
    });
    await telemetry.flush();

    const rows = await client!`SELECT * FROM agent_turn_telemetry`;
    expect(rows).toHaveLength(1);
    const stored = rows[0] ?? {};
    // The row was really classified from the sentinel-laden inputs…
    expect(stored['outcome']).toBe('failed');
    expect(stored['death_reason']).toBe('element_never_appeared_in_retry_budget');
    expect(stored['died_step_kind']).toBe('interact');
    expect(stored['model']).toBe('other');
    // …and kept none of them. Every column, as text.
    for (const [column, value] of Object.entries(stored)) {
      const text = value instanceof Date ? value.toISOString() : String(value);
      expect(text, `column ${column}`).not.toContain('SENTINEL');
      expect(text, `column ${column}`).not.toContain('sentinel');
      for (const sentinel of Object.values(SENTINELS)) {
        expect(text.includes(sentinel), `column ${column} holds ${sentinel}`).toBe(false);
      }
    }
  });

  it('CRITICAL Postgres REFUSES free text in every text column — the guarantee does not rest on the writer behaving', async () => {
    const insertRaw = async (over: Record<string, string>): Promise<unknown> => {
      const v = {
        outcome: 'completed',
        death_reason: 'none',
        died_step_kind: null as string | null,
        transport: 'json',
        model: 'none',
        ...over,
      };
      return client!`
        INSERT INTO agent_turn_telemetry (
          outcome, death_reason, died_step_kind, http_status, transport, model,
          steps_planned, steps_run, steps_succeeded, replans, model_calls,
          recovered_after_replan, duration_ms, planning_ms, starting_browser_ms,
          executing_ms, reading_page_ms, answering_ms, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, estimated_cost_millicents,
          customer_stopped, viewer_disconnected
        ) VALUES (
          ${v.outcome}, ${v.death_reason}, ${v.died_step_kind}, 200, ${v.transport}, ${v.model},
          0, 0, 0, 0, 0, false, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, false
        )`;
    };
    // The control: the statement itself is valid, so a rejection below is the
    // CHECK and not a typo in this test.
    await expect(insertRaw({})).resolves.toBeDefined();

    const prose = 'find the cheapest flight to Lisbon';
    await expect(insertRaw({ outcome: prose })).rejects.toThrow(/agent_turn_telemetry_outcome/);
    await expect(insertRaw({ death_reason: prose })).rejects.toThrow(
      /agent_turn_telemetry_death_reason/,
    );
    await expect(insertRaw({ died_step_kind: '#checkout-button' })).rejects.toThrow(
      /agent_turn_telemetry_died_step_kind/,
    );
    await expect(insertRaw({ transport: prose })).rejects.toThrow(/agent_turn_telemetry_transport/);
    await expect(insertRaw({ model: 'https://example.test/page' })).rejects.toThrow(
      /agent_turn_telemetry_model/,
    );
    await expect(insertRaw({ model: prose })).rejects.toThrow(/agent_turn_telemetry_model/);
    // The two metrics-only outcomes are not storable either.
    await expect(insertRaw({ outcome: 'replayed' })).rejects.toThrow(
      /agent_turn_telemetry_outcome/,
    );
  });

  it('every member of every source union IS accepted — a union wider than its CHECK would fail silently in production, swallowed by design', async () => {
    const r = repo();
    const persisted = AGENT_TURN_OUTCOMES.filter((o) => o !== 'manual_note' && o !== 'replayed');
    for (const outcome of persisted) await r.insert(row({ outcome }));
    for (const deathReason of AGENT_TURN_DEATH_REASONS) await r.insert(row({ deathReason }));
    for (const kind of AGENT_TURN_STEP_KINDS) {
      await r.insert(row({ diedStepKind: kind === 'none' ? null : kind }));
    }
    for (const model of AGENT_TURN_MODEL_LABELS) await r.insert(row({ model }));
    await r.insert(row({ transport: 'json' }));
    const counted = await client!`SELECT count(*)::int AS n FROM agent_turn_telemetry`;
    expect(counted[0]?.['n']).toBe(
      persisted.length +
        AGENT_TURN_DEATH_REASONS.length +
        AGENT_TURN_STEP_KINDS.length +
        AGENT_TURN_MODEL_LABELS.length +
        1,
    );
  });

  it('CRITICAL the SQL aggregation and the in-memory one give the SAME answer for the same rows', async () => {
    const at = (minutesAgo: number): Date => new Date(AGENT_TURN_ROW_NOW - minutesAgo * 60_000);
    const rows: AgentTurnTelemetryRow[] = [
      row({ occurredAt: at(5), durationMs: 1200, timeToFirstProgressMs: 150, planningMs: 900 }),
      row({
        occurredAt: at(10),
        // Long enough that "after the turn" is POSITIVE with every phase
        // subtracted (2380 ms): at 8400 the clamp to zero hid a SQL expression
        // that had forgotten a phase.
        durationMs: 14_400,
        timeToFirstProgressMs: 420,
        planningMs: 3100,
        answeringMs: 2200,
        readingPageMs: 300,
        replans: 1,
        recoveredAfterReplan: true,
        modelCalls: 3,
        cacheReadTokens: 9000,
        cacheWriteTokens: 1200,
        estimatedCostMillicents: 4321,
      }),
      row({
        occurredAt: at(15),
        outcome: 'failed',
        deathReason: 'element_never_appeared_in_retry_budget',
        diedStepIndex: 1,
        diedStepKind: 'interact',
        stepsSucceeded: 1,
        durationMs: 30_500,
        transport: 'json',
        timeToFirstProgressMs: 800,
        replans: 2,
        modelCalls: 3,
        model: 'claude-sonnet-5',
      }),
      row({
        occurredAt: at(20),
        outcome: 'failed',
        deathReason: 'element_never_appeared_in_retry_budget',
        diedStepIndex: 0,
        diedStepKind: 'interact',
        stepsSucceeded: 0,
        durationMs: 17_000,
      }),
      row({
        occurredAt: at(25),
        outcome: 'failed',
        deathReason: 'readback_gate_blocked',
        diedStepIndex: 2,
        diedStepKind: null,
        durationMs: 9100,
      }),
      row({
        occurredAt: at(30),
        outcome: 'stopped',
        deathReason: 'control_taken_mid_turn',
        customerStopped: true,
        viewerDisconnected: true,
        durationMs: 4000,
      }),
      row({
        occurredAt: at(35),
        outcome: 'halted_for_confirmation',
        deathReason: 'halted_for_confirmation',
        diedStepIndex: 1,
        diedStepKind: 'interact',
      }),
      row({
        occurredAt: at(40),
        outcome: 'busy_409',
        deathReason: 'turn_in_progress',
        httpStatus: 409,
        model: 'none',
        stepsPlanned: 0,
        stepsRun: 0,
        stepsSucceeded: 0,
        modelCalls: 0,
        durationMs: 25,
        timeToFirstProgressMs: null,
        planningMs: 0,
        startingBrowserMs: 0,
        executingMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostMillicents: 0,
      }),
      row({
        occurredAt: at(45),
        outcome: 'error',
        deathReason: 'turn_errored',
        httpStatus: 502,
        model: 'none',
        modelCalls: 0,
        durationMs: 60,
        timeToFirstProgressMs: null,
      }),
      // An error that had ALREADY called the model: a turn that ran, in both.
      row({
        occurredAt: at(50),
        outcome: 'error',
        deathReason: 'turn_errored',
        httpStatus: 500,
        modelCalls: 2,
        durationMs: 22_000,
        inputTokens: 7000,
        estimatedCostMillicents: 7777,
      }),
      row({
        occurredAt: at(55),
        outcome: 'rejected',
        deathReason: 'request_rejected',
        httpStatus: 404,
        model: 'none',
        modelCalls: 0,
        durationMs: 12,
        timeToFirstProgressMs: null,
      }),
      // Outside the window at each end: must be invisible to both.
      row({ occurredAt: new Date(AGENT_TURN_ROW_NOW - 25 * 3_600_000), durationMs: 999_999 }),
      row({ occurredAt: new Date(AGENT_TURN_ROW_NOW + 1000), durationMs: 999_999 }),
    ];
    const sqlRepo = repo();
    const memory = new InMemoryAgentTurnTelemetryRepo();
    for (const r of rows) {
      await sqlRepo.insert(r);
      await memory.insert(r);
    }
    const fromSql = await sqlRepo.aggregate(WINDOW);
    const fromMemory = await memory.aggregate(WINDOW);
    expect(fromSql).toEqual(fromMemory);
    // The health watchdog's path (one transaction, a local statement timeout)
    // reads the same numbers as the admin page's.
    expect(await sqlRepo.aggregate({ ...WINDOW, statementTimeoutMs: 30_000 })).toEqual(fromSql);
    // Not vacuous: the answer has content, and the out-of-window rows are out.
    // 7 ran outcomes + the error that had called the model; NOT the error that
    // had not, the 409 or the 404.
    expect(fromSql.ran.count).toBe(8);
    // The streaming first-progress SAMPLE COUNT (the health watchdog's volume
    // floor) counts streaming rows that reached progress — not json ones, not
    // a request that never showed progress.
    const inWindow = rows.filter(
      (r) => r.occurredAt >= WINDOW.since && r.occurredAt <= WINDOW.until,
    );
    const streamed = inWindow.filter(
      (r) => r.transport === 'stream' && r.timeToFirstProgressMs !== null,
    ).length;
    expect(streamed).toBeGreaterThan(0);
    expect(streamed).toBeLessThan(inWindow.length);
    expect(fromSql.firstProgressStreamSamples).toBe(streamed);
    expect(fromSql.ran.costMillicents).toBeGreaterThanOrEqual(7777);
    expect(fromSql.byOutcome).toEqual({
      completed: 2,
      failed: 3,
      stopped: 1,
      halted_for_confirmation: 1,
      busy_409: 1,
      error: 2,
      rejected: 1,
    });
    expect(fromSql.percentilesMs.turn.p95).toBeLessThan(999_999);
    expect(fromSql.deaths[0]).toEqual({
      reason: 'element_never_appeared_in_retry_budget',
      stepKind: 'interact',
      count: 2,
    });
    // Deaths are turns that died; the 409 and the 404 are listed apart, and the
    // confirmation halt is in neither.
    expect(fromSql.deaths.map((d) => d.reason)).not.toContain('turn_in_progress');
    expect(fromSql.deaths.map((d) => d.reason)).not.toContain('halted_for_confirmation');
    expect(fromSql.deaths.find((d) => d.reason === 'turn_errored')?.count).toBe(2);
    expect(fromSql.turnedAway).toEqual([
      { reason: 'request_rejected', stepKind: null, count: 1 },
      { reason: 'turn_in_progress', stepKind: null, count: 1 },
    ]);
    expect(fromSql.percentilesMs.afterTurn.p50).not.toBeNull();
    expect(fromSql.percentilesMs.afterTurn.p95).toBeGreaterThan(0);
  });

  it('an empty window aggregates to zeros and null percentiles, not to an error', async () => {
    const empty = await repo().aggregate(WINDOW);
    expect(empty).toEqual(await new InMemoryAgentTurnTelemetryRepo().aggregate(WINDOW));
    expect(empty.ran.count).toBe(0);
    expect(empty.percentilesMs.turn).toEqual({ p50: null, p95: null });
  });

  it('CRITICAL a statement timeout CANCELS the aggregate in Postgres, and stays local to its transaction', async () => {
    // A held ACCESS EXCLUSIVE lock makes every read of the table wait, which
    // is the "slow database" a background caller gives up on. The lock wait
    // counts against statement_timeout, so the read must be cancelled by
    // Postgres — not merely abandoned by the caller while it keeps its
    // connection.
    const holder = await client!.reserve();
    try {
      await holder`BEGIN`;
      await holder`LOCK TABLE agent_turn_telemetry IN ACCESS EXCLUSIVE MODE`;
      const started = Date.now();
      // Bounded here too, so a regression fails this assertion and the lock is
      // released below, rather than hanging the test with the lock held into
      // the next one.
      const err: unknown = await Promise.race([
        repo()
          .aggregate({ ...WINDOW, statementTimeoutMs: 200 })
          .then(
            () => null,
            (e: unknown) => e,
          ),
        new Promise((done) => setTimeout(() => done('still waiting after 3 s'), 3_000)),
      ]);
      // Drizzle wraps the driver error; the cause is Postgres's own
      // query_canceled (57014), raised by the statement timeout.
      const cause = (err as { cause?: { code?: string; message?: string } } | null)?.cause;
      expect(cause?.code).toBe('57014');
      expect(cause?.message).toMatch(/statement timeout/);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await holder`ROLLBACK`.catch(() => undefined);
      holder.release();
    }
    // A timed read that COMMITS (a cancelled one rolls back, which would undo
    // even a session-wide setting and prove nothing).
    expect((await repo().aggregate({ ...WINDOW, statementTimeoutMs: 200 })).ran.count).toBe(0);
    // SET LOCAL semantics: the connection went back to the pool without it.
    // Asked on every pooled connection at once (the pool holds 3), so the one
    // the transaction used is among them.
    const settings = await Promise.all(
      [0, 1, 2].map(
        () => client!`SELECT current_setting('statement_timeout') AS v, pg_sleep(0.05)`,
      ),
    );
    expect(settings.map((r) => String(r[0]?.['v']))).toEqual(['0', '0', '0']);
    expect((await repo().aggregate(WINDOW)).ran.count).toBe(0);
  });

  it('the prune deletes only rows older than the cutoff, the OLDEST first, and never more than the limit', async () => {
    const r = repo();
    const day = 24 * 3_600_000;
    for (const daysAgo of [200, 150, 120, 95, 10, 1]) {
      await r.insert(row({ occurredAt: new Date(AGENT_TURN_ROW_NOW - daysAgo * day) }));
    }
    const cutoff = new Date(AGENT_TURN_ROW_NOW - 90 * day);
    expect(await r.pruneOlderThan(cutoff, 3)).toBe(3);
    const left = await client!`
      SELECT (extract(epoch FROM occurred_at) * 1000)::float8 AS ms
        FROM agent_turn_telemetry ORDER BY occurred_at`;
    // 200, 150 and 120 went; 95 is still past the cutoff and waits for the next tick.
    expect(left.map((l) => Math.round((AGENT_TURN_ROW_NOW - Number(l['ms'])) / day))).toEqual([
      95, 10, 1,
    ]);
    expect(await r.pruneOlderThan(cutoff, 3)).toBe(1);
    expect(await r.pruneOlderThan(cutoff, 3)).toBe(0);
  });
});
