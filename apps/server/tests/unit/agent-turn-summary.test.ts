// The operator's summary of AI turn health, derived from raw aggregates.
//
// The arithmetic is trivial; what is pinned here is what each number MEANS —
// which outcomes are in a denominator — and that a rate over nothing is `null`.
// Production had 27 AI turns in total when this was written. At that volume a
// zero that means "no data" and a zero that means "none succeeded" are both
// likely, and they must not render the same.

import { describe, expect, it } from 'vitest';
import {
  InMemoryAgentTurnTelemetryRepo,
  type AgentTurnTelemetryAggregates,
} from '../../src/db/agent-turn-telemetry-repo.js';
import {
  AGENT_TURN_SUMMARY_MAX_WINDOW_HOURS,
  AgentTurnSummaryService,
  buildAgentTurnSummary,
} from '../../src/services/agent-turn-summary.js';
import type { AgentTurnTelemetryRow } from '../../src/services/agent-turn-telemetry.js';
import { AGENT_TURN_ROW_NOW, row } from './_helpers/agent-turn-telemetry-row.js';

const NOW = AGENT_TURN_ROW_NOW;

async function summaryOf(rows: AgentTurnTelemetryRow[], hours = 24) {
  const repo = new InMemoryAgentTurnTelemetryRepo();
  for (const r of rows) await repo.insert(r);
  return new AgentTurnSummaryService({ repo, nowFn: () => NOW }).summarize(hours);
}

const busy = (): AgentTurnTelemetryRow =>
  row({
    outcome: 'busy_409',
    deathReason: 'turn_in_progress',
    httpStatus: 409,
    model: 'none',
    stepsPlanned: 0,
    stepsRun: 0,
    stepsSucceeded: 0,
    modelCalls: 0,
    durationMs: 30,
    timeToFirstProgressMs: null,
    planningMs: 0,
    startingBrowserMs: 0,
    executingMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostMillicents: 0,
  });

