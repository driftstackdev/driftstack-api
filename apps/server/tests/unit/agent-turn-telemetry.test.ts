// Per-request AI telemetry: what it counts, what it refuses to keep, and what
// it must never be able to do to a turn.
//
// Three properties carry the weight here and each has its own block:
//
//   1. EVERY METRIC HAS AN ARM. A removed increment leaves a flat line that
//      reads exactly like "this never happens", so each of the nine series is
//      asserted by name and value after a turn that must have moved it.
//   2. CONTENT-FREE. The collector is handed the task's URLs, selectors, page
//      text and answer in order to classify; a turn built entirely out of
//      sentinels must leave a row, a metrics exposition and a log line in which
//      none of them appears.
//   3. HARMLESS. A writer that throws, a writer that never settles, a sink that
//      throws — none reaches the caller, and each is counted.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLAUDE_MODELS, type AgentIntent } from '@driftstack/api-types';
import type { AgentSessionRecord } from '../../src/services/agent-sessions.js';
import type { IntentResult } from '../../src/services/agent-executor.js';
import type { AgentTurnProgressEvent, RunTurnResult } from '../../src/services/agent-runtime.js';
import { z } from 'zod';
import { ConflictError } from '../../src/lib/errors.js';
import { METRIC_NAMES, MetricsRegistry } from '../../src/services/metrics-registry.js';
import {
  AGENT_TURN_DEATH_REASONS,
  AGENT_TURN_DURATION_BUCKETS_SECONDS,
  AGENT_TURN_FIRST_PROGRESS_BUCKETS_SECONDS,
  AGENT_TURN_MODEL_LABELS,
  AGENT_TURN_OUTCOMES,
  AGENT_TURN_REPLAN_BUCKETS,
  AGENT_TURN_STEP_KINDS,
  AGENT_TURN_TRANSPORTS,
  AGENT_TURN_TELEMETRY_WRITE_OUTCOMES,
  AgentTurnTelemetry,
  turnRan,
  classifyStepFailure,
  classifyTurn,
  estimateCostMillicents,
  modelLabel,
  readUsageTokens,
  type AgentTurnTelemetryRow,
  type AgentTurnTelemetryWriter,
} from '../../src/services/agent-turn-telemetry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP = resolve(HERE, '..', '..', 'src', 'lib', 'bootstrap.ts');

/** The label set each agent-turn series is emitted with. ONE table: it
 *  registers the test registry below AND is compared against bootstrap, so the
 *  production registration cannot drift from what the emitter sends. */
const SERIES: ReadonlyArray<{
  key: keyof typeof METRIC_NAMES;
  kind: 'Counter' | 'Histogram';
  labels: readonly string[];
  buckets?: readonly number[];
}> = [
  { key: 'agentTurnTotal', kind: 'Counter', labels: ['outcome'] },
  {
    key: 'agentTurnDurationSeconds',
    kind: 'Histogram',
    labels: ['outcome'],
    buckets: AGENT_TURN_DURATION_BUCKETS_SECONDS,
  },
  {
    key: 'agentTurnPhaseDurationSeconds',
    kind: 'Histogram',
    labels: ['phase'],
    buckets: AGENT_TURN_DURATION_BUCKETS_SECONDS,
  },
  {
    key: 'agentTurnTimeToFirstProgressSeconds',
    kind: 'Histogram',
    labels: ['transport'],
    buckets: AGENT_TURN_FIRST_PROGRESS_BUCKETS_SECONDS,
  },
  { key: 'agentTurnModelCallTotal', kind: 'Counter', labels: ['call_kind', 'model'] },
  { key: 'agentTurnTokensTotal', kind: 'Counter', labels: ['token_type', 'call_kind', 'model'] },
  {
    key: 'agentTurnReplans',
    kind: 'Histogram',
    labels: ['outcome'],
    buckets: AGENT_TURN_REPLAN_BUCKETS,
  },
  { key: 'agentTurnStepFailureTotal', kind: 'Counter', labels: ['reason', 'step_kind'] },
  { key: 'agentTurnTelemetryWriteTotal', kind: 'Counter', labels: ['outcome'] },
];

function newRegistry(): MetricsRegistry {
  const r = new MetricsRegistry();
  for (const s of SERIES) {
    if (s.kind === 'Counter') r.registerCounter(METRIC_NAMES[s.key], 'h', s.labels);
    else r.registerHistogram(METRIC_NAMES[s.key], 'h', s.buckets ?? [1], s.labels);
  }
  return r;
}

class CapturingWriter implements AgentTurnTelemetryWriter {
  rows: AgentTurnTelemetryRow[] = [];
  insert(row: AgentTurnTelemetryRow): Promise<void> {
    this.rows.push(row);
    return Promise.resolve();
  }
}

