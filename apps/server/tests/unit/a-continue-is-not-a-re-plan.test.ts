// B6 — THE PER-TURN TELEMETRY STAYS TRUE WHEN A TURN HAS SEVERAL SEGMENTS.
//
// The collector counted every return to `planning` after the first as a RE-PLAN,
// which was true while the only reason to plan twice in a turn was that a step
// had failed. A turn is now a loop: it goes back to `planning` because the last
// segment SUCCEEDED and said there was more to do. Counted alike, a healthy
// four-page task reads as three recoveries — and the re-plan histogram, the one
// series that says how often plans hit a wall, becomes a histogram of task
// length. They are opposite facts and the runtime now says which is which.

import { describe, expect, it } from 'vitest';
import type { AgentIntent } from '@driftstack/api-types';
import type { AgentSessionRecord } from '../../src/services/agent-sessions.js';
import type { IntentResult } from '../../src/services/agent-executor.js';
import type { AgentTurnProgressEvent, RunTurnResult } from '../../src/services/agent-runtime.js';
import { METRIC_NAMES, MetricsRegistry } from '../../src/services/metrics-registry.js';
import {
  AGENT_TURN_CALL_KINDS,
  AGENT_TURN_DURATION_BUCKETS_SECONDS,
  AGENT_TURN_FIRST_PROGRESS_BUCKETS_SECONDS,
  AGENT_TURN_REPLAN_BUCKETS,
  AgentTurnTelemetry,
  type AgentTurnTelemetryRow,
  type AgentTurnTelemetryWriter,
} from '../../src/services/agent-turn-telemetry.js';

function registry(): MetricsRegistry {
  const r = new MetricsRegistry();
  const counters: Array<[string, string[]]> = [
    [METRIC_NAMES.agentTurnTotal, ['outcome']],
    [METRIC_NAMES.agentTurnModelCallTotal, ['call_kind', 'model']],
    [METRIC_NAMES.agentTurnTokensTotal, ['token_type', 'call_kind', 'model']],
    [METRIC_NAMES.agentTurnStepFailureTotal, ['reason', 'step_kind']],
    [METRIC_NAMES.agentTurnTelemetryWriteTotal, ['outcome']],
  ];
  for (const [name, labels] of counters) r.registerCounter(name, 'h', labels);
  r.registerHistogram(
    METRIC_NAMES.agentTurnDurationSeconds,
    'h',
    AGENT_TURN_DURATION_BUCKETS_SECONDS,
    ['outcome'],
  );
  r.registerHistogram(
    METRIC_NAMES.agentTurnPhaseDurationSeconds,
    'h',
    AGENT_TURN_DURATION_BUCKETS_SECONDS,
    ['phase'],
  );
  r.registerHistogram(
    METRIC_NAMES.agentTurnTimeToFirstProgressSeconds,
    'h',
    AGENT_TURN_FIRST_PROGRESS_BUCKETS_SECONDS,
    ['transport'],
  );
  r.registerHistogram(METRIC_NAMES.agentTurnReplans, 'h', AGENT_TURN_REPLAN_BUCKETS, ['outcome']);
  return r;
}

class CapturingWriter implements AgentTurnTelemetryWriter {
  rows: AgentTurnTelemetryRow[] = [];
  insert(row: AgentTurnTelemetryRow): Promise<void> {
    this.rows.push(row);
    return Promise.resolve();
  }
}

const NAV: AgentIntent = { kind: 'navigate', url: 'https://example.test/' };
const TAP: AgentIntent = { kind: 'interact', action: 'tap', selector: '#go' };
const SHOT: AgentIntent = { kind: 'capture', capture: 'screenshot' };
const ok = (intent: AgentIntent): IntentResult => ({ kind: 'success', intent, summary: 'done' });
const notFound = (intent: AgentIntent): IntentResult => ({
  kind: 'failure',
  intent,
  reason: 'no element matched',
  diagnosis: { category: 'element_not_found', retryable: true },
});
const USAGE = {
  decomposerKind: 'claude' as const,
  anthropicInputTokens: 1000,
  anthropicOutputTokens: 100,
  model: 'claude-sonnet-5',
};

interface Pass {
  cause?: 'continue' | 'replan';
  intents: AgentIntent[];
  total: number;
  offset?: number;
}

