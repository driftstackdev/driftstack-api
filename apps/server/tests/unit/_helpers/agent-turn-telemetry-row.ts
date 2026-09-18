// A valid agent_turn_telemetry row for tests: one completed streaming turn, a
// minute before `AGENT_TURN_ROW_NOW`. Override only what the test is about.

import type { AgentTurnTelemetryRow } from '../../../src/services/agent-turn-telemetry.js';

export const AGENT_TURN_ROW_NOW = Date.parse('2026-09-18T12:00:00Z');

export function row(over: Partial<AgentTurnTelemetryRow> = {}): AgentTurnTelemetryRow {
  return {
    occurredAt: new Date(AGENT_TURN_ROW_NOW - 60_000),
    outcome: 'completed',
    deathReason: 'none',
    diedStepIndex: null,
    diedStepKind: null,
    httpStatus: 200,
    transport: 'stream',
    model: 'claude-opus-5',
    stepsPlanned: 2,
    stepsRun: 2,
    stepsSucceeded: 2,
    replans: 0,
    modelCalls: 1,
    recoveredAfterReplan: false,
    durationMs: 10_000,
    timeToFirstProgressMs: 400,
    planningMs: 4000,
    startingBrowserMs: 1000,
    executingMs: 5000,
    readingPageMs: 0,
    answeringMs: 0,
    inputTokens: 2000,
    outputTokens: 400,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostMillicents: 2000,
    customerStopped: false,
    viewerDisconnected: false,
    ...over,
  };
}