class Clock {
  t = 1000;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

const SESSION = { id: 'ags_1', status: 'active' } as unknown as AgentSessionRecord;

const NAVIGATE: AgentIntent = { kind: 'navigate', url: 'https://example.test/' };
const INTERACT = { kind: 'interact', action: 'click', selector: '#go' } as unknown as AgentIntent;
const CAPTURE = { kind: 'capture', format: 'text' } as unknown as AgentIntent;

const ok = (intent: AgentIntent): IntentResult => ({ kind: 'success', intent, summary: 'done' });
const failed = (
  intent: AgentIntent,
  category: NonNullable<Extract<IntentResult, { kind: 'failure' }>['diagnosis']>['category'],
  reason = 'it failed',
): IntentResult => ({
  kind: 'failure',
  intent,
  reason,
  diagnosis: { category, retryable: false },
});

const USAGE = {
  decomposerKind: 'claude' as const,
  anthropicInputTokens: 2000,
  anthropicOutputTokens: 400,
  model: 'claude-opus-5',
};

function planExecuted(
  results: IntentResult[],
  extra: Partial<Extract<RunTurnResult, { kind: 'plan-executed' }>> = {},
  executorExtra: Record<string, unknown> = {},
): RunTurnResult {
  return {
    kind: 'plan-executed',
    decomposer: { kind: 'plan', intents: results.map((r) => r.intent), tokensConsumed: 1 },
    executor: {
      results,
      ok: results.every((r) => r.kind === 'success'),
      ...executorExtra,
    },
    session: SESSION,
    ...extra,
  };
}

interface Harness {
  telemetry: AgentTurnTelemetry;
  metrics: MetricsRegistry;
  writer: CapturingWriter;
  clock: Clock;
}

function harness(writer: AgentTurnTelemetryWriter = new CapturingWriter()): Harness {
  const metrics = newRegistry();
  const clock = new Clock();
  const telemetry = new AgentTurnTelemetry({
    writer,
    metrics,
    nowMs: clock.now,
    wallClock: () => new Date('2026-09-18T00:00:00Z'),
  });
  return { telemetry, metrics, writer: writer as CapturingWriter, clock };
}

/** A two-step turn that plans, fails a click, re-plans, succeeds and answers. */
async function runRecoveredTurn(h: Harness): Promise<AgentTurnTelemetryRow> {
  const c = h.telemetry.begin({ agentSessionId: 'ags_1', transport: 'stream' });
  const recorder = h.telemetry.wrapUsageRecorder();
  const progress = (e: AgentTurnProgressEvent): void => c.recordProgress(e);
  const record = (): Promise<void> =>
    recorder.record({
      accountId: 'a',
      driftstackSessionId: null,
      agentSessionId: 'ags_1',
      decomposeResultKind: 'plan',
      usage: USAGE,
      tokensConsumed: 2400,
      now: new Date(),
    });

  h.clock.advance(300); // admission
  progress({ kind: 'phase', phase: 'planning' });
  h.clock.advance(4000);
  await record();
  progress({ kind: 'plan', intents: [NAVIGATE, INTERACT], total: 2 });
  progress({ kind: 'phase', phase: 'starting_browser' });
  h.clock.advance(1000);
  progress({ kind: 'phase', phase: 'executing' });
  h.clock.advance(6000);
  progress({ kind: 'phase', phase: 'reading_page' });
  h.clock.advance(500);
  progress({ kind: 'phase', phase: 'planning' });
  h.clock.advance(3000);
  await record();
  // The runtime's `total` is CUMULATIVE: the two steps already run plus the new
  // plan's two.
  progress({ kind: 'plan', intents: [INTERACT, CAPTURE], total: 4 });
  progress({ kind: 'phase', phase: 'executing' });
  h.clock.advance(2000);
  progress({ kind: 'phase', phase: 'reading_page' });
  h.clock.advance(500);
  progress({ kind: 'phase', phase: 'answering' });
  h.clock.advance(2500);
  await record();
  progress({ kind: 'answer', answer: 'the answer' });

  c.observeResult(
    planExecuted(
      [ok(NAVIGATE), failed(INTERACT, 'element_not_found'), ok(INTERACT), ok(CAPTURE)],
      { answer: 'the answer' },
      { ok: true, recoveredAfterReplan: true },
    ),
  );
  // What the route does after the runtime returns: transcript, debit, receipt.
  h.clock.advance(700);
  c.finish({ status: 200, body: { kind: 'plan-executed' } });
  await h.telemetry.flush();
  const row = h.writer.rows.at(-1);
  if (row === undefined) throw new Error('no row written');
  return row;
}

describe('agent turn telemetry — the row', () => {
  it('records a recovered turn: outcome, counts, phase times, tokens, model, cost', async () => {
    const h = harness();
    const row = await runRecoveredTurn(h);
    expect(row).toEqual({
      occurredAt: new Date('2026-09-18T00:00:00Z'),
      outcome: 'completed',
      deathReason: 'none',
      diedStepIndex: null,
      diedStepKind: null,
      httpStatus: 200,
      transport: 'stream',
      model: 'claude-opus-5',
      stepsPlanned: 4,
      stepsRun: 4,
      stepsSucceeded: 3,
      replans: 1,
      modelCalls: 3,
      recoveredAfterReplan: true,
      // 300 admission + 19,500 of phases + 700 after the runtime returned. The
      // phases END when the runtime returns: the 700 is storage work, and
      // folding it into `answering` would make a slow database read as a slow
      // model. It stays recoverable as duration − first progress − phases.
      durationMs: 20_500,
      timeToFirstProgressMs: 300,
      planningMs: 7000,
      startingBrowserMs: 1000,
      executingMs: 8000,
      readingPageMs: 1000,
      answeringMs: 2500,
      inputTokens: 6000,
      outputTokens: 1200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      // Three calls at the catalogue's list rate. Derived, not typed in: the
      // rate card is owned elsewhere and re-priced on its own schedule.
      estimatedCostMillicents:
        3 *
        Math.round(
          2000 * CLAUDE_MODELS['claude-opus-5'].inputCentsPer1k +
            400 * CLAUDE_MODELS['claude-opus-5'].outputCentsPer1k,
        ),
      customerStopped: false,
      viewerDisconnected: false,
    });
  });

  it('finish is idempotent: a second call writes no second row and counts no second turn', async () => {
    const h = harness();
    const c = h.telemetry.begin({ agentSessionId: 's', transport: 'json' });
    c.finish({ status: 409, body: { turn_in_progress: true } });
    c.finish({ status: 200, body: {} });
    c.finishWithError(new Error('late'));
    await h.telemetry.flush();
    expect(h.writer.rows).toHaveLength(1);
    expect(h.writer.rows[0]?.outcome).toBe('busy_409');
    expect(h.metrics.getValue(METRIC_NAMES.agentTurnTotal, { outcome: 'busy_409' })).toBe(1);
  });

  it('a replay and a manual note are counted and NOT persisted', async () => {
    const h = harness();
    const replay = h.telemetry.begin({ agentSessionId: 's', transport: 'json' });
    replay.markReplay();
    replay.finish({ status: 200, body: { kind: 'plan-executed', ok: true } });
    const manual = h.telemetry.begin({ agentSessionId: 's2', transport: 'json' });
    manual.observeResult({ kind: 'logged-manual', session: SESSION });
    manual.finish({ status: 200, body: { kind: 'logged-manual' } });
    await h.telemetry.flush();
    expect(h.writer.rows).toEqual([]);
    expect(h.metrics.getValue(METRIC_NAMES.agentTurnTotal, { outcome: 'replayed' })).toBe(1);
    expect(h.metrics.getValue(METRIC_NAMES.agentTurnTotal, { outcome: 'manual_note' })).toBe(1);
    expect(h.metrics.getValue(METRIC_NAMES.agentTurnTelemetryWriteTotal, { outcome: 'ok' })).toBe(
      0,
    );
  });

  it('forgets every finished request, so the active map cannot grow with traffic', async () => {
    const h = harness();
    for (let i = 0; i < 50; i += 1) {
      const c = h.telemetry.begin({ agentSessionId: `s${i.toString()}`, transport: 'json' });
      expect(h.telemetry.activeCount()).toBe(1);
      c.finish({ status: 200, body: {} });
    }
    expect(h.telemetry.activeCount()).toBe(0);
    await h.telemetry.flush();
  });
});

describe('agent turn telemetry — every metric has an arm', () => {
  it('turn total + duration, by outcome', async () => {
    const h = harness();
    await runRecoveredTurn(h);
    expect(h.metrics.getValue(METRIC_NAMES.agentTurnTotal, { outcome: 'completed' })).toBe(1);
    const duration = h.metrics.getHistogram(METRIC_NAMES.agentTurnDurationSeconds, {
      outcome: 'completed',
    });
    expect(duration.count).toBe(1);
    expect(duration.sum).toBeCloseTo(20.5, 6);
  });

  it('phase duration, by phase — and a phase the turn never entered is ABSENT, not a zero', async () => {
    const h = harness();
    await runRecoveredTurn(h);
    const phase = (p: string): { count: number; sum: number } =>
      h.metrics.getHistogram(METRIC_NAMES.agentTurnPhaseDurationSeconds, { phase: p });
    expect(phase('planning')).toMatchObject({ count: 1, sum: 7 });
    expect(phase('starting_browser')).toMatchObject({ count: 1, sum: 1 });
    expect(phase('executing')).toMatchObject({ count: 1, sum: 8 });
    expect(phase('reading_page')).toMatchObject({ count: 1, sum: 1 });
    expect(phase('answering')).toMatchObject({ count: 1, sum: 2.5 });

    const h2 = harness();
    const c = h2.telemetry.begin({ agentSessionId: 's', transport: 'json' });
    c.finish({ status: 409, body: { turn_in_progress: true } });
    await h2.telemetry.flush();
    expect(
      h2.metrics.getHistogram(METRIC_NAMES.agentTurnPhaseDurationSeconds, { phase: 'planning' })
        .count,
    ).toBe(0);
  });

  it('time to first progress, by transport — and none when the turn never progressed', async () => {
    const h = harness();
    await runRecoveredTurn(h);
    const first = h.metrics.getHistogram(METRIC_NAMES.agentTurnTimeToFirstProgressSeconds, {
      transport: 'stream',
    });
    expect(first.count).toBe(1);
    expect(first.sum).toBeCloseTo(0.3, 6);
    expect(
      h.metrics.getHistogram(METRIC_NAMES.agentTurnTimeToFirstProgressSeconds, {
        transport: 'json',
      }).count,
    ).toBe(0);
  });

  it('model calls by kind: the first planning is a plan, a return to planning is a re-plan, answering is an answer', async () => {
    const h = harness();
    await runRecoveredTurn(h);
    const calls = (kind: string): number =>
      h.metrics.getValue(METRIC_NAMES.agentTurnModelCallTotal, {
        call_kind: kind,
        model: 'claude-opus-5',
      });
    expect(calls('plan')).toBe(1);
    expect(calls('re_plan')).toBe(1);
    expect(calls('answer')).toBe(1);
    expect(calls('unattributed')).toBe(0);
  });

  it('tokens by type, call kind and model', async () => {
    const h = harness();
    await runRecoveredTurn(h);
    const tokens = (type: string, kind: string): number =>
      h.metrics.getValue(METRIC_NAMES.agentTurnTokensTotal, {
        token_type: type,
        call_kind: kind,
        model: 'claude-opus-5',
      });
    expect(tokens('input', 'plan')).toBe(2000);
    expect(tokens('output', 'plan')).toBe(400);
    expect(tokens('input', 're_plan')).toBe(2000);
    expect(tokens('output', 'answer')).toBe(400);
    expect(tokens('cache_read', 'plan')).toBe(0);
  });

  it('re-plans per turn, by outcome, for turns that ran — and not for a request that never ran', async () => {
    const h = harness();
    await runRecoveredTurn(h);
    const replans = h.metrics.getHistogram(METRIC_NAMES.agentTurnReplans, {
      outcome: 'completed',
    });
    expect(replans.count).toBe(1);
    expect(replans.sum).toBe(1);
    // Buckets [0, 1, 2, 3]: one re-plan is above le=0 and inside le=1.
    expect(replans.cumulative).toEqual([0, 1, 1, 1]);

    const c = h.telemetry.begin({ agentSessionId: 's9', transport: 'json' });
    c.finish({ status: 409, body: { turn_in_progress: true } });
    await h.telemetry.flush();
    expect(
      h.metrics.getHistogram(METRIC_NAMES.agentTurnReplans, { outcome: 'busy_409' }).count,
    ).toBe(0);
  });

  it('step failures by reason and step kind — a RECOVERED failure counts too', async () => {
    const h = harness();
    await runRecoveredTurn(h);
    expect(
      h.metrics.getValue(METRIC_NAMES.agentTurnStepFailureTotal, {
        reason: 'element_never_appeared_in_retry_budget',
        step_kind: 'interact',
      }),
    ).toBe(1);
  });

  it('a death that is not on a step is counted with step_kind none', async () => {
    const h = harness();
    const c = h.telemetry.begin({ agentSessionId: 's', transport: 'json' });
    c.observeResult(planExecuted([ok(NAVIGATE)], { readbackUnavailable: 'could not read it' }));
    c.finish({ status: 200, body: {} });
    await h.telemetry.flush();
    expect(
      h.metrics.getValue(METRIC_NAMES.agentTurnStepFailureTotal, {
        reason: 'readback_gate_blocked',
        step_kind: 'none',
      }),
    ).toBe(1);
  });

  it('telemetry writes: ok', async () => {
    const h = harness();
    await runRecoveredTurn(h);
    expect(h.metrics.getValue(METRIC_NAMES.agentTurnTelemetryWriteTotal, { outcome: 'ok' })).toBe(
      1,
    );
  });

  it('bootstrap registers every agent-turn series with EXACTLY the labels the emitter sends. A missing label key is not an error at emit time — the registry just drops the value, and every model collapses into one series.', () => {
    const src = readFileSync(BOOTSTRAP, 'utf8');
    for (const s of SERIES) {
      const match = new RegExp(
        `register${s.kind}\\(\\s*METRIC_NAMES\\.${s.key},[\\s\\S]*?\\[([^\\]]*)\\],?\\s*\\);`,
      ).exec(src);
      expect(match, `bootstrap must register ${s.key} as a ${s.kind}`).not.toBeNull();
      const labels = [...(match?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
      expect(labels, `label keys of ${s.key}`).toEqual([...s.labels]);
    }
  });
});

describe('agent turn telemetry — classification', () => {
  const classify = (
    result: RunTurnResult | undefined,
    status = 200,
    body: unknown = {},
    saw: { planning?: boolean; answering?: boolean } = { planning: true },
  ): ReturnType<typeof classifyTurn> =>
    classifyTurn({
      result,
      status,
      body,
      sawPlanning: saw.planning === true,
      sawAnswering: saw.answering === true,
    });

  it('a failed plan dies on the LAST non-success step, not on an earlier recovered one', () => {
    const verdict = classify(
      planExecuted([
        ok(NAVIGATE),
        failed(INTERACT, 'element_not_found'),
        ok(INTERACT),
        failed(CAPTURE, 'capture_failed'),
      ]),
    );
    expect(verdict).toMatchObject({
      outcome: 'failed',
      deathReason: 'capture_failed',
      diedStepIndex: 3,
      diedStepKind: 'capture',
    });
  });

  it('halted for confirmation names the gated step', () => {
    const halted: IntentResult = {
      kind: 'confirmation_required',
      intent: INTERACT,
      category: 'purchase',
      matchedText: 'Buy now',
    };
    expect(
      classify(planExecuted([ok(NAVIGATE), halted], {}, { awaitingConfirmation: true })),
    ).toMatchObject({
      outcome: 'halted_for_confirmation',
      deathReason: 'halted_for_confirmation',
      diedStepIndex: 1,
      diedStepKind: 'interact',
    });
  });

  it('an unanswered question splits on whether the answer call was ever REACHED', () => {
    const turn = planExecuted([ok(NAVIGATE)], { readbackUnavailable: 'no' });
    expect(classify(turn, 200, {}, { planning: true }).deathReason).toBe('readback_gate_blocked');
    expect(classify(turn, 200, {}, { planning: true, answering: true }).deathReason).toBe(
      'answer_path_failed_after_being_reached',
    );
  });

  it('three different refusals', () => {
    const refuse = (usage?: typeof USAGE): RunTurnResult => ({
      kind: 'refuse',
      decomposer: {
        kind: 'refuse',
        refuseReason: 'no',
        tokensConsumed: 0,
        ...(usage !== undefined ? { usage } : {}),
      },
      session: SESSION,
    });
    expect(classify(refuse(), 200, {}, {}).deathReason).toBe('policy_refused');
    expect(classify(refuse(), 200, {}, { planning: true }).deathReason).toBe('model_unavailable');
    expect(classify(refuse(USAGE), 200, {}, { planning: true }).deathReason).toBe('model_refused');
  });

  it('a session that closed: the customer closing it is a STOP; a closed-reason string is never kept', () => {
    const closed = (reason: string, worked: boolean): RunTurnResult => ({
      kind: 'session-closed',
      reason,
      session: SESSION,
      ...(worked ? { tokensConsumed: 5 } : {}),
    });
    expect(classify(closed('customer-closed', true), 409)).toMatchObject({
      outcome: 'stopped',
      deathReason: 'customer_closed_session',
      customerStopped: true,
    });
    expect(classify(closed('budget-exhausted', true), 409)).toMatchObject({
      outcome: 'failed',
      deathReason: 'budget_exhausted',
    });
    expect(classify(closed('transcript-limit', false), 409)).toMatchObject({
      outcome: 'conflict_409',
      deathReason: 'transcript_limit',
    });
    expect(classify(closed('anything else at all', false), 409)).toMatchObject({
      outcome: 'conflict_409',
      deathReason: 'session_not_active',
    });
  });

  it('losing control at admission is a conflict; losing it mid-turn is the customer stopping the AI', () => {
    const lost = (phase: 'admission' | 'execution'): RunTurnResult => ({
      kind: 'ai-control-unavailable',
      phase,
      session: SESSION,
    });
    expect(classify(lost('admission'), 409)).toMatchObject({
      outcome: 'conflict_409',
      deathReason: 'control_unavailable',
      customerStopped: false,
    });
    expect(classify(lost('execution'), 409)).toMatchObject({
      outcome: 'stopped',
      deathReason: 'control_taken_mid_turn',
      customerStopped: true,
    });
  });

  it('with no turn result, the 409 flavours are told apart by their typed extensions', () => {
    expect(classify(undefined, 409, { turn_in_progress: true }).deathReason).toBe(
      'turn_in_progress',
    );
    expect(classify(undefined, 409, { idempotency_status: 'in_progress' })).toMatchObject({
      outcome: 'busy_409',
      deathReason: 'idempotency_in_progress',
    });
    expect(classify(undefined, 409, { idempotency_status: 'mismatch' })).toMatchObject({
      outcome: 'conflict_409',
      deathReason: 'idempotency_mismatch',
    });
    expect(classify(undefined, 409, { ai_control_unavailable: true }).deathReason).toBe(
      'control_unavailable',
    );
    expect(classify(undefined, 409, {}).deathReason).toBe('session_not_active');
    expect(classify(undefined, 429, {}).outcome).toBe('rate_limited');
    expect(classify(undefined, 404, {}).outcome).toBe('rejected');
    expect(classify(undefined, 502, {})).toMatchObject({
      outcome: 'error',
      deathReason: 'turn_errored',
    });
  });

  it('a 5xx is the outcome even when the turn behind it succeeded — the customer got an error', () => {
    expect(classify(planExecuted([ok(NAVIGATE)]), 500).outcome).toBe('error');
  });

  it('busy and limit results', () => {
    expect(classify({ kind: 'turn-in-progress', session: SESSION }, 409).outcome).toBe('busy_409');
    expect(
      classify({ kind: 'account-turn-limit', current: 3, limit: 3, session: SESSION }, 429),
    ).toMatchObject({ outcome: 'rate_limited', deathReason: 'account_turn_limit' });
  });

  it('step failures map from the public diagnosis category; the prose is read for one phrase and never kept', () => {
    const f = (
      intent: AgentIntent,
      category: Parameters<typeof failed>[1],
      reason?: string,
    ): Extract<IntentResult, { kind: 'failure' }> =>
      failed(intent, category, reason) as Extract<IntentResult, { kind: 'failure' }>;
    expect(classifyStepFailure(f(NAVIGATE, 'page_load_failed'))).toBe('page_load_failed');
    expect(classifyStepFailure(f(INTERACT, 'condition_not_met'))).toBe('wait_condition_not_met');
    expect(classifyStepFailure(f(INTERACT, 'invalid_request'))).toBe('invalid_parameter');
    expect(classifyStepFailure(f(CAPTURE, 'result_too_large'))).toBe('result_too_large');
    expect(classifyStepFailure(f(NAVIGATE, 'session_error'))).toBe('session_error');
    expect(classifyStepFailure(f(INTERACT, 'unknown'))).toBe('element_click_intercepted');
    expect(classifyStepFailure(f(INTERACT, 'unknown', 'the button never became visible'))).toBe(
      'element_never_appeared_in_retry_budget',
    );
    expect(
      classifyStepFailure(f(INTERACT, 'unknown', 'outcome unknown: element not interactable')),
    ).toBe('element_not_interactable');
    expect(classifyStepFailure(f(NAVIGATE, 'unknown'))).toBe('harness_error_unclassified');
    const undiagnosed: Extract<IntentResult, { kind: 'failure' }> = {
      kind: 'failure',
      intent: NAVIGATE,
      reason: 'x',
    };
    expect(classifyStepFailure(undiagnosed)).toBe('harness_error_unclassified');
  });
});

describe('agent turn telemetry — usage, read defensively', () => {
  it('reads cache tokens under any of the names the usage object may grow, and ignores junk', () => {
    expect(
      readUsageTokens({
        anthropicInputTokens: 10,
        anthropicOutputTokens: 5,
        anthropicCacheReadInputTokens: 900,
        anthropicCacheCreationInputTokens: 100,
      }),
    ).toEqual({ input: 10, output: 5, cacheRead: 900, cacheWrite: 100, cacheWrite1h: 0 });
    expect(readUsageTokens({ cacheReadInputTokens: 7, cacheCreationInputTokens: 3 })).toEqual({
      input: 0,
      output: 0,
      cacheRead: 7,
      cacheWrite: 3,
      cacheWrite1h: 0,
    });
    expect(
      readUsageTokens({
        anthropicInputTokens: 'lots',
        anthropicOutputTokens: -4,
        cacheReadTokens: Number.NaN,
      }),
    ).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
    expect(readUsageTokens(null)).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
    });
  });

  it('cache tokens reach the row, the counter and the cost estimate', async () => {
    const h = harness();
    const c = h.telemetry.begin({ agentSessionId: 's', transport: 'json' });
    c.recordProgress({ kind: 'phase', phase: 'planning' });
    h.telemetry.observeModelCall({
      agentSessionId: 's',
      usage: {
        model: 'claude-sonnet-5',
        anthropicInputTokens: 1000,
        anthropicOutputTokens: 0,
        anthropicCacheReadInputTokens: 10_000,
        anthropicCacheCreationInputTokens: 2000,
      },
    });
    c.observeResult(planExecuted([ok(NAVIGATE)]));
    c.finish({ status: 200, body: {} });
    await h.telemetry.flush();
    expect(h.writer.rows[0]).toMatchObject({
      cacheReadTokens: 10_000,
      cacheWriteTokens: 2000,
      // input at 1×, cache reads at a tenth, cache writes at one and a quarter.
      estimatedCostMillicents: Math.round(
        CLAUDE_MODELS['claude-sonnet-5'].inputCentsPer1k * (1000 + 10_000 * 0.1 + 2000 * 1.25),
      ),
    });
    expect(
      h.metrics.getValue(METRIC_NAMES.agentTurnTokensTotal, {
        token_type: 'cache_read',
        call_kind: 'plan',
        model: 'claude-sonnet-5',
      }),
    ).toBe(10_000);
    expect(
      h.metrics.getValue(METRIC_NAMES.agentTurnTokensTotal, {
        token_type: 'cache_write',
        call_kind: 'plan',
        model: 'claude-sonnet-5',
      }),
    ).toBe(2000);
  });

  it('the model label is CLOSED: anything outside the catalogue is `other`, and costs nothing rather than somebody else’s rate', () => {
    expect(modelLabel('claude-opus-5')).toBe('claude-opus-5');
    expect(modelLabel('https://evil.test/?q=a model-written string')).toBe('other');
    expect(modelLabel('')).toBe('none');
    expect(modelLabel(undefined)).toBe('none');
    expect(
      estimateCostMillicents('other', {
        input: 1e6,
        output: 1e6,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
      }),
    ).toBe(0);
  });

  it('a model call with no open request is still counted, as unattributed', () => {
    const h = harness();
    h.telemetry.observeModelCall({ agentSessionId: 'nobody', usage: USAGE });
    expect(
      h.metrics.getValue(METRIC_NAMES.agentTurnModelCallTotal, {
        call_kind: 'unattributed',
        model: 'claude-opus-5',
      }),
    ).toBe(1);
  });

  it('two requests open on one session: the call is credited to the one the runtime is talking to, not the one about to be told 409', async () => {
    const h = harness();
    // The bounced request is opened FIRST: arrival order must not decide who is
    // credited, only which request the runtime is actually talking to.
    const bounced = h.telemetry.begin({ agentSessionId: 's', transport: 'json' });
    const running = h.telemetry.begin({ agentSessionId: 's', transport: 'stream' });
    running.recordProgress({ kind: 'phase', phase: 'planning' });
    h.telemetry.observeModelCall({ agentSessionId: 's', usage: USAGE });
    bounced.finish({ status: 409, body: { turn_in_progress: true } });
    running.observeResult(planExecuted([ok(NAVIGATE)]));
    running.finish({ status: 200, body: {} });
    await h.telemetry.flush();
    const byOutcome = new Map(h.writer.rows.map((r) => [r.outcome, r]));
    expect(byOutcome.get('busy_409')?.inputTokens).toBe(0);
    expect(byOutcome.get('completed')?.inputTokens).toBe(2000);
  });

  it('the wrapped recorder calls the inner one with the same arguments and surfaces its failure unchanged', async () => {
    const h = harness();
    const seen: unknown[] = [];
    const wrapped = h.telemetry.wrapUsageRecorder({
      record: (args) => {
        seen.push(args);
        return Promise.reject(new Error('meter down'));
      },
    });
    const args = {
      accountId: 'a',
      driftstackSessionId: null,
      agentSessionId: 's',
      decomposeResultKind: 'plan' as const,
      usage: USAGE,
      tokensConsumed: 1,
      now: new Date(),
    };
    await expect(wrapped.record(args)).rejects.toThrow('meter down');
    expect(seen).toEqual([args]);
  });
});

describe('agent turn telemetry — content-free by construction', () => {
  const SENTINELS = {
    url: 'https://sentinel-url.example/SENTINEL_URL_7f3a?token=SENTINEL_QUERY',
    selector: '#SENTINEL_SELECTOR_19c',
    summary: 'SENTINEL_PAGE_TEXT the page said this',
    reason: 'SENTINEL_FAILURE_PROSE could not find it',
    answer: 'SENTINEL_ANSWER 203.0.113.9',
    closed: 'SENTINEL_CLOSED_REASON',
    model: 'SENTINEL_MODEL',
    detail: 'SENTINEL_PROBLEM_DETAIL',
    session: 'ags_SENTINEL_SESSION',
    matched: 'SENTINEL_MATCHED_TEXT',
  };
  const ALL = Object.values(SENTINELS);

  const sentinelIntent = {
    kind: 'interact',
    action: 'type',
    selector: SENTINELS.selector,
    text: SENTINELS.answer,
  } as unknown as AgentIntent;
  const sentinelNav: AgentIntent = { kind: 'navigate', url: SENTINELS.url };

  function sentinelTurns(): Array<{ result: RunTurnResult; status: number; body: unknown }> {
    const body = { detail: SENTINELS.detail, title: SENTINELS.detail, answer: SENTINELS.answer };
    return [
      {
        status: 200,
        body,
        result: planExecuted(
          [
            { kind: 'success', intent: sentinelNav, summary: SENTINELS.summary },
            { kind: 'failure', intent: sentinelIntent, reason: SENTINELS.reason },
          ],
          { answer: SENTINELS.answer },
        ),
      },
      {
        status: 200,
        body,
        result: planExecuted(
          [
            {
              kind: 'confirmation_required',
              intent: sentinelIntent,
              category: 'purchase',
              matchedText: SENTINELS.matched,
            },
          ],
          {},
          { awaitingConfirmation: true },
        ),
      },
      {
        status: 200,
        body,
        result: planExecuted(
          [{ kind: 'success', intent: sentinelNav, summary: SENTINELS.summary }],
          {
            readbackUnavailable: SENTINELS.reason,
          },
        ),
      },
      {
        status: 200,
        body,
        result: {
          kind: 'refuse',
          decomposer: { kind: 'refuse', refuseReason: SENTINELS.reason, tokensConsumed: 0 },
          session: SESSION,
        },
      },
      {
        status: 200,
        body,
        result: {
          kind: 'clarify',
          decomposer: {
            kind: 'clarify',
            clarifyingQuestion: SENTINELS.reason,
            tokensConsumed: 0,
          },
          session: SESSION,
        },
      },
      {
        status: 409,
        body,
        result: { kind: 'session-closed', reason: SENTINELS.closed, session: SESSION },
      },
    ];
  }

  it('CRITICAL a turn made entirely of sentinels leaves none of them in the row, and every string on the row is a member of a closed union', async () => {
    const h = harness();
    for (const turn of sentinelTurns()) {
      const c = h.telemetry.begin({ agentSessionId: SENTINELS.session, transport: 'stream' });
      const progress = (e: AgentTurnProgressEvent): void => c.recordProgress(e);
      progress({ kind: 'phase', phase: 'planning' });
      h.telemetry.observeModelCall({
        agentSessionId: SENTINELS.session,
        usage: { ...USAGE, model: SENTINELS.model },
      });
      progress({ kind: 'plan', intents: [sentinelNav, sentinelIntent], total: 2 });
      progress({ kind: 'answer', answer: SENTINELS.answer });
      c.observeResult(turn.result);
      c.finish(turn);
    }
    await h.telemetry.flush();
    expect(h.writer.rows).toHaveLength(sentinelTurns().length);

    const allowed = new Set<string>([
      ...AGENT_TURN_OUTCOMES,
      ...AGENT_TURN_DEATH_REASONS,
      ...AGENT_TURN_STEP_KINDS,
      ...AGENT_TURN_TRANSPORTS,
      ...AGENT_TURN_MODEL_LABELS,
    ]);
    for (const row of h.writer.rows) {
      const serialised = JSON.stringify(row);
      for (const sentinel of ALL) {
        expect(serialised.includes(sentinel), `row leaked ${sentinel}: ${serialised}`).toBe(false);
      }
      expect(serialised).not.toContain('SENTINEL');
      for (const [column, value] of Object.entries(row)) {
        if (typeof value !== 'string') continue;
        expect(allowed.has(value), `${column}=${value} is not a closed-union member`).toBe(true);
      }
    }
  });

  it('CRITICAL none of them reaches the metrics exposition either — no label is ever a session, a URL, a selector or model-written text', async () => {
    const h = harness();
    for (const turn of sentinelTurns()) {
      const c = h.telemetry.begin({ agentSessionId: SENTINELS.session, transport: 'stream' });
      c.recordProgress({ kind: 'phase', phase: 'planning' });
      h.telemetry.observeModelCall({
        agentSessionId: SENTINELS.session,
        usage: { ...USAGE, model: SENTINELS.model },
      });
      c.observeResult(turn.result);
      c.finish(turn);
    }
    await h.telemetry.flush();
    const exposition = h.metrics.render();
    expect(exposition).toContain('driftstack_agent_turn_total');
    expect(exposition).not.toContain('SENTINEL');
  });

  it('CRITICAL a failed write logs the error CLASS, never its message — a database error quotes the value it choked on', async () => {
    const logged: unknown[] = [];
    const metrics = newRegistry();
    const telemetry = new AgentTurnTelemetry({
      metrics,
      writer: {
        insert: () => Promise.reject(new Error(`invalid input: ${SENTINELS.url}`)),
      },
      logger: { warn: (obj, msg) => logged.push([obj, msg]) },
    });
    const c = telemetry.begin({ agentSessionId: SENTINELS.session, transport: 'json' });
    c.finish({ status: 200, body: {} });
    await telemetry.flush();
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged)).not.toContain('SENTINEL');
    expect(JSON.stringify(logged)).toContain('"err":"Error"');
  });
});

