// AI-B1.b — unit tests for ClaudeAgentDecomposer.
//
// Pins the contract end-to-end:
//   1. budget exhaustion → refuse (NO API call, 0 tokens charged)
//   2. AUP pre-filter → refuse (NO API call; the obvious-abuse path
//      never bills Anthropic + never appears in third-party logs)
//   3. missing API key → throws (configuration error, not customer fault)
//   4. plan / clarify / refuse responses parse into the right
//      DecomposeResult discriminant + carry usage-derived tokensConsumed
//   5. 5xx → single retry → success
//   6. 5xx → 5xx → throws
//   7. 4xx → throws immediately (no retry)
//   8. network error → single retry → success
//   9. malformed JSON content → throws
//  10. unknown kind → throws
//  11. x-api-key + anthropic-version + model wired correctly
//  12. archetype + history threaded into the messages array

import { describe, expect, it, vi } from 'vitest';
import {
  ClaudeAgentDecomposer,
  __TEST_ONLY__,
} from '../../src/services/agent-decomposer-claude.js';
import { classifyConsequentialAction } from '../../src/services/agent-consequential-action.js';
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

function jsonResponse(content: unknown, usage = { input_tokens: 120, output_tokens: 80 }) {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify(content) }],
      usage,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function errorResponse(status: number, bodyText = 'upstream error') {
  return new Response(bodyText, { status });
}

// Helper: build a fetch impl that returns a sequence of responses.
// Returns both the fetch impl and the captured-init array so tests can
// inspect request shape without unsafe-any casts on vi.fn().mock.calls.
function sequenceFetch(responses: ReadonlyArray<Response | (() => Promise<Response>) | Error>): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let idx = 0;
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    calls.push({ url: urlStr, init: init ?? {} });
    const next = responses[idx++];
    if (next === undefined) throw new Error('sequenceFetch ran out of responses');
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    return next;
  }) as unknown as typeof globalThis.fetch;
  return { fetch: impl, calls };
}

