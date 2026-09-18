// Recordings rot, and a harness that lets them rot quietly reports a number
// about a prompt that no longer exists.
//
// Two guards, and one refusal.
//
//  1. `promptSha256` is recomputed from the LIVE system prompt every run. A
//     mismatch fails, and the message names the repair as RE-RECORD — never
//     "update the pin". An auto-updated pin certifies stale evidence as current,
//     which is worse than carrying no pin at all.
//  2. `requestDigest` is compared by the replaying fetch against the request the
//     decomposer ACTUALLY builds, so a recorded answer can never be served to a
//     different question.
//
// ⛔ AND THE REFUSAL: this repository carries NO recordings. Producing one needs
// a live model call, so the `recorded` tier is UNAVAILABLE rather than
// approximated, and the baseline must not claim to be a recorded number. A
// hand-written "recording" would be a fabricated record that verifies green:
// internally consistent, externally false.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ClaudeAgentDecomposer,
  __TEST_ONLY__,
} from '../../src/services/agent-decomposer-claude.js';
import type { DecomposeArgs } from '../../src/services/agent-decomposer.js';
import {
  RecordingMismatchError,
  currentPromptSha256,
  digestRequestBody,
  loadRecordings,
  replayingFetch,
  staleRecordingReason,
  type EvalRecording,
} from './_lib/recorded-decomposer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDINGS_DIR = resolve(HERE, 'recordings');
const BASELINE = resolve(HERE, 'eval-baseline.json');

function decomposeArgs(): DecomposeArgs {
  return {
    task: 'go to shop.test/deals and tell me the headline discount',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    history: [],
    budgetTokensRemaining: 100_000,
    byokAnthropicApiKey: 'sk-ant-eval-not-a-real-key',
  };
}

/**
 * Capture the request the REAL decomposer builds, without answering it.
 *
 * This is how a `requestDigest` is produced honestly: from the decomposer's own
 * assembly, never from a hand-written copy of what we think it sends.
 */
async function captureRequestBody(): Promise<string> {
  let captured = '';
  const fetchImpl = (_url: string | URL, init?: RequestInit): Promise<Response> => {
    captured = typeof init?.body === 'string' ? init.body : '';
    return Promise.reject(new Error('capture-only fetch'));
  };
  const decomposer = new ClaudeAgentDecomposer({
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
    retryBackoffMs: 0,
  });
  await decomposer.decompose(decomposeArgs()).catch(() => undefined);
  return captured;
}

describe('agent eval — recordings stay current, or the run stops being about today', () => {
  it('the recordings directory is empty, so the baseline must NOT claim a recorded number', () => {
    const recordings = loadRecordings(RECORDINGS_DIR);
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as { plannerMode: string };
    if (recordings.size === 0) {
      // The unmeasured case stays failing: with no recordings, the only planner
      // tier that can run is `scripted`, and a scripted completion rate is a
      // statement about the harness, not about the model's judgment.
      expect(baseline.plannerMode).not.toBe('recorded');
      expect(baseline.plannerMode).toBe('scripted');
      return;
    }
    expect(['recorded', 'scripted']).toContain(baseline.plannerMode);
  });

  it('every recording present was captured against the CURRENT system prompt', () => {
    const stale: string[] = [];
    for (const recording of loadRecordings(RECORDINGS_DIR).values()) {
      const reason = staleRecordingReason(recording);
      if (reason !== null) stale.push(reason);
    }
    expect(stale).toEqual([]);
  });

  it('the prompt hash is recomputed from the live constant, never read from a file', () => {
    const live = currentPromptSha256();
    expect(live).toMatch(/^[0-9a-f]{64}$/);
    expect(live).toBe(currentPromptSha256());
    // A prompt that differs by ONE character must hash differently — otherwise
    // the pin is decorative and a prompt edit would sail past it.
    const oneCharDifferent = createHash('sha256')
      .update(`${__TEST_ONLY__.SYSTEM_PROMPT} `, 'utf8')
      .digest('hex');
    expect(live).not.toBe(oneCharDifferent);
  });

  it('POSITIVE CONTROL: a reply recorded for THIS request is replayed by the real decomposer', async () => {
    const body = await captureRequestBody();
    expect(body.length).toBeGreaterThan(0);
    // ⚠️ GUARD FIXTURE, NOT A RECORDING. The response below was written here to
    // exercise the replay machinery; it is not filed under recordings/ and never
    // contributes to a completion number, because no model produced it.
    const fixture: EvalRecording = {
      taskId: 'GUARD',
      recordedAt: '2026-09-17T00:00:00.000Z',
      model: 'claude-opus-4-7',
      promptSha256: currentPromptSha256(),
      requestDigest: digestRequestBody(body),
      responseBody: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              kind: 'plan',
              intents: [
                { kind: 'navigate', url: 'https://shop.test/deals' },
                { kind: 'capture', capture: 'screenshot' },
              ],
            }),
          },
        ],
        usage: { input_tokens: 2412, output_tokens: 118 },
      },
    };
    const decomposer = new ClaudeAgentDecomposer({ fetch: replayingFetch(fixture) });
    const result = await decomposer.decompose(decomposeArgs());
    expect(result.kind).toBe('plan');
    if (result.kind !== 'plan') throw new Error('type narrow');
    expect(result.intents).toHaveLength(2);
    // The real accounting ran, which is the point of the recorded tier: it is
    // the actual parser, the actual plan cut and the actual usage block.
    expect(result.tokensConsumed).toBe(2530);
  });

  it('NEGATIVE CONTROL: a reply recorded for a DIFFERENT request is refused, not served', async () => {
    const body = await captureRequestBody();
    const fixture: EvalRecording = {
      taskId: 'GUARD',
      recordedAt: '2026-09-17T00:00:00.000Z',
      model: 'claude-opus-4-7',
      promptSha256: currentPromptSha256(),
      // The digest of a question nobody is asking.
      requestDigest: digestRequestBody(
        JSON.stringify({ model: 'x', system: 'a different prompt', messages: [] }),
      ),
      responseBody: {
        content: [{ type: 'text', text: '{"kind":"plan","intents":[]}' }],
        usage: {},
      },
    };
    expect(digestRequestBody(body)).not.toBe(fixture.requestDigest);
    const decomposer = new ClaudeAgentDecomposer({
      fetch: replayingFetch(fixture),
      retryBackoffMs: 0,
    });
    await expect(decomposer.decompose(decomposeArgs())).rejects.toThrow(/RE-RECORD/);
    // Named so a failure reads as a repair instruction rather than a puzzle.
    expect(new RecordingMismatchError('x').name).toBe('RecordingMismatchError');
  });

  it('a stale recording names the repair as a re-record, never as editing the pin', () => {
    const stale: EvalRecording = {
      taskId: 'S',
      recordedAt: '2026-01-01T00:00:00.000Z',
      model: 'claude-opus-4-7',
      promptSha256: 'f'.repeat(64),
      requestDigest: 'irrelevant',
      responseBody: {},
    };
    const reason = staleRecordingReason(stale);
    expect(reason).toContain('RE-RECORD THE EVAL FIXTURES');
    expect(reason).toContain('do NOT edit the pin');
  });
});