describe('agent turn telemetry — it can never reach the turn', () => {
  it('a writer that throws is swallowed and counted as an error', async () => {
    const h = harness({ insert: () => Promise.reject(new Error('db down')) });
    const c = h.telemetry.begin({ agentSessionId: 's', transport: 'json' });
    expect(() => c.finish({ status: 200, body: {} })).not.toThrow();
    await h.telemetry.flush();
    expect(
      h.metrics.getValue(METRIC_NAMES.agentTurnTelemetryWriteTotal, { outcome: 'error' }),
    ).toBe(1);
    // The turn itself was still counted: losing the row must not lose the metric.
    expect(h.metrics.getValue(METRIC_NAMES.agentTurnTotal, { outcome: 'completed' })).toBe(1);
  });

  it('a writer that throws SYNCHRONOUSLY is swallowed and counted the same way', async () => {
    const h = harness({
      insert: () => {
        throw new Error('sync boom');
      },
    });
    const c = h.telemetry.begin({ agentSessionId: 's', transport: 'json' });
    expect(() => c.finish({ status: 200, body: {} })).not.toThrow();
    await h.telemetry.flush();
    expect(
      h.metrics.getValue(METRIC_NAMES.agentTurnTelemetryWriteTotal, { outcome: 'error' }),
    ).toBe(1);
  });

  it('a database that stops answering costs DROPPED rows, not an unbounded queue', async () => {
    const release: Array<() => void> = [];
    const metrics = newRegistry();
    const telemetry = new AgentTurnTelemetry({
      metrics,
      maxPendingWrites: 2,
      writer: { insert: () => new Promise<void>((resolve) => release.push(resolve)) },
    });
    for (let i = 0; i < 5; i += 1) {
      telemetry.begin({ agentSessionId: `s${i.toString()}`, transport: 'json' }).finish({
        status: 200,
        body: {},
      });
    }
    // Let every deferred task reach the writer.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(release).toHaveLength(2);
    expect(
      metrics.getValue(METRIC_NAMES.agentTurnTelemetryWriteTotal, { outcome: 'dropped' }),
    ).toBe(3);
    for (const r of release) r();
    await telemetry.flush();
    expect(metrics.getValue(METRIC_NAMES.agentTurnTelemetryWriteTotal, { outcome: 'ok' })).toBe(2);
  });

  it('finish returns before the row is written: the write is off the response path', async () => {
    const h = harness();
    const c = h.telemetry.begin({ agentSessionId: 's', transport: 'json' });
    c.finish({ status: 200, body: {} });
    // Not even a microtask later. The work is deferred past the current TICK
    // (setImmediate), so it cannot run ahead of the reply's own I/O the way a
    // `.then()` continuation would.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(h.writer.rows).toHaveLength(0);
    expect(h.metrics.getValue(METRIC_NAMES.agentTurnTotal, { outcome: 'completed' })).toBe(0);
    await h.telemetry.flush();
    expect(h.writer.rows).toHaveLength(1);
  });

  it('recording a progress event never throws, whatever it is handed', () => {
    const h = harness();
    const c = h.telemetry.begin({ agentSessionId: 's', transport: 'stream' });
    const hostile = [undefined, null, 7, {}, { kind: 'phase' }, { kind: 'plan', total: 'many' }];
    for (const event of hostile) {
      expect(() => c.recordProgress(event as unknown as AgentTurnProgressEvent)).not.toThrow();
    }
  });

  it('works with nothing wired at all', async () => {
    const telemetry = new AgentTurnTelemetry();
    const c = telemetry.begin({ agentSessionId: 's', transport: 'json' });
    c.recordProgress({ kind: 'phase', phase: 'planning' });
    telemetry.observeModelCall({ agentSessionId: 's', usage: USAGE });
    expect(() => c.finish({ status: 200, body: {} })).not.toThrow();
    await telemetry.flush();
  });

  it('an unregistered metric cannot turn a swallowed failure into a thrown one', async () => {
    const telemetry = new AgentTurnTelemetry({
      metrics: new MetricsRegistry(),
      writer: { insert: () => Promise.reject(new Error('x')) },
    });
    const c = telemetry.begin({ agentSessionId: 's', transport: 'json' });
    expect(() => telemetry.observeModelCall({ agentSessionId: 's', usage: USAGE })).not.toThrow();
    expect(() => c.finish({ status: 200, body: {} })).not.toThrow();
    await expect(telemetry.flush()).resolves.toBeUndefined();
  });
});