describe('agent turn summary', () => {
  it('an empty window: every count is 0 and every RATE is null, never 0', async () => {
    const s = await summaryOf([]);
    expect(s.requests.total).toBe(0);
    expect(s.turns.completion_rate).toBeNull();
    expect(s.turns.replan_rate).toBeNull();
    expect(s.turns.step_success_rate).toBeNull();
    expect(s.conflicts.rate_409).toBeNull();
    expect(s.tokens.per_turn.input).toBeNull();
    expect(s.tokens.cache_read_share).toBeNull();
    expect(s.cost.estimated_cents_per_turn).toBeNull();
    expect(s.durations_ms.turn).toEqual({ p50: null, p95: null });
    expect(s.deaths).toEqual([]);
    // Zero-filled, so a missing key can never be read as "none of those".
    expect(s.requests.by_outcome).toMatchObject({ completed: 0, busy_409: 0, error: 0 });
    expect(Object.keys(s.requests.by_outcome)).not.toContain('replayed');
    expect(Object.keys(s.requests.by_outcome)).not.toContain('manual_note');
  });

  it('completion rate is completed / DECIDED: a confirmation halt and a clarifying question are in neither side', async () => {
    const s = await summaryOf([
      row(),
      row(),
      row({
        outcome: 'failed',
        deathReason: 'page_load_failed',
        diedStepIndex: 0,
        diedStepKind: 'navigate',
      }),
      row({ outcome: 'refused', deathReason: 'model_unavailable' }),
      row({ outcome: 'halted_for_confirmation', deathReason: 'halted_for_confirmation' }),
      row({ outcome: 'clarified' }),
      busy(),
    ]);
    expect(s.turns.decided).toBe(4);
    expect(s.turns.completed).toBe(2);
    expect(s.turns.completion_rate).toBe(0.5);
    // Six requests did work; the 409 did none.
    expect(s.turns.ran).toBe(6);
    expect(s.requests.total).toBe(7);
  });

  it('the 409 rate is over ALL requests, and the busy share is reported on its own', async () => {
    const s = await summaryOf([
      row(),
      row(),
      busy(),
      row({
        outcome: 'conflict_409',
        deathReason: 'control_unavailable',
        httpStatus: 409,
        model: 'none',
      }),
    ]);
    expect(s.conflicts).toEqual({
      rate_409: 0.5,
      busy_409_rate: 0.25,
      busy_409: 1,
      conflict_409: 1,
    });
  });

  it('deaths are grouped by reason and step kind, most frequent first, with a share', async () => {
    const died = (kind: 'interact' | 'navigate', reason: AgentTurnTelemetryRow['deathReason']) =>
      row({ outcome: 'failed', deathReason: reason, diedStepIndex: 1, diedStepKind: kind });
    const s = await summaryOf([
      died('interact', 'element_never_appeared_in_retry_budget'),
      died('interact', 'element_never_appeared_in_retry_budget'),
      died('interact', 'element_never_appeared_in_retry_budget'),
      died('navigate', 'page_load_failed'),
      row(),
    ]);
    expect(s.deaths).toEqual([
      {
        reason: 'element_never_appeared_in_retry_budget',
        step_kind: 'interact',
        count: 3,
        share: 0.75,
      },
      { reason: 'page_load_failed', step_kind: 'navigate', count: 1, share: 0.25 },
    ]);
  });

  it('CRITICAL "where tasks die" is turns that DIED, and its shares are of those. A burst of 409s and 404s used to sit in the same list and dilute every real step death; they are listed apart, and a confirmation halt — which is not a death — is in neither.', async () => {
    const s = await summaryOf([
      row({
        outcome: 'failed',
        deathReason: 'page_load_failed',
        diedStepIndex: 0,
        diedStepKind: 'navigate',
      }),
      row({ outcome: 'error', deathReason: 'turn_errored', httpStatus: 500 }),
      row({ outcome: 'halted_for_confirmation', deathReason: 'halted_for_confirmation' }),
      busy(),
      busy(),
      busy(),
      row({ outcome: 'rejected', deathReason: 'request_rejected', httpStatus: 404, model: 'none' }),
    ]);
    expect(s.deaths).toEqual([
      { reason: 'page_load_failed', step_kind: 'navigate', count: 1, share: 0.5 },
      { reason: 'turn_errored', step_kind: null, count: 1, share: 0.5 },
    ]);
    expect(s.turned_away).toEqual([
      { reason: 'turn_in_progress', count: 3, share: 0.75 },
      { reason: 'request_rejected', count: 1, share: 0.25 },
    ]);
  });

  it('CRITICAL an `error` that had already called the model is a turn that RAN: its tokens, cost and time are in every per-turn figure. Left out, spend on errored turns was invisible — while the same row still counted against the completion rate. An error that never reached the model stays out, so its zeros cannot flatter the averages.', async () => {
    const s = await summaryOf([
      row({ inputTokens: 1000, estimatedCostMillicents: 1000, durationMs: 1000 }),
      row({
        outcome: 'error',
        deathReason: 'turn_errored',
        httpStatus: 500,
        modelCalls: 2,
        inputTokens: 5000,
        estimatedCostMillicents: 5000,
        durationMs: 3000,
      }),
      row({
        outcome: 'error',
        deathReason: 'turn_errored',
        httpStatus: 500,
        model: 'none',
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostMillicents: 0,
        durationMs: 5,
      }),
    ]);
    expect(s.turns.ran).toBe(2);
    expect(s.tokens.total.input).toBe(6000);
    expect(s.cost.estimated_cents_total).toBe(6);
    expect(s.durations_ms.turn).toEqual({ p50: 2000, p95: 2900 });
    // All three still count against completion.
    expect(s.turns.decided).toBe(3);
    expect(s.turns.completion_rate).toBe(0.3333);
  });

  it('"after the turn" is duration − first progress − the phases, over turns that ran and showed progress: the route’s own storage work, kept apart from the model’s time', async () => {
    const s = await summaryOf([
      // 10,000 − 400 − (4000 + 1000 + 5000) would be negative: clamped to 0.
      row(),
      row({ durationMs: 11_400 }), // 1000 after
      row({ durationMs: 12_400 }), // 2000 after
      // No progress seen: there is no phase clock to subtract, so it is left out
      // rather than reported as 30 seconds of "storage".
      row({ durationMs: 30_000, timeToFirstProgressMs: null }),
      busy(),
    ]);
    expect(s.durations_ms.after_turn).toEqual({ p50: 1000, p95: 1900 });
  });

  it('percentiles interpolate like percentile_cont, and a phase a turn never entered is not a zero-second sample', async () => {
    const s = await summaryOf([
      row({ durationMs: 1000, answeringMs: 0 }),
      row({ durationMs: 2000, answeringMs: 0 }),
      row({ durationMs: 3000, answeringMs: 2000 }),
      row({ durationMs: 4000, answeringMs: 4000 }),
      busy(),
    ]);
    // The busy request's 30ms is NOT a turn duration.
    expect(s.durations_ms.turn).toEqual({ p50: 2500, p95: 3850 });
    // Two turns answered; the two that did not are absent, not zeros.
    expect(s.durations_ms.phases.answering).toEqual({ p50: 3000, p95: 3900 });
  });

  it('time to first progress is reported for the streaming transport on its own', async () => {
    const s = await summaryOf([
      row({ transport: 'stream', timeToFirstProgressMs: 200 }),
      row({ transport: 'stream', timeToFirstProgressMs: 400 }),
      row({ transport: 'json', timeToFirstProgressMs: 9000 }),
      busy(),
    ]);
    expect(s.durations_ms.time_to_first_progress.stream).toEqual({ p50: 300, p95: 390 });
    expect(s.durations_ms.time_to_first_progress.all.p50).toBe(400);
  });

  it('tokens, cache share, re-plans and cost are per turn that RAN', async () => {
    const s = await summaryOf([
      row({
        inputTokens: 1000,
        cacheReadTokens: 8000,
        cacheWriteTokens: 1000,
        replans: 2,
        recoveredAfterReplan: true,
        modelCalls: 4,
        estimatedCostMillicents: 3000,
      }),
      row({ inputTokens: 3000, replans: 0, modelCalls: 2, estimatedCostMillicents: 1000 }),
      busy(),
    ]);
    expect(s.tokens.total).toEqual({
      input: 4000,
      output: 800,
      cache_read: 8000,
      cache_write: 1000,
    });
    expect(s.tokens.per_turn).toEqual({
      input: 2000,
      output: 400,
      cache_read: 4000,
      cache_write: 500,
    });
    expect(s.tokens.cache_read_share).toBe(0.6154);
    expect(s.turns.replan_rate).toBe(0.5);
    expect(s.turns.avg_replans).toBe(1);
    expect(s.turns.recovered_after_replan).toBe(1);
    expect(s.turns.avg_model_calls).toBe(3);
    // 4000 millicents = 4 cents, over 2 turns.
    expect(s.cost).toEqual({
      estimated_cents_total: 4,
      estimated_cents_per_turn: 2,
      estimated_cents_per_completed_turn: 2,
    });
  });

  it('the window excludes what is outside it, at both ends', async () => {
    const s = await summaryOf(
      [
        row({ occurredAt: new Date(NOW - 2 * 3_600_000) }),
        row({ occurredAt: new Date(NOW - 30 * 60_000) }),
        row({ occurredAt: new Date(NOW + 1000) }),
      ],
      1,
    );
    expect(s.requests.total).toBe(1);
    expect(s.window).toEqual({
      hours: 1,
      since: new Date(NOW - 3_600_000).toISOString(),
      until: new Date(NOW).toISOString(),
    });
  });

  it('a request that ended in the very millisecond the summary was asked for IS in it', async () => {
    const s = await summaryOf([row({ occurredAt: new Date(NOW) })], 1);
    expect(s.requests.total).toBe(1);
  });

  it('the widest window is exactly the retention, so no label can promise more history than is kept', () => {
    expect(AGENT_TURN_SUMMARY_MAX_WINDOW_HOURS).toBe(90 * 24);
    const empty: AgentTurnTelemetryAggregates = {
      byOutcome: {},
      deaths: [],
      turnedAway: [],
      byModel: [],
      ran: {
        count: 0,
        replanned: 0,
        replansSum: 0,
        recoveredAfterReplan: 0,
        customerStopped: 0,
        viewerDisconnected: 0,
        modelCallsSum: 0,
        stepsRunSum: 0,
        stepsSucceededSum: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMillicents: 0,
      },
      percentilesMs: {
        turn: { p50: null, p95: null },
        firstProgressStream: { p50: null, p95: null },
        firstProgressAll: { p50: null, p95: null },
        planning: { p50: null, p95: null },
        startingBrowser: { p50: null, p95: null },
        executing: { p50: null, p95: null },
        readingPage: { p50: null, p95: null },
        answering: { p50: null, p95: null },
        afterTurn: { p50: null, p95: null },
      },
    };
    const s = buildAgentTurnSummary(empty, {
      hours: 1,
      since: new Date(NOW - 3_600_000),
      until: new Date(NOW),
    });
    expect(s.retention_days).toBe(90);
  });
});