/** Drive one turn through the collector the way the runtime's events would. */
async function runTurn(
  passes: Pass[],
  results: IntentResult[],
): Promise<{ row: AgentTurnTelemetryRow; calls: (kind: string) => number }> {
  const metrics = registry();
  const writer = new CapturingWriter();
  let t = 1_000;
  const telemetry = new AgentTurnTelemetry({
    writer,
    metrics,
    nowMs: () => t,
    wallClock: () => new Date('2026-09-18T00:00:00Z'),
  });
  const c = telemetry.begin({ agentSessionId: 'ags_1', transport: 'stream' });
  const recorder = telemetry.wrapUsageRecorder();
  const progress = (e: AgentTurnProgressEvent): void => {
    c.recordProgress(e);
  };
  for (const [i, pass] of passes.entries()) {
    const segment = i + 1;
    if (pass.cause !== undefined) {
      progress({ kind: 'phase', phase: 'reading_page', segment, cause: pass.cause });
    }
    progress({
      kind: 'phase',
      phase: 'planning',
      ...(pass.cause !== undefined ? { segment, cause: pass.cause } : {}),
    });
    t += 3_000;
    await recorder.record({
      accountId: 'a',
      driftstackSessionId: null,
      agentSessionId: 'ags_1',
      decomposeResultKind: 'plan',
      usage: USAGE,
      tokensConsumed: 1_100,
      now: new Date(),
    });
    progress({
      kind: 'plan',
      intents: pass.intents,
      total: pass.total,
      ...(pass.offset !== undefined ? { offset: pass.offset, segment } : {}),
    });
    progress({ kind: 'phase', phase: 'executing' });
    t += 2_000;
  }
  const result: RunTurnResult = {
    kind: 'plan-executed',
    decomposer: { kind: 'plan', intents: passes[0]?.intents ?? [], tokensConsumed: 1 },
    executor: {
      results,
      ok: results.at(-1)?.kind === 'success',
      ...(results.some((r) => r.kind === 'failure') ? { recoveredAfterReplan: true } : {}),
    },
    session: { id: 'ags_1', status: 'active' } as unknown as AgentSessionRecord,
  };
  c.observeResult(result);
  c.finish({ status: 200, body: { kind: 'plan-executed' } });
  await telemetry.flush();
  const row = writer.rows.at(-1);
  if (row === undefined) throw new Error('no row written');
  return {
    row,
    calls: (kind) =>
      metrics.getValue(METRIC_NAMES.agentTurnModelCallTotal, {
        call_kind: kind,
        model: 'claude-sonnet-5',
      }),
  };
}

describe('B6 — a `continue` is a model call and is NOT a re-plan', () => {
  it('a healthy three-segment turn records ZERO re-plans, three model calls, and every step it planned', async () => {
    const { row, calls } = await runTurn(
      [
        { intents: [NAV], total: 1 },
        { cause: 'continue', intents: [TAP], total: 2, offset: 1 },
        { cause: 'continue', intents: [SHOT], total: 3, offset: 2 },
      ],
      [ok(NAV), ok(TAP), ok(SHOT)],
    );
    expect(row.replans).toBe(0);
    expect(row.modelCalls).toBe(3);
    expect(row.stepsPlanned).toBe(3);
    expect(row.stepsRun).toBe(3);
    expect(row.recoveredAfterReplan).toBe(false);
    expect(row.outcome).toBe('completed');
    // And the calls are attributed to what they were.
    expect(calls('plan')).toBe(1);
    expect(calls('continue')).toBe(2);
    expect(calls('re_plan')).toBe(0);
  });

  it('a turn that BOTH continued and recovered counts each as what it was', async () => {
    const { row, calls } = await runTurn(
      [
        { intents: [NAV], total: 1 },
        { cause: 'continue', intents: [TAP], total: 2, offset: 1 },
        { cause: 'replan', intents: [TAP, SHOT], total: 4, offset: 2 },
      ],
      [ok(NAV), notFound(TAP), ok(TAP), ok(SHOT)],
    );
    expect(row.replans).toBe(1);
    expect(row.modelCalls).toBe(3);
    expect(row.recoveredAfterReplan).toBe(true);
    expect(calls('plan')).toBe(1);
    expect(calls('continue')).toBe(1);
    expect(calls('re_plan')).toBe(1);
  });

  it('⛔ a runtime that does NOT say why it is planning again is read as it always was — a return to planning is a re-plan', async () => {
    // The `cause` is additive. An event without one is from before it existed,
    // when the only reason to plan twice was a failure.
    const { row, calls } = await runTurn(
      [
        { intents: [NAV, TAP], total: 2 },
        { intents: [TAP, SHOT], total: 4 },
      ],
      [ok(NAV), notFound(TAP), ok(TAP), ok(SHOT)],
    );
    expect(row.replans).toBe(1);
    expect(calls('re_plan')).toBe(1);
    expect(calls('continue')).toBe(0);
  });

  it('`continue` is a member of the closed call-kind set, so a dashboard can enumerate it', () => {
    expect(AGENT_TURN_CALL_KINDS).toEqual([
      'plan',
      're_plan',
      'continue',
      'answer',
      'unattributed',
    ]);
  });
});