describe('agent turn telemetry — one model call is one observation', () => {
  const recordArgs = (recordId?: string) => ({
    accountId: 'a',
    driftstackSessionId: null,
    agentSessionId: 's',
    decomposeResultKind: 'plan' as const,
    usage: { ...USAGE, anthropicInputTokens: 1000, anthropicOutputTokens: 100 },
    tokensConsumed: 1100,
    now: new Date(),
    ...(recordId === undefined ? {} : { recordId }),
  });

  it('CRITICAL a usage write the runtime RETRIES is one call, not three. The runtime re-invokes record() up to three times with ONE recordId when the meter write fails; counting every attempt tripled calls, tokens and cost — only while the database was flaky, which is when these numbers get read.', async () => {
    const h = harness();
    const c = h.telemetry.begin({ agentSessionId: 's', transport: 'json' });
    c.recordProgress({ kind: 'phase', phase: 'planning' });
    let attempts = 0;
    const wrapped = h.telemetry.wrapUsageRecorder({
      record: () => {
        attempts += 1;
        return attempts < 3 ? Promise.reject(new Error('meter blip')) : Promise.resolve();
      },
    });
    const args = recordArgs('rec-one');
    await expect(wrapped.record(args)).rejects.toThrow('meter blip');
    await expect(wrapped.record(args)).rejects.toThrow('meter blip');
    await expect(wrapped.record(args)).resolves.toBeUndefined();
    // The inner recorder still saw all three attempts: billing is untouched.
    expect(attempts).toBe(3);
    c.observeResult(planExecuted([ok(NAVIGATE)]));
    c.finish({ status: 200, body: {} });
    await h.telemetry.flush();
    expect(
      h.metrics.getValue(METRIC_NAMES.agentTurnModelCallTotal, {
        call_kind: 'plan',
        model: 'claude-opus-5',
      }),
    ).toBe(1);
    expect(
      h.metrics.getValue(METRIC_NAMES.agentTurnTokensTotal, {
        token_type: 'input',
        call_kind: 'plan',
        model: 'claude-opus-5',
      }),
    ).toBe(1000);
    expect(h.writer.rows[0]).toMatchObject({
      inputTokens: 1000,
      outputTokens: 100,
      estimatedCostMillicents: Math.round(
        1000 * CLAUDE_MODELS['claude-opus-5'].inputCentsPer1k +
          100 * CLAUDE_MODELS['claude-opus-5'].outputCentsPer1k,
      ),
    });
  });

  it('…and de-duplication is by record id ONLY: two different ids are two calls, and a call with no id is never mistaken for a retry', async () => {
    const h = harness();
    const wrapped = h.telemetry.wrapUsageRecorder();
    await wrapped.record(recordArgs('rec-a'));
    await wrapped.record(recordArgs('rec-b'));
    await wrapped.record(recordArgs());
    await wrapped.record(recordArgs());
    expect(
      h.metrics.getValue(METRIC_NAMES.agentTurnModelCallTotal, {
        call_kind: 'unattributed',
        model: 'claude-opus-5',
      }),
    ).toBe(4);
  });

  it('the memory of seen record ids is bounded: an id pushed out by 512 newer ones is simply observed again, and nothing grows with traffic', async () => {
    const h = harness();
    const wrapped = h.telemetry.wrapUsageRecorder();
    await wrapped.record(recordArgs('first'));
    for (let i = 0; i < 512; i += 1) await wrapped.record(recordArgs(`r${i.toString()}`));
    await wrapped.record(recordArgs('r511')); // still remembered: not counted
    await wrapped.record(recordArgs('first')); // evicted: counted again
    expect(
      h.metrics.getValue(METRIC_NAMES.agentTurnModelCallTotal, {
        call_kind: 'unattributed',
        model: 'claude-opus-5',
      }),
    ).toBe(514);
  });

  it('a recorder call for a usage block with NO model is still a recorder call: the result’s own usage block is not added on top of it', async () => {
    const h = harness();
    const c = h.telemetry.begin({ agentSessionId: 's', transport: 'json' });
    c.recordProgress({ kind: 'phase', phase: 'planning' });
    h.telemetry.observeModelCall({ agentSessionId: 's', usage: { anthropicInputTokens: 100 } });
    c.observeResult({
      ...planExecuted([ok(NAVIGATE)]),
      decomposer: { kind: 'plan', intents: [NAVIGATE], tokensConsumed: 1, usage: USAGE },
    } as RunTurnResult);
    c.finish({ status: 200, body: {} });
    await h.telemetry.flush();
    expect(h.writer.rows[0]?.inputTokens).toBe(100);
  });

  it('with NO recorder call at all, the row falls back to the usage block the result carries', async () => {
    const h = harness();
    const c = h.telemetry.begin({ agentSessionId: 's', transport: 'json' });
    c.observeResult({
      ...planExecuted([ok(NAVIGATE)]),
      decomposer: { kind: 'plan', intents: [NAVIGATE], tokensConsumed: 1, usage: USAGE },
    } as RunTurnResult);
    c.finish({ status: 200, body: {} });
    await h.telemetry.flush();
    expect(h.writer.rows[0]).toMatchObject({ inputTokens: 2000, model: 'claude-opus-5' });
  });

  it('a collector LEAKED on a session does not swallow the live turn’s usage: the call goes to the most recently started request that has seen progress', async () => {
    const h = harness();
    const leaked = h.telemetry.begin({ agentSessionId: 's', transport: 'stream' });
    leaked.recordProgress({ kind: 'phase', phase: 'planning' });
    // …its handler died here: no finish(). A later turn on the same session:
    const live = h.telemetry.begin({ agentSessionId: 's', transport: 'stream' });
    live.recordProgress({ kind: 'phase', phase: 'planning' });
    h.telemetry.observeModelCall({ agentSessionId: 's', usage: USAGE });
    live.observeResult(planExecuted([ok(NAVIGATE)]));
    live.finish({ status: 200, body: {} });
    await h.telemetry.flush();
    expect(h.writer.rows).toHaveLength(1);
    expect(h.writer.rows[0]?.inputTokens).toBe(2000);
  });
});

