// Cross-module behavioral invariant — ClaudeAgentDecomposer's REAL thrown
// errors ↔ AgentRuntime.classifyDecomposerError.
//
// The runtime wraps decompose() in try/catch and routes the error by
// classifyDecomposerError: 'fatal' re-throws (→ route 502 + Sentry: "agent
// layer misconfigured / wire broken"), 'transient' is swallowed into a
// synthesized refuse that KEEPS THE SESSION ACTIVE so the customer can retry.
// The classification is done purely by matching the error MESSAGE against a set
// of regexes in agent-runtime.ts.
//
// Why this test exists (a gap the two existing suites leave open):
//   - agent-decomposer-claude.test.ts pins the decomposer's thrown messages
//     with LOOSE `toThrow(/missing text content/)` regexes.
//   - agent-runtime.test.ts pins classifyDecomposerError against HARD-CODED
//     strings (`new Error('Anthropic response missing text content')`), NOT the
//     decomposer's actual throws.
// Nothing drives the decomposer's ACTUAL error through the classifier. So a
// drift that renames a parse-error message AND updates the decomposer test's
// regex but forgets the classifier regex leaves BOTH suites green while the
// real coupling breaks — a genuine malformed-response / wire-break would then be
// silently classified 'transient' and masked as a customer "refuse" (no 502, no
// Sentry, the broken integration goes unnoticed). This test pins the end-to-end
// behaviour: every error the decomposer actually throws classifies as intended.

import { describe, expect, it, vi } from 'vitest';
import { ClaudeAgentDecomposer } from '../../src/services/agent-decomposer-claude.js';
import { classifyDecomposerError } from '../../src/services/agent-runtime.js';
import type { DecomposeArgs } from '../../src/services/agent-decomposer.js';

function defaultArgs(overrides: Partial<DecomposeArgs> = {}): DecomposeArgs {
  return {
    task: 'open https://example.com and capture the page',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    history: [],
    budgetTokensRemaining: 100_000,
    byokAnthropicApiKey: 'sk-ant-test-fake-key',
    ...overrides,
  };
}

// A 200 response whose single text block is exactly `text` (raw, NOT
// re-stringified) — lets us inject malformed model output.
function textResponse(text: string) {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function rawResponse(bodyObj: unknown, status = 200) {
  return new Response(JSON.stringify(bodyObj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sequenceFetch(responses: ReadonlyArray<Response | Error>): typeof globalThis.fetch {
  let idx = 0;
  // Non-async (returns Promises explicitly) so eslint's require-await is happy
  // — the impl has no internal await but must satisfy the fetch signature.
  return vi.fn((): Promise<Response> => {
    const next = responses[idx++];
    if (next === undefined) return Promise.reject(new Error('sequenceFetch ran out of responses'));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  });
}

// Run decompose(), expect it to throw, return the THROWN error (not a fresh
// one) so we can classify the decomposer's actual error object.
async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected decompose() to throw, but it resolved');
}

// retryBackoffMs:0 so the 5xx/network retry path doesn't sleep 1s.
function dec(responses: ReadonlyArray<Response | Error>): ClaudeAgentDecomposer {
  return new ClaudeAgentDecomposer({ fetch: sequenceFetch(responses), retryBackoffMs: 0 });
}

describe('decomposer errors ↔ runtime classifier cross-source invariant', () => {
  describe('FATAL — must re-throw (route 502 + Sentry), NEVER be masked as a transient refuse', () => {
    it('missing text content block', async () => {
      const err = await thrownBy(
        dec([rawResponse({ content: [{ type: 'image' }] })]).decompose(defaultArgs()),
      );
      expect(classifyDecomposerError(err)).toBe('fatal');
    });

    it('non-JSON model text', async () => {
      const err = await thrownBy(
        dec([textResponse('this is not json at all')]).decompose(defaultArgs()),
      );
      expect(classifyDecomposerError(err)).toBe('fatal');
    });

    it('JSON that is not an object (a bare number)', async () => {
      const err = await thrownBy(dec([textResponse('42')]).decompose(defaultArgs()));
      expect(classifyDecomposerError(err)).toBe('fatal');
    });

    it('unknown discriminator kind', async () => {
      const err = await thrownBy(
        dec([textResponse(JSON.stringify({ kind: 'mystery' }))]).decompose(defaultArgs()),
      );
      expect(classifyDecomposerError(err)).toBe('fatal');
    });

    it('plan with non-array intents', async () => {
      const err = await thrownBy(
        dec([textResponse(JSON.stringify({ kind: 'plan', intents: 'nope' }))]).decompose(
          defaultArgs(),
        ),
      );
      expect(classifyDecomposerError(err)).toBe('fatal');
    });

    it('malformed top-level/content envelopes', async () => {
      for (const response of [
        rawResponse(null),
        rawResponse({ content: {}, usage: { input_tokens: 10, output_tokens: 5 } }),
      ]) {
        const err = await thrownBy(dec([response]).decompose(defaultArgs()));
        expect(classifyDecomposerError(err)).toBe('fatal');
      }
    });

    it('invalid token usage', async () => {
      const err = await thrownBy(
        dec([
          rawResponse({
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  kind: 'plan',
                  intents: [{ kind: 'capture', capture: 'screenshot' }],
                }),
              },
            ],
            usage: { input_tokens: -10, output_tokens: 5 },
          }),
        ]).decompose(defaultArgs()),
      );
      expect(classifyDecomposerError(err)).toBe('fatal');
    });

    it('clarify missing clarifyingQuestion', async () => {
      const err = await thrownBy(
        dec([textResponse(JSON.stringify({ kind: 'clarify' }))]).decompose(defaultArgs()),
      );
      expect(classifyDecomposerError(err)).toBe('fatal');
    });

    it('refuse missing refuseReason', async () => {
      const err = await thrownBy(
        dec([textResponse(JSON.stringify({ kind: 'refuse' }))]).decompose(defaultArgs()),
      );
      expect(classifyDecomposerError(err)).toBe('fatal');
    });

    it('Anthropic 4xx (auth/quota/validation)', async () => {
      const err = await thrownBy(
        dec([new Response('unauthorized', { status: 401 })]).decompose(defaultArgs()),
      );
      expect(classifyDecomposerError(err)).toBe('fatal');
    });

    it('missing API key (configuration error)', async () => {
      const err = await thrownBy(
        dec([]).decompose(defaultArgs({ byokAnthropicApiKey: undefined })),
      );
      expect(classifyDecomposerError(err)).toBe('fatal');
    });
  });

  describe('TRANSIENT — synthesized refuse keeps the session active so the customer can retry', () => {
    it('persistent Anthropic 5xx (after the single retry)', async () => {
      const err = await thrownBy(
        dec([
          new Response('upstream', { status: 503 }),
          new Response('upstream', { status: 503 }),
        ]).decompose(defaultArgs()),
      );
      expect(classifyDecomposerError(err)).toBe('transient');
    });

    it('persistent network error (after the single retry)', async () => {
      const err = await thrownBy(
        dec([new Error('ECONNRESET'), new Error('ECONNRESET')]).decompose(defaultArgs()),
      );
      expect(classifyDecomposerError(err)).toBe('transient');
    });
  });
});
