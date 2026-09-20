// C4 — the cross-process stop claim must outlive the longest turn the constants
// permit, and the only way to know it does is to do the arithmetic.
//
// THE DEFECT THIS FILE EXISTS FOR. AGENT_TURN_CLAIM_TTL_SECONDS was a literal
// fifteen minutes carrying the sentence "several times the longest turn that can
// exist". It was not. A step that starts just before the turn's hard stop runs
// to its own dispatch deadline, then the read-back runs, then the answering call
// streams to its absolute cap — and those four numbers already add up past the
// TTL. A comment that says the arithmetic was checked, while the arithmetic says
// otherwise, is worse than no comment: everyone downstream reads it as evidence.
//
// WHAT EXPIRING UNDER A LIVE TURN COSTS. The claim and the stop recorded against
// it share a key, so the claim going first takes the Stop with it: a customer
// who pressed Stop is never obeyed, and the per-account concurrency slot is
// handed back while the turn is still holding it.
//
// ⛔ EACH TERM IS CHECKED AGAINST THE THING THAT USES IT, not against a copy.
// The dispatch deadline is computed with the correlator's own function over the
// protocol's own list of intent names; the read-back deadline is read off the
// timer the executor actually arms. A guard that re-derives a number it is
// guarding agrees with itself and proves nothing.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_TURN_CLAIM_TTL_SECONDS } from '../../src/services/agent-turn-stop-channel.js';
import {
  LONGEST_DISPATCH_DEADLINE_MS,
  LONGEST_TURN_THE_CONSTANTS_PERMIT_MS,
  TURN_ANSWER_STREAM_CAP_MS,
  TURN_HARD_STOP_MS,
  TURN_READ_BACK_TIMEOUT_MS,
} from '../../src/services/agent-turn-bounds.js';
import { dispatchTimeoutMs } from '../../src/services/harness-dispatch-correlator.js';
import { HARNESS_INTENT_NAMES } from '../../src/schemas/harness-control-protocol.js';
import { ControlPlaneAgentExecutor } from '../../src/services/agent-executor-control-plane.js';
import type { ParsedIntentResult } from '../../src/services/harness-control-codec.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

describe('the stop claim outlives the longest turn the constants permit', () => {
  it('CRITICAL the TTL covers the hard stop, the longest dispatch that can start just before it, the read-back and the answering call', () => {
    const longestTurnMs =
      TURN_HARD_STOP_MS +
      LONGEST_DISPATCH_DEADLINE_MS +
      TURN_READ_BACK_TIMEOUT_MS +
      TURN_ANSWER_STREAM_CAP_MS;

    expect(
      AGENT_TURN_CLAIM_TTL_SECONDS * 1000,
      'raise the claim TTL (or lower the bound that grew): a claim that expires under a live ' +
        'turn drops the Stop recorded against it and releases a concurrency slot the turn holds',
    ).toBeGreaterThanOrEqual(longestTurnMs);

    // And the composition the TTL is derived from is that same sum, so a fifth
    // term added to one and not the other cannot pass unnoticed.
    expect(LONGEST_TURN_THE_CONSTANTS_PERMIT_MS).toBe(longestTurnMs);
  });

  it('CRITICAL the old fifteen-minute literal does NOT cover it — the premise this replaced was false, not merely unchecked', () => {
    expect(15 * 60 * 1000).toBeLessThan(LONGEST_TURN_THE_CONSTANTS_PERMIT_MS);
  });

  it('the dispatch term is the correlator’s own deadline, maximised over every intent name the protocol defines', () => {
    const byName = HARNESS_INTENT_NAMES.map((name) => dispatchTimeoutMs(name));
    expect(LONGEST_DISPATCH_DEADLINE_MS).toBe(Math.max(...byName));
    // Not vacuous: the names differ from one another, so the maximum is a
    // choice and not the one value every name returns.
    expect(new Set(byName).size).toBeGreaterThan(1);
  });

  it('the read-back term is the timer the executor actually arms for a page read', async () => {
    const armed: number[] = [];
    const exec = new ControlPlaneAgentExecutor(
      // Never answers: the read-back's own deadline is what ends it.
      { dispatch: () => new Promise<ParsedIntentResult>(() => {}) },
      () => 'int_1',
      {
        sleep: (ms) => {
          armed.push(ms);
          return Promise.resolve();
        },
      },
    );

    await exec.observe?.('agt_1');

    expect(armed).toContain(TURN_READ_BACK_TIMEOUT_MS);
  });

  it('the answering call’s term is the cap the streamed planner uses, not a second copy of the number', () => {
    const body = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/services/agent-decomposer-claude.ts'),
      'utf8',
    );
    expect(body).toMatch(/const DEFAULT_STREAM_TOTAL_TIMEOUT_MS = TURN_ANSWER_STREAM_CAP_MS;/);
  });

  it('the TTL stays inside the reservation window a paid turn holds, so it cannot outlive what it coordinates', () => {
    // Thirty minutes is the ceiling a credit reservation is written against; a
    // claim living longer than that would survive the thing it is coordinating.
    expect(AGENT_TURN_CLAIM_TTL_SECONDS).toBeLessThan(30 * 60);
  });
});