describe('agent turn telemetry — the series an alert divides by exist from the first scrape', () => {
  it('CRITICAL every outcome is born at ZERO. The completion-rate alert divides `completed` by the decided total; with no completion since the last restart there was no `completed` series, the numerator was an empty vector, and the alert was silent at exactly 0% — the state that prompted this instrument.', () => {
    const metrics = newRegistry();
    new AgentTurnTelemetry({ metrics });
    const exposition = metrics.render();
    for (const outcome of AGENT_TURN_OUTCOMES) {
      expect(exposition).toContain(`${METRIC_NAMES.agentTurnTotal}{outcome="${outcome}"} 0`);
    }
    for (const outcome of AGENT_TURN_TELEMETRY_WRITE_OUTCOMES) {
      expect(exposition).toContain(
        `${METRIC_NAMES.agentTurnTelemetryWriteTotal}{outcome="${outcome}"} 0`,
      );
    }
  });

  it('seeding cannot throw out of the constructor when the registry lacks the counters', () => {
    expect(() => new AgentTurnTelemetry({ metrics: new MetricsRegistry() })).not.toThrow();
  });
});

describe('agent turn telemetry — a thrown error is recorded as what the CUSTOMER received', () => {
  async function outcomeOfThrown(error: unknown): Promise<AgentTurnTelemetryRow | undefined> {
    const h = harness();
    const c = h.telemetry.begin({ agentSessionId: 's', transport: 'json' });
    c.recordProgress({ kind: 'phase', phase: 'planning' });
    c.finishWithError(error);
    await h.telemetry.flush();
    return h.writer.rows[0];
  }

  it('CRITICAL a provider error carrying the PROVIDER’s status is a 500 to the customer, and an `error` here. Reading its numeric `.status` filed a provider credential failure as "request rejected", outside the completion rate’s denominator.', async () => {
    const providerError = Object.assign(new Error('Anthropic API 401'), {
      name: 'AnthropicStreamError',
      status: 401,
    });
    expect(await outcomeOfThrown(providerError)).toMatchObject({
      outcome: 'error',
      deathReason: 'turn_errored',
      httpStatus: 500,
    });
  });

  it('an ApiError keeps its own status and typed extensions', async () => {
    const busy = new ConflictError('still working', { turn_in_progress: true });
    expect(await outcomeOfThrown(busy)).toMatchObject({
      outcome: 'busy_409',
      deathReason: 'turn_in_progress',
      httpStatus: 409,
    });
  });

  it('the two other arms of the error handler: a schema failure is a 400, and a framework 4xx keeps its statusCode; a framework 5xx does not', async () => {
    const zodError = z.object({ a: z.string() }).safeParse({}).error;
    expect(await outcomeOfThrown(zodError)).toMatchObject({ outcome: 'rejected', httpStatus: 400 });
    expect(
      await outcomeOfThrown(Object.assign(new Error('too big'), { statusCode: 413 })),
    ).toMatchObject({ outcome: 'rejected', httpStatus: 413 });
    expect(
      await outcomeOfThrown(Object.assign(new Error('bad gateway'), { statusCode: 502 })),
    ).toMatchObject({ outcome: 'error', httpStatus: 500 });
  });

  it('anything else — a string, null, an object with a hostile getter — is a 500 and never throws', async () => {
    const hostile = Object.defineProperty({}, 'statusCode', {
      get: () => {
        throw new Error('getter');
      },
    });
    for (const thrown of ['boom', null, undefined, hostile]) {
      expect(await outcomeOfThrown(thrown)).toMatchObject({ outcome: 'error', httpStatus: 500 });
    }
  });
});

