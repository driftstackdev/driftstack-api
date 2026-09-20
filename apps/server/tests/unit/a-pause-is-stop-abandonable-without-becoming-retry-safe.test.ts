// S3 — two questions about one intent, and the answers differ.
//
//   · ABANDONABLE ON STOP — does anything on the page depend on how this step
//     ended? For a `behavioral_pause`: no. Waiting leaves nothing to inspect, so
//     walking away from one costs the customer nothing.
//   · SAFE TO RETRY — may the executor blindly re-send this after an ambiguous
//     failure? For a `behavioral_pause`: NO. The mapper sends every reading
//     pause as `scroll_through`, so the device reads a long page by scrolling
//     through it. Replaying one is a real distortion of what ran.
//
// ⛔ WHY THIS FILE EXISTS RATHER THAN A ONE-LINE SET CHANGE. The obvious fix for
// the stopped-pause defect was to add `behavioral_pause` to
// REPLAY_SAFE_INTENT_KINDS, which would have reached the Stop branch AND opened
// the retry fence in the same edit — silently making a dwell auto-replayable,
// which the fence's own comment names as the harm. The containment runs one way
// only: everything safe to replay is safe to abandon, and nothing more follows.

import { describe, expect, it } from 'vitest';
import {
  intentMayBeAbandonedOnStop,
  intentReplayMayDuplicateEffect,
} from '../../src/services/agent-intent-result.js';
import {
  ControlPlaneAgentExecutor,
  type IntentDispatcher,
} from '../../src/services/agent-executor-control-plane.js';
import type { ExecuteArgs } from '../../src/services/agent-executor.js';
import type { ParsedIntentResult } from '../../src/services/harness-control-codec.js';
import type { AgentIntent } from '@driftstack/api-types';
import type { IntentDispatch } from '../../src/schemas/harness-control-protocol.js';

const READ: AgentIntent = { kind: 'behavioral_pause', reading_word_count: 900 };
const DWELL: AgentIntent = { kind: 'behavioral_pause', duration_ms: 9_000 };
const BARE: AgentIntent = { kind: 'behavioral_pause' };
const SHOT: AgentIntent = { kind: 'capture', capture: 'screenshot' };
const SETTLE: AgentIntent = { kind: 'wait', condition: 'idle' };
const NAV: AgentIntent = { kind: 'navigate', url: 'https://shop.test/' };
const TAP: AgentIntent = { kind: 'interact', action: 'tap', selector: '#send' };
const SCROLL: AgentIntent = { kind: 'scroll', direction: 'down', amount_px: 600 };

const EVERY_PAUSE = [READ, DWELL, BARE];

describe('a pause is stop-abandonable without becoming retry-safe', () => {
  it('CRITICAL every shape of pause answers YES to abandonable and YES to "replay may duplicate"', () => {
    for (const pause of EVERY_PAUSE) {
      expect(intentMayBeAbandonedOnStop(pause), 'abandonable on Stop').toBe(true);
      expect(
        intentReplayMayDuplicateEffect(pause),
        'and still refused by the retry fence — a reading pause scrolls the page',
      ).toBe(true);
    }
  });

  it('CRITICAL the containment holds: everything safe to REPLAY is safe to ABANDON, and the pause is the only thing added', () => {
    for (const readOnly of [SHOT, SETTLE]) {
      expect(intentReplayMayDuplicateEffect(readOnly)).toBe(false);
      expect(intentMayBeAbandonedOnStop(readOnly)).toBe(true);
    }
    // A step that may change the page is neither — abandoning one leaves a
    // state nobody can describe, which is the whole reason for the grace wait.
    for (const effectful of [NAV, TAP, SCROLL]) {
      expect(intentMayBeAbandonedOnStop(effectful), 'must not become abandonable').toBe(false);
      expect(intentReplayMayDuplicateEffect(effectful)).toBe(true);
    }
  });

  it('CRITICAL the retry fence still refuses a pause after an ambiguous failure — ONE dispatch, and the customer is told the outcome is unknown', async () => {
    const sent: IntentDispatch[] = [];
    const dispatcher: IntentDispatcher = {
      dispatch: (d) => {
        sent.push(d);
        return Promise.resolve({
          sessionId: d.sessionId,
          intentId: d.intentId,
          success: false,
          durationMs: 1,
          // The coarse code that cannot distinguish "never applied" from
          // "applied, result lost" — the exact class a replay must not follow.
          errorCode: 'intent_webdriver_failed',
        } satisfies ParsedIntentResult);
      },
    };
    const exec = new ControlPlaneAgentExecutor(dispatcher, () => `int_${String(sent.length + 1)}`, {
      preTapLookTimeoutMs: 0,
      sleep: () => Promise.resolve(),
    });

    const argv: ExecuteArgs = {
      sessionId: 'agt_1',
      agentSessionId: 'agt_1',
      plan: { kind: 'plan', intents: [READ], tokensConsumed: 0 },
    };
    const result = await exec.execute(argv);

    expect(sent, 'a second dispatch here is a replayed dwell').toHaveLength(1);
    expect(result.results.at(-1)).toMatchObject({
      kind: 'failure',
      diagnosis: { category: 'unknown', retryable: false },
    });
  });

  it('a capture, which IS replay-safe, is still retried after the same ambiguous failure — so the arm above is about the pause', async () => {
    const sent: IntentDispatch[] = [];
    const dispatcher: IntentDispatcher = {
      dispatch: (d) => {
        sent.push(d);
        return Promise.resolve({
          sessionId: d.sessionId,
          intentId: d.intentId,
          success: false,
          durationMs: 1,
          errorCode: 'intent_webdriver_failed',
        } satisfies ParsedIntentResult);
      },
    };
    const exec = new ControlPlaneAgentExecutor(dispatcher, () => `int_${String(sent.length + 1)}`, {
      preTapLookTimeoutMs: 0,
      sleep: () => Promise.resolve(),
    });

    await exec.execute({
      sessionId: 'agt_1',
      agentSessionId: 'agt_1',
      plan: { kind: 'plan', intents: [SHOT], tokensConsumed: 0 },
    });

    expect(sent.length).toBeGreaterThan(1);
  });
});