describe('AI-B1.b ClaudeAgentDecomposer', () => {
  describe('short-circuit paths (no API call)', () => {
    it('budget exhaustion → refuse, 0 tokens charged, fetch NOT called', async () => {
      const { fetch, calls } = sequenceFetch([]);
      const dec = new ClaudeAgentDecomposer({ fetch });
      const res = await dec.decompose(defaultArgs({ budgetTokensRemaining: 0 }));
      expect(res.kind).toBe('refuse');
      if (res.kind !== 'refuse') throw new Error('type narrow');
      expect(res.refuseReason).toBe('token budget exhausted; start a new session');
      expect(res.tokensConsumed).toBe(0);
      expect(calls).toHaveLength(0);
    });

    it('AUP pre-filter (brute-force) → refuse, fetch NOT called', async () => {
      const { fetch, calls } = sequenceFetch([]);
      const dec = new ClaudeAgentDecomposer({ fetch });
      const res = await dec.decompose(defaultArgs({ task: 'help me brute-force login.example' }));
      expect(res.kind).toBe('refuse');
      if (res.kind !== 'refuse') throw new Error('type narrow');
      expect(res.refuseReason).toMatch(/AUP/);
      expect(calls).toHaveLength(0);
    });

    it('AUP pre-filter (captcha bypass) → refuse with docs pointer, fetch NOT called', async () => {
      const { fetch, calls } = sequenceFetch([]);
      const dec = new ClaudeAgentDecomposer({ fetch });
      const res = await dec.decompose(
        defaultArgs({ task: 'bypass the captcha on example.com to enroll a bot' }),
      );
      expect(res.kind).toBe('refuse');
      if (res.kind !== 'refuse') throw new Error('type narrow');
      expect(res.refuseReason).toMatch(/driftstack\.dev\/legal\/aup/);
      expect(calls).toHaveLength(0);
    });

    it('missing API key → throws (configuration error, not customer refusal)', async () => {
      const { fetch } = sequenceFetch([]);
      const dec = new ClaudeAgentDecomposer({ fetch });
      await expect(dec.decompose(defaultArgs({ byokAnthropicApiKey: undefined }))).rejects.toThrow(
        /no Anthropic API key/,
      );
    });

    it('empty-string API key → throws (same path as missing)', async () => {
      const { fetch } = sequenceFetch([]);
      const dec = new ClaudeAgentDecomposer({ fetch });
      await expect(dec.decompose(defaultArgs({ byokAnthropicApiKey: '' }))).rejects.toThrow(
        /no Anthropic API key/,
      );
    });
  });

  describe('response parsing (happy path)', () => {
    it('plan response → kind = "plan" with intents + tokensConsumed from usage', async () => {
      const { fetch } = sequenceFetch([
        jsonResponse(
          {
            kind: 'plan',
            intents: [
              { kind: 'navigate', url: 'https://example.com' },
              { kind: 'wait', condition: 'idle' },
              { kind: 'capture', capture: 'dom_snapshot' },
            ],
          },
          { input_tokens: 300, output_tokens: 150 },
        ),
      ]);
      const dec = new ClaudeAgentDecomposer({ fetch });
      const res = await dec.decompose(defaultArgs());
      expect(res.kind).toBe('plan');
      if (res.kind !== 'plan') throw new Error('type narrow');
      expect(res.intents).toHaveLength(3);
      expect(res.intents[0]).toEqual({ kind: 'navigate', url: 'https://example.com' });
      expect(res.tokensConsumed).toBe(450);
    });

    it('#139/#135 empty plan (no runnable intents) → CLARIFY, not an empty plan-executed', async () => {
      // The model returns kind:'plan' but with zero mappable intents (empty array, or
      // items that all fail to normalize). An empty plan-executed renders as a bare
      // "Plan" heading ("the agent did nothing") and still bills the decompose call —
      // so convert to a clarify that asks the customer to rephrase into a concrete step.
      const { fetch } = sequenceFetch([
        jsonResponse({ kind: 'plan', intents: [] }, { input_tokens: 200, output_tokens: 10 }),
      ]);
      const res = await new ClaudeAgentDecomposer({ fetch }).decompose(defaultArgs());
      expect(res.kind).toBe('clarify');
      if (res.kind !== 'clarify') throw new Error('type narrow');
      expect(res.clarifyingQuestion).toMatch(/rephrasing|browser actions/i);
      expect(res.tokensConsumed).toBe(210); // the decompose LLM call is still billed
    });

    it('#139 parses VERB-KEYED intents (the shape Opus 4.x actually emits) — must NOT collapse to empty', async () => {
      // Opus 4.x reliably returns `{ "navigate": { "url": … } }` rather than the
      // documented `{ "kind": "navigate", "url": … }`. Reproduced live on prod
      // 2026-07-07: every AI-automation plan silently parsed to ZERO intents (the
      // founder's "AI responds without completing any steps"). normalizeIntentShape
      // must unwrap the verb key so the plan survives.
      const { fetch } = sequenceFetch([
        jsonResponse({
          kind: 'plan',
          intents: [
            { navigate: { url: 'https://example.com' } },
            { wait: { condition: 'idle', timeoutMs: 5000 } },
            { capture: { capture: 'screenshot' } },
          ],
        }),
      ]);
      const res = await new ClaudeAgentDecomposer({ fetch }).decompose(defaultArgs());
      expect(res.kind).toBe('plan');
      if (res.kind !== 'plan') throw new Error('type narrow');
      expect(res.intents).toEqual([
        { kind: 'navigate', url: 'https://example.com' },
        { kind: 'wait', condition: 'idle', timeoutMs: 5000 },
        { kind: 'capture', capture: 'screenshot' },
      ]);
    });

    it('#139 verb-keyed interact + scroll + a bare-verb capture all normalize', async () => {
      const { fetch } = sequenceFetch([
        jsonResponse({
          kind: 'plan',
          intents: [
            { interact: { action: 'tap', selector: '#go' } },
            { scroll: { direction: 'down', amount_px: 400 } },
            { navigate: { url: 'https://x.test' } },
          ],
        }),
      ]);
      const res = await new ClaudeAgentDecomposer({ fetch }).decompose(defaultArgs());
      if (res.kind !== 'plan') throw new Error('type narrow');
      expect(res.intents).toEqual([
        { kind: 'interact', action: 'tap', selector: '#go' },
        { kind: 'scroll', direction: 'down', amount_px: 400 },
        { kind: 'navigate', url: 'https://x.test' },
      ]);
    });

    it('#139 BARE-STRING verb-keyed intents keep executable params and drop incomplete interact', async () => {
      // Review finding: a primitive verb value ({navigate:"url"}, {capture:"screenshot"},
      // {scroll:"down"}) was normalized to {kind:verb} with the param discarded, so
      // parseIntents silently dropped it = "AI does nothing" via a new shape. The
      // primitive must route to the verb's primary param.
      const { fetch } = sequenceFetch([
        jsonResponse({
          kind: 'plan',
          intents: [
            { navigate: 'https://x.test' },
            { scroll: 'down' },
            { interact: 'tap' },
            { capture: 'screenshot' },
          ],
        }),
      ]);
      const res = await new ClaudeAgentDecomposer({ fetch }).decompose(defaultArgs());
      expect(res.kind).toBe('plan');
      if (res.kind !== 'plan') throw new Error('type narrow');
      expect(res.intents).toEqual([
        { kind: 'navigate', url: 'https://x.test' },
        { kind: 'scroll', direction: 'down' },
        { kind: 'capture', capture: 'screenshot' },
      ]);
    });

    it('#139 canonical kind-keyed AND verb-keyed intents coexist in one plan', async () => {
      const { fetch } = sequenceFetch([
        jsonResponse({
          kind: 'plan',
          intents: [
            { kind: 'navigate', url: 'https://a.test' }, // canonical
            { capture: { capture: 'screenshot' } }, // verb-keyed
          ],
        }),
      ]);
      const res = await new ClaudeAgentDecomposer({ fetch }).decompose(defaultArgs());
      if (res.kind !== 'plan') throw new Error('type narrow');
      expect(res.intents).toEqual([
        { kind: 'navigate', url: 'https://a.test' },
        { kind: 'capture', capture: 'screenshot' },
      ]);
    });

    it('W140 parses scroll + behavioral_pause intents (direction required; pause fields optional)', async () => {
      const { fetch } = sequenceFetch([
        jsonResponse({
          kind: 'plan',
          intents: [
            { kind: 'scroll', direction: 'down', amount_px: 800 },
            { kind: 'scroll', direction: 'up' },
            { kind: 'scroll' }, // no direction → dropped
            { kind: 'behavioral_pause', reading_word_count: 120 },
            { kind: 'behavioral_pause', duration_ms: 2500 },
            { kind: 'behavioral_pause' }, // bare → persona idle
          ],
        }),
      ]);
      const res = await new ClaudeAgentDecomposer({ fetch }).decompose(defaultArgs());
      if (res.kind !== 'plan') throw new Error('type narrow');
      expect(res.intents).toEqual([
        { kind: 'scroll', direction: 'down', amount_px: 800 },
        { kind: 'scroll', direction: 'up' },
        { kind: 'behavioral_pause', reading_word_count: 120 },
        { kind: 'behavioral_pause', duration_ms: 2500 },
        { kind: 'behavioral_pause' },
      ]);
    });

    it('clarify response → kind = "clarify" with question', async () => {
      const { fetch } = sequenceFetch([
        jsonResponse({
          kind: 'clarify',
          clarifyingQuestion: 'Which example.com page do you want?',
        }),
      ]);
      const dec = new ClaudeAgentDecomposer({ fetch });
      const res = await dec.decompose(defaultArgs({ task: 'do the thing' }));
      expect(res.kind).toBe('clarify');
      if (res.kind !== 'clarify') throw new Error('type narrow');
      expect(res.clarifyingQuestion).toMatch(/example\.com/);
    });

    it('refuse response → kind = "refuse" with reason', async () => {
      const { fetch } = sequenceFetch([
        jsonResponse({
          kind: 'refuse',
          refuseReason: 'This is prohibited per AUP §3.',
        }),
      ]);
      const dec = new ClaudeAgentDecomposer({ fetch });
      const res = await dec.decompose(
        defaultArgs({ task: 'something that the model itself classifies as refusable' }),
      );
      expect(res.kind).toBe('refuse');
      if (res.kind !== 'refuse') throw new Error('type narrow');
      expect(res.refuseReason).toMatch(/AUP/);
    });

    it('strips markdown code-fence wrapping if the model emitted one despite instructions', async () => {
      const wrapped = new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: '```json\n{"kind":"clarify","clarifyingQuestion":"q?"}\n```',
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200 },
      );
      const { fetch } = sequenceFetch([wrapped]);
      const dec = new ClaudeAgentDecomposer({ fetch });
      const res = await dec.decompose(defaultArgs({ task: 'ambiguous' }));
      expect(res.kind).toBe('clarify');
    });

    it('drops malformed intent items (forward-compat: unknown action verbs ignored)', async () => {
      const { fetch } = sequenceFetch([
        jsonResponse({
          kind: 'plan',
          intents: [
            { kind: 'navigate', url: 'https://example.com' },
            { kind: 'interact', action: 'hover' }, // not in vocab — dropped
            { kind: 'capture', capture: 'dom_snapshot' },
          ],
        }),
      ]);
      const dec = new ClaudeAgentDecomposer({ fetch });
      const res = await dec.decompose(defaultArgs());
      if (res.kind !== 'plan') throw new Error('type narrow');
      expect(res.intents).toHaveLength(2);
      expect(res.intents.map((i) => i.kind)).toEqual(['navigate', 'capture']);
    });

    it('rejects a plan above the eight-entry execution ceiling before any action can run', async () => {
      const intents = Array.from({ length: __TEST_ONLY__.MAX_PLAN_INTENTS + 1 }, () => ({
        kind: 'capture',
        capture: 'screenshot',
      }));
      const { fetch } = sequenceFetch([jsonResponse({ kind: 'plan', intents })]);

      await expect(new ClaudeAgentDecomposer({ fetch }).decompose(defaultArgs())).rejects.toThrow(
        /intents exceeded 8 entries/i,
      );
    });

    it('rejects every recognized over-limit executable field instead of returning a partial plan', async () => {
      const cases: ReadonlyArray<{
        label: string;
        intent: Record<string, unknown>;
        field: string;
        limit: number;
      }> = [
        {
          label: 'navigate URL',
          intent: {
            kind: 'navigate',
            url: `https://x.test/${'x'.repeat(__TEST_ONLY__.MAX_AGENT_URL_CHARS)}`,
          },
          field: 'plan.intents[1].url',
          limit: __TEST_ONLY__.MAX_AGENT_URL_CHARS,
        },
        {
          label: 'tap selector',
          intent: {
            kind: 'interact',
            action: 'tap',
            selector: 'x'.repeat(__TEST_ONLY__.MAX_AGENT_SELECTOR_CHARS + 1),
          },
          field: 'plan.intents[1].selector',
          limit: __TEST_ONLY__.MAX_AGENT_SELECTOR_CHARS,
        },
        {
          label: 'tap visible-text label',
          intent: {
            kind: 'interact',
            action: 'tap',
            selector: '#go',
            value: 'x'.repeat(__TEST_ONLY__.MAX_AGENT_TAP_LABEL_CHARS + 1),
          },
          field: 'plan.intents[1].value',
          limit: __TEST_ONLY__.MAX_AGENT_TAP_LABEL_CHARS,
        },
        {
          label: 'type selector',
          intent: {
            kind: 'interact',
            action: 'type',
            selector: 'x'.repeat(__TEST_ONLY__.MAX_AGENT_SELECTOR_CHARS + 1),
            value: 'ok',
          },
          field: 'plan.intents[1].selector',
          limit: __TEST_ONLY__.MAX_AGENT_SELECTOR_CHARS,
        },
        {
          label: 'type text',
          intent: {
            kind: 'interact',
            action: 'type',
            selector: '#field',
            value: 'x'.repeat(__TEST_ONLY__.MAX_AGENT_TYPED_TEXT_CHARS + 1),
          },
          field: 'plan.intents[1].value',
          limit: __TEST_ONLY__.MAX_AGENT_TYPED_TEXT_CHARS,
        },
        {
          label: 'wait selector',
          intent: {
            kind: 'wait',
            condition: 'selector_visible',
            selector: 'x'.repeat(__TEST_ONLY__.MAX_AGENT_SELECTOR_CHARS + 1),
          },
          field: 'plan.intents[1].selector',
          limit: __TEST_ONLY__.MAX_AGENT_SELECTOR_CHARS,
        },
      ];

      for (const sample of cases) {
        const { fetch } = sequenceFetch([
          jsonResponse({
            kind: 'plan',
            intents: [{ kind: 'capture', capture: 'screenshot' }, sample.intent],
          }),
        ]);
        await expect(
          new ClaudeAgentDecomposer({ fetch }).decompose(defaultArgs()),
          sample.label,
        ).rejects.toThrow(
          `Anthropic response field ${sample.field} exceeded ${sample.limit} characters`,
        );
      }
    });

    it('accepts executable fields exactly at their limits', async () => {
      const urlPrefix = 'https://x.test/';
      const url = `${urlPrefix}${'x'.repeat(__TEST_ONLY__.MAX_AGENT_URL_CHARS - urlPrefix.length)}`;
      const selector = 'x'.repeat(__TEST_ONLY__.MAX_AGENT_SELECTOR_CHARS);
      const typedText = 'x'.repeat(__TEST_ONLY__.MAX_AGENT_TYPED_TEXT_CHARS);
      const tapLabel = 'x'.repeat(__TEST_ONLY__.MAX_AGENT_TAP_LABEL_CHARS);
      const { fetch } = sequenceFetch([
        jsonResponse({
          kind: 'plan',
          intents: [
            { kind: 'navigate', url },
            { kind: 'interact', action: 'tap', selector, value: tapLabel },
            { kind: 'interact', action: 'type', selector, value: typedText },
            { kind: 'wait', condition: 'selector_visible', selector },
          ],
        }),
      ]);

      const result = await new ClaudeAgentDecomposer({ fetch }).decompose(defaultArgs());
      expect(result.kind).toBe('plan');
      if (result.kind !== 'plan') throw new Error('type narrow');
      expect(result.intents).toHaveLength(4);
      expect(result.intents[0]).toEqual({ kind: 'navigate', url });
      expect(result.intents[2]).toEqual({
        kind: 'interact',
        action: 'type',
        selector,
        value: typedText,
      });
    });

    it('bounds customer-visible clarify/refuse copy without truncating it', async () => {
      for (const sample of [
        { kind: 'clarify', key: 'clarifyingQuestion' },
        { kind: 'refuse', key: 'refuseReason' },
      ] as const) {
        const atLimit = 'x'.repeat(__TEST_ONLY__.MAX_AGENT_CUSTOMER_COPY_CHARS);
        const accepted = sequenceFetch([
          jsonResponse({ kind: sample.kind, [sample.key]: atLimit }),
        ]);
        const result = await new ClaudeAgentDecomposer({ fetch: accepted.fetch }).decompose(
          defaultArgs({ task: 'ambiguous but safe' }),
        );
        expect(result.kind).toBe(sample.kind);

        const rejected = sequenceFetch([
          jsonResponse({ kind: sample.kind, [sample.key]: `${atLimit}x` }),
        ]);
        await expect(
          new ClaudeAgentDecomposer({ fetch: rejected.fetch }).decompose(
            defaultArgs({ task: 'ambiguous but safe' }),
          ),
        ).rejects.toThrow(
          `Anthropic response field ${sample.key} exceeded ${__TEST_ONLY__.MAX_AGENT_CUSTOMER_COPY_CHARS} characters`,
        );
      }
    });

    it('preserves boolean sensitive typing and drops spoof string values', async () => {
      const { fetch } = sequenceFetch([
        jsonResponse({
          kind: 'plan',
          intents: [
            {
              kind: 'interact',
              action: 'type',
              selector: '#otp',
              value: '123456',
              sensitive: true,
            },
            {
              kind: 'interact',
              action: 'type',
              selector: '#name',
              value: 'Ada',
              sensitive: 'true',
            },
            {
              kind: 'interact',
              action: 'type',
              selector: '#password',
              value: 'secret',
              sensitive: false,
            },
            {
              kind: 'interact',
              action: 'type',
              selector: '#display-name',
              value: 'Grace',
              sensitive: false,
            },
          ],
        }),
      ]);
      const res = await new ClaudeAgentDecomposer({ fetch }).decompose(defaultArgs());
      if (res.kind !== 'plan') throw new Error('type narrow');
      expect(res.intents).toEqual([
        { kind: 'interact', action: 'type', selector: '#otp', value: '123456', sensitive: true },
        { kind: 'interact', action: 'type', selector: '#name', value: 'Ada' },
        {
          kind: 'interact',
          action: 'type',
          selector: '#password',
          value: 'secret',
          sensitive: true,
        },
        {
          kind: 'interact',
          action: 'type',
          selector: '#display-name',
          value: 'Grace',
          sensitive: false,
        },
      ]);
    });

    it('drops interact actions missing live-dispatch requirements', async () => {
      const { fetch } = sequenceFetch([
        jsonResponse({
          kind: 'plan',
          intents: [
            { kind: 'interact', action: 'tap' },
            { kind: 'interact', action: 'tap', selector: '' },
            { kind: 'interact', action: 'type', selector: '#name' },
            { kind: 'interact', action: 'type', value: 'Ada' },
            { kind: 'interact', action: 'press' },
            { kind: 'interact', action: 'press', value: '' },
            { kind: 'interact', action: 'press', value: 'x'.repeat(21) },
            { kind: 'interact', action: 'tap', selector: '#go' },
          ],
        }),
        jsonResponse({
          kind: 'plan',
          intents: [
            { kind: 'interact', action: 'type', selector: '#name', value: '' },
            { kind: 'interact', action: 'scroll', selector: '#ignored', value: 'ignored' },
            { kind: 'interact', action: 'press', value: 'Enter' },
          ],
        }),
      ]);
      const dec = new ClaudeAgentDecomposer({ fetch });
      const first = await dec.decompose(defaultArgs());
      const second = await dec.decompose(defaultArgs());
      if (first.kind !== 'plan' || second.kind !== 'plan') throw new Error('type narrow');
      expect([...first.intents, ...second.intents]).toEqual([
        { kind: 'interact', action: 'tap', selector: '#go' },
        { kind: 'interact', action: 'type', selector: '#name', value: '' },
        { kind: 'interact', action: 'scroll' },
        { kind: 'interact', action: 'press', value: 'Enter' },
      ]);
    });

    it('preserves a tap visible label for the consequential-action confirmation gate', async () => {
      const { fetch } = sequenceFetch([
        jsonResponse({
          kind: 'plan',
          intents: [{ kind: 'interact', action: 'tap', selector: '#submit', value: 'Buy Now' }],
        }),
      ]);
      const res = await new ClaudeAgentDecomposer({ fetch }).decompose(defaultArgs());
      if (res.kind !== 'plan') throw new Error('type narrow');
      expect(res.intents).toEqual([
        { kind: 'interact', action: 'tap', selector: '#submit', value: 'Buy Now' },
      ]);
      expect(classifyConsequentialAction(res.intents[0]!).category).toBe('purchase');
    });

    it('drops non-HTTP navigation and selector-visible waits without a target', async () => {
      const { fetch } = sequenceFetch([
        jsonResponse({
          kind: 'plan',
          intents: [
            { kind: 'navigate', url: '/relative' },
            { kind: 'navigate', url: 'file:///etc/passwd' },
            { kind: 'navigate', url: 'javascript:alert(1)' },
            { kind: 'navigate', url: 'https://example.com/path' },
            { kind: 'wait', condition: 'selector_visible' },
            { kind: 'wait', condition: 'selector_visible', selector: '' },
            { kind: 'wait', condition: 'selector_visible', selector: '#ready', timeoutMs: 2500 },
            { kind: 'wait', condition: 'idle', selector: '#irrelevant', timeoutMs: 500 },
          ],
        }),
      ]);
      const res = await new ClaudeAgentDecomposer({ fetch }).decompose(defaultArgs());
      if (res.kind !== 'plan') throw new Error('type narrow');
      expect(res.intents).toEqual([
        { kind: 'navigate', url: 'https://example.com/path' },
        { kind: 'wait', condition: 'selector_visible', selector: '#ready', timeoutMs: 2500 },
        { kind: 'wait', condition: 'idle', timeoutMs: 500 },
      ]);
    });

    it('drops model swipe intents because the live harness mapper cannot execute them', async () => {
      const { fetch } = sequenceFetch([
        jsonResponse({
          kind: 'plan',
          intents: [
            { kind: 'interact', action: 'swipe', value: 'up' },
            { kind: 'scroll', direction: 'down', amount_px: 600 },
          ],
        }),
      ]);
      const res = await new ClaudeAgentDecomposer({ fetch }).decompose(defaultArgs());
      if (res.kind !== 'plan') throw new Error('type narrow');
      expect(res.intents).toEqual([{ kind: 'scroll', direction: 'down', amount_px: 600 }]);
    });

    it('drops model PDF capture because the live harness mapper cannot execute it', async () => {
      const { fetch } = sequenceFetch([
        jsonResponse({
          kind: 'plan',
          intents: [
            { kind: 'capture', capture: 'pdf' },
            { kind: 'capture', capture: 'screenshot' },
            { kind: 'capture', capture: 'dom_snapshot' },
          ],
        }),
      ]);
      const res = await new ClaudeAgentDecomposer({ fetch }).decompose(defaultArgs());
      if (res.kind !== 'plan') throw new Error('type narrow');
      expect(res.intents).toEqual([
        { kind: 'capture', capture: 'screenshot' },
        { kind: 'capture', capture: 'dom_snapshot' },
      ]);
    });

    it('drops invalid model numeric options before the dispatch contract', async () => {
      const { fetch } = sequenceFetch([
        jsonResponse({
          kind: 'plan',
          intents: [
            { kind: 'wait', condition: 'idle', timeoutMs: -1 },
            { kind: 'scroll', direction: 'down', amount_px: 12.5 },
            { kind: 'behavioral_pause', duration_ms: Number.MAX_SAFE_INTEGER + 1 },
            { kind: 'behavioral_pause', reading_word_count: -2 },
            { kind: 'scroll', direction: 'up', amount_px: 800 },
            { kind: 'behavioral_pause', duration_ms: 1500, reading_word_count: 120 },
          ],
        }),
      ]);
      const res = await new ClaudeAgentDecomposer({ fetch }).decompose(defaultArgs());
      if (res.kind !== 'plan') throw new Error('type narrow');
      expect(res.intents).toEqual([
        { kind: 'wait', condition: 'idle' },
        { kind: 'scroll', direction: 'down' },
        { kind: 'behavioral_pause' },
        { kind: 'behavioral_pause' },
        { kind: 'scroll', direction: 'up', amount_px: 800 },
        { kind: 'behavioral_pause', duration_ms: 1500, reading_word_count: 120 },
      ]);
    });
  });

  describe('retry + error handling', () => {
    it('5xx → single retry → success', async () => {
      const { fetch, calls } = sequenceFetch([
        errorResponse(503),
        jsonResponse({ kind: 'clarify', clarifyingQuestion: 'q?' }),
      ]);
      const dec = new ClaudeAgentDecomposer({ fetch, retryBackoffMs: 0 });
      const res = await dec.decompose(defaultArgs({ task: 'ambiguous' }));
      expect(res.kind).toBe('clarify');
      expect(calls).toHaveLength(2);
    });

    it('5xx → 5xx → throws (only ONE retry)', async () => {
      const { fetch, calls } = sequenceFetch([
        errorResponse(500, 'first 500'),
        errorResponse(502, 'second 502'),
      ]);
      const dec = new ClaudeAgentDecomposer({ fetch, retryBackoffMs: 0 });
      await expect(dec.decompose(defaultArgs())).rejects.toThrow(/Anthropic API 502/);
      expect(calls).toHaveLength(2);
    });

    it('4xx → throws immediately (no retry — likely auth or quota)', async () => {
      const { fetch, calls } = sequenceFetch([errorResponse(401, 'invalid api key')]);
      const dec = new ClaudeAgentDecomposer({ fetch, retryBackoffMs: 0 });
      await expect(dec.decompose(defaultArgs())).rejects.toThrow(/Anthropic API 401/);
      expect(calls).toHaveLength(1);
    });

    it('network error → retry once → success', async () => {
      const { fetch, calls } = sequenceFetch([
        new Error('ECONNRESET'),
        jsonResponse({ kind: 'clarify', clarifyingQuestion: 'q?' }),
      ]);
      const dec = new ClaudeAgentDecomposer({ fetch, retryBackoffMs: 0 });
      const res = await dec.decompose(defaultArgs({ task: 'ambiguous' }));
      expect(res.kind).toBe('clarify');
      expect(calls).toHaveLength(2);
    });

    it('network error → network error → throws', async () => {
      const { fetch, calls } = sequenceFetch([new Error('ECONNRESET'), new Error('ECONNRESET')]);
      const dec = new ClaudeAgentDecomposer({ fetch, retryBackoffMs: 0 });
      await expect(dec.decompose(defaultArgs())).rejects.toThrow(/ECONNRESET/);
      expect(calls).toHaveLength(2);
    });

    it('hung request → per-request timeout aborts it → retries then throws (no indefinite hang)', async () => {
      // A fetch that never resolves on its own but rejects when the request's
      // AbortSignal fires — models a hung upstream (open connection, no
      // response) that the per-request timeout must abort. Without the timeout
      // the decompose() would hang forever (a hang is not a 5xx or a thrown
      // network error, so the retry never fires).
      const seenSignals: boolean[] = [];
      const hangingFetch = ((_url: string | URL, init?: RequestInit) => {
        seenSignals.push(init?.signal instanceof AbortSignal);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          });
        });
      }) as unknown as typeof globalThis.fetch;

      const dec = new ClaudeAgentDecomposer({
        fetch: hangingFetch,
        retryBackoffMs: 0,
        requestTimeoutMs: 5,
      });
      await expect(dec.decompose(defaultArgs())).rejects.toThrow(/abort/i);
      // The timeout was wired on EVERY attempt (initial + the one retry).
      expect(seenSignals.length).toBe(2);
      expect(seenSignals.every(Boolean)).toBe(true);
    });

    it('hung response BODY → timeout error propagates into the one retry (not swallowed as malformed JSON)', async () => {
      const seenSignals: boolean[] = [];
      const hangingBodyFetch = ((_url: string | URL, init?: RequestInit) => {
        const signal = init?.signal;
        seenSignals.push(signal instanceof AbortSignal);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener('abort', () => {
              controller.error(
                Object.assign(new Error('The response body was aborted'), { name: 'AbortError' }),
              );
            });
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      }) as unknown as typeof globalThis.fetch;
      const dec = new ClaudeAgentDecomposer({
        fetch: hangingBodyFetch,
        retryBackoffMs: 0,
        requestTimeoutMs: 5,
      });

      await expect(dec.decompose(defaultArgs())).rejects.toThrow(/body was aborted/i);
      expect(seenSignals).toEqual([true, true]);
    });

    it('rejects oversized Content-Length before reading and without retry', async () => {
      expect(__TEST_ONLY__.MAX_ANTHROPIC_RESPONSE_BYTES).toBe(64 * 1024);
      const response = new Response('tiny', {
        status: 200,
        headers: {
          'content-length': String(__TEST_ONLY__.MAX_ANTHROPIC_RESPONSE_BYTES + 1),
        },
      });
      const { fetch, calls } = sequenceFetch([response]);
      const dec = new ClaudeAgentDecomposer({ fetch, retryBackoffMs: 0 });

      await expect(dec.decompose(defaultArgs())).rejects.toThrow(/response body exceeded/i);
      expect(calls).toHaveLength(1);
    });

    it('cancels a chunked body on the first over-cap chunk and does not retry', async () => {
      let cancellations = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(__TEST_ONLY__.MAX_ANTHROPIC_RESPONSE_BYTES + 1));
        },
        cancel() {
          cancellations += 1;
        },
      });
      const { fetch, calls } = sequenceFetch([new Response(body, { status: 200 })]);
      const dec = new ClaudeAgentDecomposer({ fetch, retryBackoffMs: 0 });

      await expect(dec.decompose(defaultArgs())).rejects.toThrow(/response body exceeded/i);
      expect(calls).toHaveLength(1);
      expect(cancellations).toBe(1);
    });
  });

  describe('malformed responses', () => {
    function jsonRaw(raw: unknown) {
      return new Response(JSON.stringify(raw), { status: 200 });
    }

    it('missing text content block → throws', async () => {
      const { fetch } = sequenceFetch([jsonRaw({ content: [{ type: 'tool_use' }], usage: {} })]);
      const dec = new ClaudeAgentDecomposer({ fetch });
      await expect(dec.decompose(defaultArgs())).rejects.toThrow(/missing text content/);
    });

    it('rejects malformed top-level and content envelopes with stable protocol errors', async () => {
      const topLevel = new ClaudeAgentDecomposer({ fetch: sequenceFetch([jsonRaw(null)]).fetch });
      await expect(topLevel.decompose(defaultArgs())).rejects.toThrow(/envelope was not/i);

      const content = new ClaudeAgentDecomposer({
        fetch: sequenceFetch([
          jsonRaw({ content: {}, usage: { input_tokens: 1, output_tokens: 1 } }),
        ]).fetch,
      });
      await expect(content.decompose(defaultArgs())).rejects.toThrow(/content was not an array/i);
    });

    it('rejects missing, negative, fractional, string, and unsafe Anthropic token usage', async () => {
      const invalidUsage: unknown[] = [
        undefined,
        null,
        {},
        { input_tokens: -1, output_tokens: 1 },
        { input_tokens: 1.5, output_tokens: 1 },
        { input_tokens: '1', output_tokens: 1 },
        { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
      ];
      for (const usage of invalidUsage) {
        const envelope = {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                kind: 'plan',
                intents: [{ kind: 'capture', capture: 'screenshot' }],
              }),
            },
          ],
          ...(usage !== undefined ? { usage } : {}),
        };
        const dec = new ClaudeAgentDecomposer({ fetch: sequenceFetch([jsonRaw(envelope)]).fetch });
        await expect(dec.decompose(defaultArgs())).rejects.toThrow(/usage was missing or invalid/i);
      }
    });

    it('non-JSON text → throws', async () => {
      const { fetch } = sequenceFetch([
        jsonRaw({
          content: [{ type: 'text', text: 'I will not output JSON.' }],
          usage: {},
        }),
      ]);
      const dec = new ClaudeAgentDecomposer({ fetch });
      await expect(dec.decompose(defaultArgs())).rejects.toThrow(/not valid JSON/);
    });

    it('unknown kind → throws', async () => {
      const { fetch } = sequenceFetch([jsonResponse({ kind: 'mystery', data: 1 })]);
      const dec = new ClaudeAgentDecomposer({ fetch });
      await expect(dec.decompose(defaultArgs())).rejects.toThrow(/unknown kind: mystery/);
    });

    it('plan with non-array intents → throws', async () => {
      const { fetch } = sequenceFetch([jsonResponse({ kind: 'plan', intents: 'not-an-array' })]);
      const dec = new ClaudeAgentDecomposer({ fetch });
      await expect(dec.decompose(defaultArgs())).rejects.toThrow(/intents was not an array/);
    });

    it('clarify without clarifyingQuestion → throws', async () => {
      const { fetch } = sequenceFetch([jsonResponse({ kind: 'clarify' })]);
      const dec = new ClaudeAgentDecomposer({ fetch });
      await expect(dec.decompose(defaultArgs())).rejects.toThrow(/missing clarifyingQuestion/);
    });
  });

  describe('request wiring', () => {
    it('sets x-api-key + anthropic-version + content-type headers; uses POST', async () => {
      const { fetch, calls } = sequenceFetch([
        jsonResponse({ kind: 'clarify', clarifyingQuestion: 'q?' }),
      ]);
      const dec = new ClaudeAgentDecomposer({ fetch });
      await dec.decompose(defaultArgs({ task: 'ambiguous', byokAnthropicApiKey: 'sk-ant-zzz' }));
      expect(calls).toHaveLength(1);
      const { url, init } = calls[0]!;
      expect(url).toBe(__TEST_ONLY__.ANTHROPIC_API_URL);
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('sk-ant-zzz');
      expect(headers['anthropic-version']).toBe(__TEST_ONLY__.ANTHROPIC_VERSION_HEADER);
      expect(headers['content-type']).toBe('application/json');
    });

    it('defaults to Claude Opus 4.8 when no model is picked', async () => {
      const { fetch, calls } = sequenceFetch([
        jsonResponse({ kind: 'clarify', clarifyingQuestion: 'q?' }),
      ]);
      const dec = new ClaudeAgentDecomposer({ fetch });
      await dec.decompose(defaultArgs({ task: 'ambiguous' }));
      const body = JSON.parse(calls[0]!.init.body as string) as { model: string };
      expect(body.model).toBe('claude-opus-4-8');
    });

    it('threads the session-picked model (6.c) into the Anthropic request body', async () => {
      const { fetch, calls } = sequenceFetch([
        jsonResponse({ kind: 'clarify', clarifyingQuestion: 'q?' }),
      ]);
      const dec = new ClaudeAgentDecomposer({ fetch });
      await dec.decompose(defaultArgs({ task: 'ambiguous', model: 'claude-haiku-4-5' }));
      const body = JSON.parse(calls[0]!.init.body as string) as { model: string };
      expect(body.model).toBe('claude-haiku-4-5');
    });

    it('threads archetype into the user message + system prompt into request body', async () => {
      const { fetch, calls } = sequenceFetch([
        jsonResponse({ kind: 'clarify', clarifyingQuestion: 'q?' }),
      ]);
      const dec = new ClaudeAgentDecomposer({ fetch });
      await dec.decompose(
        defaultArgs({ task: 'ambiguous', archetype: 'iphone16pro_ios18_7_safari26_4' }),
      );
      const body = JSON.parse(calls[0]!.init.body as string) as {
        system: string;
        messages: ReadonlyArray<{ role: string; content: string }>;
      };
      expect(body.system).toContain('Driftstack agent layer');
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]?.role).toBe('user');
      expect(body.messages[0]?.content).toContain('[archetype: iphone16pro_ios18_7_safari26_4]');
      expect(body.messages[0]?.content).toContain('ambiguous');
    });

    it('preserves human authorship when threading prior transcript history', async () => {
      const { fetch, calls } = sequenceFetch([
        jsonResponse({ kind: 'clarify', clarifyingQuestion: 'q?' }),
      ]);
      const dec = new ClaudeAgentDecomposer({ fetch });
      await dec.decompose(
        defaultArgs({
          task: 'follow-up',
          history: [
            { at: '2026-05-17T10:00:00Z', role: 'user', body: 'first task' },
            { at: '2026-05-17T10:00:05Z', role: 'agent', body: '{"kind":"plan","intents":[]}' },
            {
              at: '2026-05-17T10:00:30Z',
              role: 'operator',
              body: 'continue manually from this page',
            },
            { at: '2026-05-17T10:01:00Z', role: 'user', body: 'follow-up' },
          ],
        }),
      );
      const body = JSON.parse(calls[0]!.init.body as string) as {
        messages: ReadonlyArray<{ role: string; content: string }>;
      };
      // History contains the current task as its last user entry; we
      // don't re-append it.
      expect(body.messages).toHaveLength(4);
      expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user']);
      expect(body.messages[2]?.content).toBe('continue manually from this page');
      expect(body.messages[3]?.content).toContain('[archetype:');
      expect(body.messages[3]?.content).toContain('follow-up');
    });

    it('AUP pre-filter corpus mirrors the deterministic decomposer (same five patterns)', () => {
      // Drift would let an obviously-abusive task slip past one decomposer
      // but not the other — the in-house pre-filter is the contract.
      expect(__TEST_ONLY__.AUP_REFUSAL_PATTERNS).toHaveLength(5);
    });
  });
});