describe('agent turn telemetry — cost and counts', () => {
  it('a ONE-HOUR cache write is priced at the one-hour rate. The planner caches its system prompt — the largest prefix — for an hour; at the five-minute rate every cold call was understated.', () => {
    const rate = CLAUDE_MODELS['claude-opus-5'];
    const tokens = readUsageTokens({
      anthropicCacheCreationInputTokens: 5000,
      anthropicCacheCreation5mInputTokens: 1000,
      anthropicCacheCreation1hInputTokens: 4000,
    });
    expect(tokens).toMatchObject({ cacheWrite: 5000, cacheWrite1h: 4000 });
    expect(rate.cacheWrite1hMultiplier).toBeGreaterThan(rate.cacheWrite5mMultiplier);
    expect(estimateCostMillicents('claude-opus-5', tokens)).toBe(
      Math.round(
        rate.inputCentsPer1k *
          (1000 * rate.cacheWrite5mMultiplier + 4000 * rate.cacheWrite1hMultiplier),
      ),
    );
  });

  it('with no lifetime breakdown a write falls back to the five-minute rate; a breakdown with no total still counts; the hour share can never exceed the whole', () => {
    const rate = CLAUDE_MODELS['claude-opus-5'];
    expect(
      estimateCostMillicents(
        'claude-opus-5',
        readUsageTokens({ anthropicCacheCreationInputTokens: 2000 }),
      ),
    ).toBe(Math.round(rate.inputCentsPer1k * 2000 * rate.cacheWrite5mMultiplier));
    expect(
      readUsageTokens({
        anthropicCacheCreation5mInputTokens: 10,
        anthropicCacheCreation1hInputTokens: 30,
      }),
    ).toMatchObject({ cacheWrite: 40, cacheWrite1h: 30 });
    expect(
      estimateCostMillicents('claude-opus-5', {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 100,
        cacheWrite1h: 900,
      }),
    ).toBe(Math.round(rate.inputCentsPer1k * 100 * rate.cacheWrite1hMultiplier));
  });

  it('steps planned is the plan of record, and a turn that DIED EARLY shows planned > run', async () => {
    const h = harness();
    const c = h.telemetry.begin({ agentSessionId: 's', transport: 'stream' });
    c.recordProgress({ kind: 'phase', phase: 'planning' });
    c.recordProgress({ kind: 'plan', intents: [NAVIGATE], total: 5 });
    c.observeResult(planExecuted([ok(NAVIGATE), failed(INTERACT, 'element_not_found')]));
    c.finish({ status: 200, body: {} });
    await h.telemetry.flush();
    expect(h.writer.rows[0]).toMatchObject({ stepsPlanned: 5, stepsRun: 2 });
  });

  it('after a re-plan, steps planned is the LAST plan’s cumulative total — not the sum of every plan drawn up, which counted the steps already run twice', async () => {
    const h = harness();
    const c = h.telemetry.begin({ agentSessionId: 's', transport: 'stream' });
    c.recordProgress({ kind: 'phase', phase: 'planning' });
    c.recordProgress({ kind: 'plan', intents: [NAVIGATE], total: 3 });
    c.recordProgress({ kind: 'phase', phase: 'planning' });
    c.recordProgress({ kind: 'plan', intents: [NAVIGATE], total: 6 });
    c.observeResult(planExecuted([ok(NAVIGATE), failed(INTERACT, 'element_not_found')]));
    c.finish({ status: 200, body: {} });
    await h.telemetry.flush();
    expect(h.writer.rows[0]?.stepsPlanned).toBe(6);
  });

  it('a viewer that went away before the terminal frame is recorded on the row', async () => {
    const h = harness();
    const c = h.telemetry.begin({ agentSessionId: 's', transport: 'stream' });
    c.observeResult(planExecuted([ok(NAVIGATE)]));
    c.finish({ status: 200, body: {}, viewerDisconnected: true });
    await h.telemetry.flush();
    expect(h.writer.rows[0]?.viewerDisconnected).toBe(true);
  });

  it('turnRan: every ran outcome, plus an `error` that had already called the model — and not an error that never got that far', () => {
    expect(turnRan({ outcome: 'completed', modelCalls: 0 })).toBe(true);
    expect(turnRan({ outcome: 'error', modelCalls: 2 })).toBe(true);
    expect(turnRan({ outcome: 'error', modelCalls: 0 })).toBe(false);
    expect(turnRan({ outcome: 'busy_409', modelCalls: 0 })).toBe(false);
    expect(turnRan({ outcome: 'rejected', modelCalls: 3 })).toBe(false);
  });
});

describe('agent turn telemetry — the write path is bounded in every direction', () => {
  it('CRITICAL a write that never settles gives its slot back at the deadline, counted as an error. Without the deadline a black-holed connection pinned the in-flight count at the cap and every later row was dropped until restart, even after the database recovered.', async () => {
    const metrics = newRegistry();
    let hang = true;
    const written: AgentTurnTelemetryRow[] = [];
    const telemetry = new AgentTurnTelemetry({
      metrics,
      maxPendingWrites: 1,
      writeTimeoutMs: 15,
      writer: {
        insert: (r) => {
          if (hang) return new Promise<void>(() => undefined);
          written.push(r);
          return Promise.resolve();
        },
      },
    });
    telemetry.begin({ agentSessionId: 'a', transport: 'json' }).finish({ status: 200, body: {} });
    await telemetry.flush();
    expect(metrics.getValue(METRIC_NAMES.agentTurnTelemetryWriteTotal, { outcome: 'error' })).toBe(
      1,
    );
    // The database is back. The single slot must be free again.
    hang = false;
    telemetry.begin({ agentSessionId: 'b', transport: 'json' }).finish({ status: 200, body: {} });
    await telemetry.flush();
    expect(written).toHaveLength(1);
    expect(
      metrics.getValue(METRIC_NAMES.agentTurnTelemetryWriteTotal, { outcome: 'dropped' }),
    ).toBe(0);
  });

  it('a write that fails AFTER its deadline passed is not an unhandled rejection and is not counted twice', async () => {
    const metrics = newRegistry();
    let rejectLate: ((e: Error) => void) | undefined;
    const telemetry = new AgentTurnTelemetry({
      metrics,
      writeTimeoutMs: 10,
      writer: {
        insert: () =>
          new Promise<void>((_resolve, reject) => {
            rejectLate = reject;
          }),
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      telemetry.begin({ agentSessionId: 'a', transport: 'json' }).finish({ status: 200, body: {} });
      await telemetry.flush();
      rejectLate?.(new Error('late'));
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(metrics.getValue(METRIC_NAMES.agentTurnTelemetryWriteTotal, { outcome: 'error' })).toBe(
      1,
    );
  });

  it('CRITICAL a storm of turned-away requests does not become a database write per request. Past the per-minute budget the row is SHED and counted; the request is still counted in the metrics, a turn that RAN is never shed, and the budget refills with the clock.', async () => {
    const h = (() => {
      const metrics = newRegistry();
      const clock = new Clock();
      const writer = new CapturingWriter();
      const telemetry = new AgentTurnTelemetry({
        writer,
        metrics,
        nowMs: clock.now,
        maxTurnedAwayRowsPerMinute: 2,
      });
      return { metrics, clock, writer, telemetry };
    })();
    const bounce = (): void => {
      h.telemetry
        .begin({ agentSessionId: 's', transport: 'json' })
        .finish({ status: 409, body: { turn_in_progress: true } });
    };
    for (let i = 0; i < 5; i += 1) bounce();
    const ran = h.telemetry.begin({ agentSessionId: 't', transport: 'json' });
    ran.observeResult(planExecuted([ok(NAVIGATE)]));
    ran.finish({ status: 200, body: {} });
    await h.telemetry.flush();
    expect(h.writer.rows.map((r) => r.outcome)).toEqual(['busy_409', 'busy_409', 'completed']);
    expect(h.metrics.getValue(METRIC_NAMES.agentTurnTelemetryWriteTotal, { outcome: 'shed' })).toBe(
      3,
    );
    expect(h.metrics.getValue(METRIC_NAMES.agentTurnTotal, { outcome: 'busy_409' })).toBe(5);

    h.clock.advance(60_000);
    bounce();
    await h.telemetry.flush();
    expect(h.writer.rows.filter((r) => r.outcome === 'busy_409')).toHaveLength(3);
  });

  it('abandoned collectors are evicted once the active map is large: a handler that died between begin and finish cannot hold memory for the life of the process', () => {
    const h = harness();
    for (let i = 0; i < 1000; i += 1) {
      h.telemetry.begin({ agentSessionId: `leak${i.toString()}`, transport: 'json' });
    }
    expect(h.telemetry.activeCount()).toBe(1000);
    // Under an hour old: a turn may legitimately still be running. Kept.
    h.clock.advance(59 * 60 * 1000);
    h.telemetry.begin({ agentSessionId: 'young', transport: 'json' });
    expect(h.telemetry.activeCount()).toBe(1001);
    h.clock.advance(2 * 60 * 1000);
    h.telemetry.begin({ agentSessionId: 'after', transport: 'json' });
    // The thousand are gone; the two recent ones remain.
    expect(h.telemetry.activeCount()).toBe(2);
  });
});

describe('agent turn telemetry — a turn the LOOP stopped short is not a completion', () => {
  const classify = (result: RunTurnResult): ReturnType<typeof classifyTurn> =>
    classifyTurn({ result, status: 200, body: {}, sawPlanning: true, sawAnswering: false });
  const allGreen = [ok(NAVIGATE), ok(INTERACT)];

  it('a loop that finished (`done`) with every step green is `completed`', () => {
    expect(
      classify(
        planExecuted(allGreen, {
          loop: { segments: 3, plannerCalls: 3, replans: 0, finalStatus: 'done' },
        }),
      ),
    ).toMatchObject({ outcome: 'completed', deathReason: 'none' });
  });

  it.each([
    ['planner_call_limit', 'clarified', 'none'],
    ['wall_clock', 'clarified', 'none'],
    ['no_progress', 'clarified', 'none'],
    ['repeat_refused', 'clarified', 'none'],
    ['budget_floor', 'failed', 'budget_exhausted'],
    ['planner_unavailable', 'failed', 'model_unavailable'],
  ] as const)(
    '⛔ every step green but stopped at %s — filed as %s/%s, never `completed`',
    (stopped, outcome, deathReason) => {
      const verdict = classify(
        planExecuted(allGreen, {
          loop: { segments: 2, plannerCalls: 2, replans: 0, finalStatus: 'continue', stopped },
        }),
      );
      expect(verdict).toMatchObject({ outcome, deathReason });
      expect(verdict.diedStepIndex).toBe(outcome === 'failed' ? allGreen.length : null);
    },
  );

  it('a planner that asked a question part-way is `clarified`; one that declined part-way is `refused`', () => {
    const loop = { segments: 2, plannerCalls: 2, replans: 0, handedBack: true } as const;
    expect(
      classify(planExecuted(allGreen, { loop: { ...loop, handedBackKind: 'clarify' } })),
    ).toMatchObject({ outcome: 'clarified', deathReason: 'none' });
    expect(
      classify(planExecuted(allGreen, { loop: { ...loop, handedBackKind: 'refuse' } })),
    ).toMatchObject({ outcome: 'refused', deathReason: 'model_refused' });
  });

  it('a step that FAILED still decides the verdict — a loop stop never hides a real death', () => {
    expect(
      classify(
        planExecuted([ok(NAVIGATE), failed(INTERACT, 'element_not_found')], {
          loop: { segments: 2, plannerCalls: 2, replans: 0, stopped: 'no_progress' },
        }),
      ),
    ).toMatchObject({ outcome: 'failed', diedStepIndex: 1, diedStepKind: 'interact' });
  });

  it('the bound that stopped it is logged by name, content-free, beside the row', async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const telemetry = new AgentTurnTelemetry({
      writer: new CapturingWriter(),
      metrics: newRegistry(),
      nowMs: () => 0,
      wallClock: () => new Date('2026-09-18T00:00:00Z'),
      logger: { warn: (obj) => warnings.push(obj) },
    });
    const c = telemetry.begin({ agentSessionId: 'ags_1', transport: 'stream' });
    c.observeResult(
      planExecuted(allGreen, {
        loop: { segments: 6, plannerCalls: 6, replans: 0, stopped: 'planner_call_limit' },
      }),
    );
    c.finish({ status: 200, body: { kind: 'plan-executed' } });
    await telemetry.flush();
    const line = warnings.find((w) => w.event === 'agent_turn_stopped_unfinished');
    expect(line).toMatchObject({ stopped: 'planner_call_limit', outcome: 'clarified' });
  });

  it('T2 — a turn that stopped because two segments could not be read is `failed`/`page_load_failed`', () => {
    expect(
      classify(
        planExecuted(allGreen, {
          loop: { segments: 3, plannerCalls: 3, replans: 0, stopped: 'page_unreadable' },
        }),
      ),
    ).toMatchObject({ outcome: 'failed', deathReason: 'page_load_failed' });
  });

  it('T4 — the SAME `agent_turn_stopped_unfinished` line carries a bounded `trace`: step verbs+durations+ok, planning-read outcomes, planner calls, blind segments — and no page text', async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const telemetry = new AgentTurnTelemetry({
      writer: new CapturingWriter(),
      metrics: newRegistry(),
      nowMs: () => 0,
      wallClock: () => new Date('2026-09-18T00:00:00Z'),
      logger: { warn: (obj) => warnings.push(obj) },
    });
    const c = telemetry.begin({ agentSessionId: 'ags_1', transport: 'stream' });
    c.observeResult(
      planExecuted(
        allGreen,
        {
          loop: {
            segments: 3,
            plannerCalls: 3,
            replans: 0,
            stopped: 'page_unreadable',
            blindSegments: 2,
            planningReads: [
              { ms: 25_000, outcome: 'timeout', chars: 0, truncated: false },
              { ms: 30, outcome: 'empty', chars: 0, truncated: false },
            ],
          },
        },
        {
          stepTrace: [
            { verb: 'navigate', ms: 120, ok: true },
            { verb: 'interact', ms: 80, ok: true },
          ],
        },
      ),
    );
    c.finish({ status: 200, body: { kind: 'plan-executed' } });
    await telemetry.flush();
    const line = warnings.find((w) => w.event === 'agent_turn_stopped_unfinished');
    expect(line).toBeDefined();
    const trace = (line as Record<string, unknown>).trace as {
      steps: unknown[];
      reads: unknown[];
      plannerCalls: number;
      blindSegments: number;
    };
    expect(trace).toBeDefined();
    expect(trace.plannerCalls).toBe(3);
    expect(trace.blindSegments).toBe(2);
    expect(trace.reads).toEqual([
      { ms: 25_000, outcome: 'timeout', chars: 0, truncated: false },
      { ms: 30, outcome: 'empty', chars: 0, truncated: false },
    ]);
    expect(trace.steps).toEqual([
      { verb: 'navigate', ms: 120, ok: true },
      { verb: 'interact', ms: 80, ok: true },
    ]);
    // NO page text, NO selectors, NO customer message, NO url anywhere on the
    // line: it is closed enums and numbers only.
    const serialised = JSON.stringify(line);
    expect(serialised).not.toMatch(/https?:\/\//);
    expect(serialised).not.toMatch(/#go|example\.test/);
  });

  it('T4 — the trace is BOUNDED: more entries than the cap still logs only the cap, on both arrays', async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const telemetry = new AgentTurnTelemetry({
      writer: new CapturingWriter(),
      metrics: newRegistry(),
      nowMs: () => 0,
      wallClock: () => new Date('2026-09-18T00:00:00Z'),
      logger: { warn: (obj) => warnings.push(obj) },
    });
    const c = telemetry.begin({ agentSessionId: 'ags_1', transport: 'stream' });
    const manyReads = Array.from({ length: 60 }, (_, i) => ({
      ms: i,
      outcome: 'ok' as const,
      chars: 10,
      truncated: false,
    }));
    const manySteps = Array.from({ length: 60 }, (_, i) => ({
      verb: 'wait' as const,
      ms: i,
      ok: true,
    }));
    c.observeResult(
      planExecuted(
        allGreen,
        {
          loop: {
            segments: 3,
            plannerCalls: 3,
            replans: 0,
            stopped: 'page_unreadable',
            planningReads: manyReads,
          },
        },
        { stepTrace: manySteps },
      ),
    );
    c.finish({ status: 200, body: { kind: 'plan-executed' } });
    await telemetry.flush();
    const line = warnings.find((w) => w.event === 'agent_turn_stopped_unfinished');
    const trace = (line as Record<string, unknown>).trace as { steps: unknown[]; reads: unknown[] };
    expect(trace.steps.length).toBeLessThanOrEqual(40);
    expect(trace.reads.length).toBeLessThanOrEqual(40);
  });

  it('a turn with nothing to trace (no steps, no reads) logs the line with no `trace` field', async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const telemetry = new AgentTurnTelemetry({
      writer: new CapturingWriter(),
      metrics: newRegistry(),
      nowMs: () => 0,
      wallClock: () => new Date('2026-09-18T00:00:00Z'),
      logger: { warn: (obj) => warnings.push(obj) },
    });
    const c = telemetry.begin({ agentSessionId: 'ags_1', transport: 'stream' });
    c.observeResult(
      planExecuted(allGreen, {
        loop: { segments: 6, plannerCalls: 6, replans: 0, stopped: 'planner_call_limit' },
      }),
    );
    c.finish({ status: 200, body: { kind: 'plan-executed' } });
    await telemetry.flush();
    const line = warnings.find((w) => w.event === 'agent_turn_stopped_unfinished');
    expect(line).toBeDefined();
    expect((line as Record<string, unknown>).trace).toBeUndefined();
  });
});