describe('AI-B1.b ClaudeAgentDecomposer — #140 answerFromObservation (read-and-report)', () => {
  const answerArgs = {
    task: 'what is my IP address?',
    observation: 'Your IP: 203.0.113.7 — ISP: Example',
    budgetTokensRemaining: 100_000,
    byokAnthropicApiKey: 'sk-ant-test-fake-key',
  };

  it('answers from the observation → { answer } + tokensConsumed from usage', async () => {
    const { fetch, calls } = sequenceFetch([
      jsonResponse({ kind: 'answer', answer: 'Your IP address is 203.0.113.7.' }),
    ]);
    const dec = new ClaudeAgentDecomposer({ fetch });
    const res = await dec.answerFromObservation(answerArgs);
    expect(res.answer).toBe('Your IP address is 203.0.113.7.');
    expect(res.tokensConsumed).toBe(200); // 120 input + 80 output (jsonResponse default)
    expect(res.usage).toBeDefined();
    expect(calls).toHaveLength(1);
  });

  it('missing API key throws (never fabricates an answer)', async () => {
    const { fetch, calls } = sequenceFetch([]);
    const dec = new ClaudeAgentDecomposer({ fetch });
    await expect(
      dec.answerFromObservation({ ...answerArgs, byokAnthropicApiKey: '' }),
    ).rejects.toThrow(/no Anthropic API key/);
    expect(calls).toHaveLength(0);
  });

  it('blank answer throws → runtime falls back to the plan result, no empty reply', async () => {
    const { fetch } = sequenceFetch([jsonResponse({ kind: 'answer', answer: '   ' })]);
    const dec = new ClaudeAgentDecomposer({ fetch });
    await expect(dec.answerFromObservation(answerArgs)).rejects.toThrow(/missing answer string/);
  });

  it('rejects invalid usage on the read-back path instead of emitting a bad debit', async () => {
    const { fetch } = sequenceFetch([
      jsonResponse(
        { kind: 'answer', answer: 'Your IP address is 203.0.113.7.' },
        { input_tokens: 10, output_tokens: -1 },
      ),
    ]);
    const dec = new ClaudeAgentDecomposer({ fetch });
    await expect(dec.answerFromObservation(answerArgs)).rejects.toThrow(
      /usage was missing or invalid/i,
    );
  });

  it('caps a multi-MB observation so it cannot blow context/cost', async () => {
    const { fetch } = sequenceFetch([jsonResponse({ kind: 'answer', answer: 'ok' })]);
    const dec = new ClaudeAgentDecomposer({ fetch });
    const res = await dec.answerFromObservation({ ...answerArgs, observation: 'x'.repeat(50_000) });
    expect(res.answer).toBe('ok');
  });
});
