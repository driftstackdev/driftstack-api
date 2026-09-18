// A cached prefix is only worth its write if the next call sends the same bytes.
//
// Prompt caching fails SILENTLY. A request whose prefix changed by one byte
// still succeeds, still returns a plan, and simply pays full price — plus the
// write premium, again. Nothing in a response body or a status code says so;
// the only evidence is `cache_read_input_tokens` staying at zero, which needs a
// live key to see. So the properties that decide the hit rate are pinned here,
// on the request the decomposer ACTUALLY serialises:
//
//   1. the static prompt is a marked block, and the conversation has a marker;
//   2. nothing that varies per call sits at or before a marker;
//   3. turn N's marked prefix is, byte for byte, a prefix of turn N+1's request
//      — across many turns, and across the calls of one turn;
//   4. the transcript is bounded, and the bound moves in steps rather than every
//      turn (a window that slides every turn is a cache that never hits);
//   5. the accounting reads the cache fields, streamed and not, and prices a
//      cached token as neither free nor full-price.

import { describe, expect, it } from 'vitest';
import { CLAUDE_MODELS, AgentModelSchema, type AgentModel } from '@driftstack/api-types';
import {
  ClaudeAgentDecomposer,
  __TEST_ONLY__,
} from '../../src/services/agent-decomposer-claude.js';
import {
  AgentDecomposerSettledError,
  type DecomposeArgs,
  type TranscriptEntry,
} from '../../src/services/agent-decomposer.js';
import { runResultToTranscriptEntry } from '../../src/services/agent-executor.js';

const {
  SYSTEM_PROMPT,
  ANSWER_SYSTEM_PROMPT,
  TRANSCRIPT_WINDOW_MAX_ENTRIES,
  TRANSCRIPT_WINDOW_STEP,
  TRANSCRIPT_MIN_TAIL_ENTRIES,
  TRANSCRIPT_WINDOW_MAX_CHARS,
  MAX_HISTORY_AGENT_ENTRY_CHARS,
  buildMessages,
  selectTranscriptWindow,
  renderHistoryEntry,
  makeClaudeUsage,
  parseAnthropicUsage,
  billableTokens,
} = __TEST_ONLY__;

interface WireBlock {
  type: string;
  text: string;
  cache_control?: { type: string; ttl?: string };
}
interface WireMessage {
  role: string;
  content: WireBlock[];
}
interface WireBody {
  model: string;
  max_tokens: number;
  system: WireBlock[] | string;
  messages: WireMessage[];
  stream?: boolean;
}

const ARCHETYPE = 'iphone16pro_ios18_7_safari26_4';

function args(overrides: Partial<DecomposeArgs> = {}): DecomposeArgs {
  return {
    task: 'open the pricing page',
    archetype: ARCHETYPE,
    history: [],
    budgetTokensRemaining: 10_000_000,
    byokAnthropicApiKey: 'test-key-not-a-secret',
    ...overrides,
  };
}

/** A fetch that records every request body and answers with `usage`. */
function recordingFetch(usage: Record<string, unknown> = { input_tokens: 10, output_tokens: 5 }) {
  const bodies: WireBody[] = [];
  const fetchImpl = ((_url: string | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(init?.body as string) as WireBody);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{"kind":"clarify","clarifyingQuestion":"which?"}' }],
          stop_reason: 'end_turn',
          usage,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, bodies };
}

/**
 * The request flattened to the sequence the provider hashes — system blocks,
 * then every message block in order — with the markers REMOVED. A marker says
 * where to cut the prefix; it is not part of the bytes being matched (it moves
 * forward every turn by design), so comparing with it in would fail for a
 * reason that is not a cache miss.
 */
function flatten(body: WireBody): string[] {
  const system = typeof body.system === 'string' ? [`system:${body.system}`] : [];
  if (typeof body.system !== 'string') {
    for (const block of body.system) system.push(`system:${block.text}`);
  }
  const out = [...system];
  for (const message of body.messages) {
    for (const block of message.content) out.push(`${message.role}:${block.text}`);
  }
  return out;
}

/** Index, in `flatten` order, of the LAST block carrying a marker. */
function lastMarkedIndex(body: WireBody): number {
  let index = -1;
  let cursor = 0;
  if (typeof body.system !== 'string') {
    for (const block of body.system) {
      if (block.cache_control !== undefined) index = cursor;
      cursor++;
    }
  } else {
    cursor++;
  }
  for (const message of body.messages) {
    for (const block of message.content) {
      if (block.cache_control !== undefined) index = cursor;
      cursor++;
    }
  }
  return index;
}

function markerCount(body: WireBody): number {
  let count = 0;
  if (typeof body.system !== 'string') {
    for (const block of body.system) if (block.cache_control !== undefined) count++;
  }
  for (const message of body.messages) {
    for (const block of message.content) if (block.cache_control !== undefined) count++;
  }
  return count;
}

/** One realistic turn: the customer's task, then what the executor reported. */
function turnEntries(turn: number): TranscriptEntry[] {
  return [
    {
      at: `2026-09-18T10:${String(turn % 60).padStart(2, '0')}:00Z`,
      role: 'user',
      body: `task number ${turn.toString()}: continue with the next step`,
    },
    {
      at: `2026-09-18T10:${String(turn % 60).padStart(2, '0')}:30Z`,
      role: 'agent',
      body: `✓ navigated to https://example.com/step/${turn.toString()}\n✓ tapped a[href*="next"]\n✓ captured screenshot`,
    },
  ];
}

describe('C1 — the request carries cache breakpoints, and nothing volatile sits inside one', () => {
  it('sends the static prompt as ONE marked block (1-hour) and marks the task block (5-minute)', async () => {
    const { fetchImpl, bodies } = recordingFetch();
    await new ClaudeAgentDecomposer({ fetch: fetchImpl }).decompose(args());
    const body = bodies[0]!;
    expect(body.system).toEqual([
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ]);
    const last = body.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.content[0]).toEqual({
      type: 'text',
      text: 'open the pricing page',
      cache_control: { type: 'ephemeral' },
    });
    // A 1-hour entry must precede every 5-minute one, or the provider rejects
    // the request: system renders first, so this ordering is structural.
    expect(markerCount(body)).toBe(2);
  });

  it('⛔ every per-call value — observation, credential names, prior failure, archetype — lands AFTER the last marker', async () => {
    const { fetchImpl, bodies } = recordingFetch();
    await new ClaudeAgentDecomposer({ fetch: fetchImpl }).decompose(
      args({
        observation: 'OBSERVATION-SENTINEL button#buy',
        credentialRefs: ['CREDENTIAL-SENTINEL'],
        priorFailure: 'FAILURE-SENTINEL tap timed out',
        archetype: 'ARCHETYPE-SENTINEL',
      }),
    );
    const body = bodies[0]!;
    const flat = flatten(body);
    const cut = lastMarkedIndex(body);
    const cachedPrefix = flat.slice(0, cut + 1).join('\n');
    const volatileTail = flat.slice(cut + 1).join('\n');
    for (const sentinel of [
      'OBSERVATION-SENTINEL',
      'CREDENTIAL-SENTINEL',
      'FAILURE-SENTINEL',
      'ARCHETYPE-SENTINEL',
    ]) {
      expect(cachedPrefix, `${sentinel} is inside the cached prefix`).not.toContain(sentinel);
      expect(volatileTail, `${sentinel} was dropped from the request`).toContain(sentinel);
    }
  });

  it('calls 2..4 of ONE turn (a re-plan: new observation, new failure note) resend the marked prefix unchanged', async () => {
    const { fetchImpl, bodies } = recordingFetch();
    const decomposer = new ClaudeAgentDecomposer({ fetch: fetchImpl });
    const history: TranscriptEntry[] = [
      ...turnEntries(1),
      { at: '2026-09-18T11:00:00Z', role: 'user', body: 'now sign up' },
    ];
    await decomposer.decompose(args({ task: 'now sign up', history, observation: 'page A' }));
    await decomposer.decompose(
      args({
        task: 'now sign up',
        history,
        observation: 'page B — different',
        priorFailure: 'step 2 failed: element not found',
      }),
    );
    await decomposer.decompose(
      args({
        task: 'now sign up',
        history,
        observation: 'page C — different again',
        priorFailure: 'step 1 failed: navigation refused',
      }),
    );
    const [first, second, third] = bodies as [WireBody, WireBody, WireBody];
    const cut = lastMarkedIndex(first);
    const prefix = flatten(first).slice(0, cut + 1);
    expect(lastMarkedIndex(second)).toBe(cut);
    expect(flatten(second).slice(0, cut + 1)).toEqual(prefix);
    expect(flatten(third).slice(0, cut + 1)).toEqual(prefix);
    // …and the part that DID change is genuinely after it.
    expect(flatten(second).slice(cut + 1)).not.toEqual(flatten(first).slice(cut + 1));
  });

  it('the read-back call carries NO marker — its prefix is never sent twice, so a write would never be read', async () => {
    const bodies: WireBody[] = [];
    const fetchAnswer = ((_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string) as WireBody);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '{"kind":"answer","answer":"203.0.113.7"}' }],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }) as unknown as typeof globalThis.fetch;
    await new ClaudeAgentDecomposer({ fetch: fetchAnswer }).answerFromObservation({
      task: 'what is my IP?',
      observation: 'Your IP is 203.0.113.7',
      budgetTokensRemaining: 100_000,
      byokAnthropicApiKey: 'test-key-not-a-secret',
    });
    const body = bodies[0]!;
    expect(body.system).toBe(ANSWER_SYSTEM_PROMPT);
    expect(JSON.stringify(body)).not.toContain('cache_control');
    // Its system prompt is under EVERY model's minimum, so a marker there would
    // be a no-op on all of them — the reason is arithmetic, not taste.
    const smallestMinimum = Math.min(
      ...AgentModelSchema.options.map((model) => CLAUDE_MODELS[model].minCacheablePromptTokens),
    );
    expect(Math.ceil(ANSWER_SYSTEM_PROMPT.length / 4)).toBeLessThan(smallestMinimum);
    // Streamed, because its output ceiling now has to hold thinking as well.
    expect(body.stream).toBe(true);
  });

  it('states, per model, how the ESTIMATED static prompt sits against the cacheable minimum — and says where the margin is too thin to call', () => {
    // ⛔ This pins OUR ESTIMATE (chars/4), not a provider fact: nobody has
    // measured the real tokenizer. So it is three-way. `clear` means the estimate
    // beats the minimum by at least a quarter — enough that a tokenizer
    // difference cannot plausibly flip it. `marginal` means it beats it by less,
    // and whether the 1-hour system marker does ANYTHING on that model is for
    // the live eval to settle (`cache_creation_input_tokens > 0` on a cold first
    // call). `below` is the claim most worth pinning: on Haiku 4.5 the system
    // marker is a no-op by itself, and caching starts only once system +
    // conversation pass 4096. A prompt edit that changes this table should be a
    // decision, not a surprise on a bill.
    const estimate = Math.ceil(SYSTEM_PROMPT.length / 4);
    const standing: Record<AgentModel, 'clear' | 'marginal' | 'below'> = {
      'claude-opus-5': 'clear',
      'claude-sonnet-5': 'clear',
      'claude-opus-4-8': 'clear',
      'claude-opus-4-7': 'marginal',
      'claude-sonnet-4-6': 'clear',
      'claude-haiku-4-5': 'below',
    };
    for (const model of AgentModelSchema.options) {
      const minimum = CLAUDE_MODELS[model].minCacheablePromptTokens;
      const measured =
        estimate >= minimum * 1.25 ? 'clear' : estimate >= minimum ? 'marginal' : 'below';
      expect(
        measured,
        `${model}: ~${estimate.toString()} tokens vs minimum ${minimum.toString()}`,
      ).toBe(standing[model]);
    }
  });
});

describe('C3 — the transcript is bounded, and the bound does not fight the cache', () => {
  it("⛔ over 40 consecutive turns, each turn's marked prefix is a byte-identical prefix of the next turn's request — except at a window step", () => {
    const history: TranscriptEntry[] = [];
    const requests: WireBody[] = [];
    for (let turn = 1; turn <= 40; turn++) {
      const [task, result] = turnEntries(turn) as [TranscriptEntry, TranscriptEntry];
      history.push(task);
      requests.push({
        model: 'x',
        max_tokens: 1,
        system: [{ type: 'text', text: SYSTEM_PROMPT }],
        messages: buildMessages(args({ task: task.body, history: [...history] })),
      });
      history.push(result);
    }
    let breaks = 0;
    let longestStableRun = 0;
    let run = 0;
    for (let i = 0; i + 1 < requests.length; i++) {
      const cut = lastMarkedIndex(requests[i]!);
      const prefix = flatten(requests[i]!).slice(0, cut + 1);
      const next = flatten(requests[i + 1]!).slice(0, cut + 1);
      if (JSON.stringify(prefix) === JSON.stringify(next)) {
        run++;
        longestStableRun = Math.max(longestStableRun, run);
      } else {
        breaks++;
        run = 0;
      }
    }
    // 40 turns = 80 entries. The window (48) first overflows at entry 49 and
    // then steps by 16 entries = 8 turns, so: a few breaks, each followed by a
    // long stable run. A window that slid every turn would score ~28 breaks.
    expect(breaks).toBeGreaterThanOrEqual(1);
    expect(breaks).toBeLessThanOrEqual(3);
    expect(longestStableRun).toBeGreaterThanOrEqual(7);
    // Every request stayed bounded, and the first stayed whole.
    for (const request of requests) {
      expect(request.messages.length).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_MAX_ENTRIES + 2);
    }
  });

  it('the window start only ever takes multiples of the step, and never moves backwards', () => {
    const history: TranscriptEntry[] = [];
    let previousStart = 0;
    const starts = new Set<number>();
    for (let turn = 1; turn <= 120; turn++) {
      history.push(...turnEntries(turn));
      const window = selectTranscriptWindow(history);
      const start = history.length - window.entries.length;
      expect(start % TRANSCRIPT_WINDOW_STEP).toBe(0);
      expect(start).toBeGreaterThanOrEqual(previousStart);
      expect(window.entries.length).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_MAX_ENTRIES);
      expect(window.entries.length).toBeGreaterThanOrEqual(
        Math.min(history.length, TRANSCRIPT_MIN_TAIL_ENTRIES),
      );
      previousStart = start;
      starts.add(start);
    }
    // 240 entries visited far more than one start, i.e. the bound is real…
    expect(starts.size).toBeGreaterThan(5);
    // …and far fewer than one per turn, i.e. it is stepped.
    expect(starts.size).toBeLessThan(20);
  });

  it('keeps the ORIGINAL task and says how much was left out', () => {
    const history: TranscriptEntry[] = [
      { at: '2026-09-18T09:00:00Z', role: 'user', body: 'ORIGINAL: book a table for two at Nopi' },
    ];
    for (let turn = 1; turn <= 40; turn++) history.push(...turnEntries(turn));
    history.push({ at: '2026-09-18T12:00:00Z', role: 'user', body: 'continue' });
    const messages: WireMessage[] = buildMessages(args({ task: 'continue', history }));
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content[0]!.text).toBe('ORIGINAL: book a table for two at Nopi');
    const window = selectTranscriptWindow(history);
    const omitted = history.length - window.entries.length - 1;
    expect(omitted).toBeGreaterThan(0);
    expect(messages[0]!.content[1]!.text).toContain(`${omitted.toString()} earlier messages`);
    expect(messages.at(-1)!.content[0]!.text).toBe('continue');
  });

  // ⛔ What the tail protects is the MODEL'S VIEW. An approval resume itself is
  // rebuilt by the runtime from its own full transcript and never passes through
  // this window; but when that resume fails closed the turn is re-planned, and a
  // model that cannot see "paused, awaiting confirmation" plans a bare "yes, go
  // ahead" with nothing to attach it to.
  //
  // Every length here is a HEAVY session (each entry alone is a fifth of the
  // size bound, so even the bare 8-entry tail is over it), so the window is pushed as far forward as the tail allows. 33
  // and 49 are one past a step boundary — the lengths at which a tail of 1 would
  // leave a window of ONE entry and drop the paused one.
  it.each([32, 33, 40, 49])(
    "⛔ keeps the paused-for-approval entry in the model's view on a heavy %i-entry session, where the size bound alone would cut it",
    (n) => {
      const huge = 'x'.repeat(20_000);
      const history: TranscriptEntry[] = [];
      for (let i = 0; i < n - 2; i++) {
        history.push({ at: '2026-09-18T09:00:00Z', role: 'user', body: `${i.toString()} ${huge}` });
      }
      const paused: TranscriptEntry = {
        at: '2026-09-18T09:30:00Z',
        role: 'agent',
        body: '⏸ interact — confirmation required (purchase: "Buy now")\n(plan paused — awaiting your confirmation of a consequential action)',
        awaitingConfirmation: true,
      };
      history.push(paused, { at: '2026-09-18T09:31:00Z', role: 'user', body: 'yes, go ahead' });
      expect(history).toHaveLength(n);

      const window = selectTranscriptWindow(history);
      // The furthest step that still leaves the whole tail — stated exactly, so a
      // smaller tail (a later start) and a sliding start both fail here.
      const expectedStart =
        Math.floor((n - TRANSCRIPT_MIN_TAIL_ENTRIES) / TRANSCRIPT_WINDOW_STEP) *
        TRANSCRIPT_WINDOW_STEP;
      expect(n - window.entries.length).toBe(expectedStart);
      expect(window.entries.length).toBeGreaterThanOrEqual(TRANSCRIPT_MIN_TAIL_ENTRIES);
      expect(window.entries).toContain(paused);
      // The size bound was reached for and could not be met without cutting into
      // the protected tail — so it IS exceeded, which is what makes this the case
      // where only the tail rule is holding the entry in.
      const total = window.entries.reduce((sum, entry) => sum + entry.body.length, 0);
      expect(total).toBeGreaterThan(TRANSCRIPT_WINDOW_MAX_CHARS);

      const sent: WireMessage[] = buildMessages(args({ task: 'yes, go ahead', history }));
      expect(sent.some((message) => message.content.some((b) => b.text === paused.body))).toBe(
        true,
      );
    },
  );

  it('a REAL executor result entry is small and passes through untouched; only a pathological one is compacted', () => {
    const real = runResultToTranscriptEntry(
      {
        ok: true,
        results: [
          {
            kind: 'success',
            intent: { kind: 'navigate', url: 'https://www.example-shop.com/account/register' },
            summary: 'navigated to https://www.example-shop.com/account/register',
          },
          {
            kind: 'success',
            intent: { kind: 'wait', condition: 'selector_visible', selector: 'form#register' },
            summary: 'condition met: form#register visible',
          },
          {
            kind: 'success',
            intent: { kind: 'behavioral_pause', reading_word_count: 60 },
            summary: 'paused to read ~60 words',
          },
          {
            kind: 'success',
            intent: {
              kind: 'interact',
              action: 'type',
              selector: 'input[name="email"]',
              value: 'a',
            },
            summary: 'typed into input[name="email"]',
          },
          {
            kind: 'success',
            intent: {
              kind: 'interact',
              action: 'type',
              selector: 'input[name="password"]',
              value: 'b',
            },
            summary: 'typed into input[name="password"]',
          },
          {
            kind: 'success',
            intent: { kind: 'scroll', direction: 'down', amount_px: 400 },
            summary: 'scrolled down 400px',
          },
          {
            kind: 'success',
            intent: {
              kind: 'interact',
              action: 'tap',
              selector: 'button[type="submit"]',
              value: 'Create account',
            },
            summary: 'tapped button[type="submit"]',
          },
          {
            kind: 'success',
            intent: { kind: 'capture', capture: 'screenshot' },
            summary: 'captured screenshot',
          },
        ],
      } as unknown as Parameters<typeof runResultToTranscriptEntry>[0],
      '2026-09-18T10:00:00Z',
    );
    // MEASURED: an eight-step result body is a few hundred characters.
    expect(real.body.length).toBeGreaterThan(200);
    expect(real.body.length).toBeLessThan(500);
    expect(renderHistoryEntry(real)).toBe(real.body);

    const lines: string[] = [];
    for (let i = 0; i < 24; i++)
      lines.push(`✓ tapped ${'div > '.repeat(90)}a.step-${i.toString()}`);
    lines.push('✗ interact — element not found: #buy');
    lines.push('(plan halted on failure)');
    const pathological: TranscriptEntry = { at: real.at, role: 'agent', body: lines.join('\n') };
    expect(pathological.body.length).toBeGreaterThan(10_000);
    const rendered = renderHistoryEntry(pathological);
    expect(rendered.length).toBeLessThanOrEqual(MAX_HISTORY_AGENT_ENTRY_CHARS);
    // The lines the NEXT plan needs are the last ones, and they survive.
    expect(rendered).toContain('✗ interact — element not found: #buy');
    expect(rendered.endsWith('(plan halted on failure)')).toBe(true);
    expect(rendered).toMatch(/… \(\d+ lines omitted\) …/);
    // A pure function of the entry: the same entry renders the same way however
    // old it is, or compaction itself would be a prefix change.
    expect(renderHistoryEntry(pathological)).toBe(rendered);
  });

  it('never shortens a CUSTOMER entry, and never sends an empty block', () => {
    const long: TranscriptEntry = { at: 'x', role: 'user', body: 'y'.repeat(7_900) };
    expect(renderHistoryEntry(long)).toBe(long.body);
    expect(renderHistoryEntry({ at: 'x', role: 'agent', body: '' })).toBe('(no output)');
    expect(renderHistoryEntry({ at: 'x', role: 'agent', body: '  \n ' })).toBe('(no output)');
  });

  it('drops stepping-stone markers across a long run of operator entries', () => {
    const history: TranscriptEntry[] = [...turnEntries(1)];
    for (let i = 0; i < 40; i++) {
      history.push({ at: 'x', role: 'operator', body: `manual step ${i.toString()}` });
    }
    history.push({ at: 'x', role: 'user', body: 'take over again' });
    const messages: WireMessage[] = buildMessages(args({ task: 'take over again', history }));
    const marked = messages
      .map((message, index) => (message.content.some((b) => b.cache_control) ? index : -1))
      .filter((index) => index !== -1);
    // Two stepping stones + the task; with the system marker that is four.
    expect(marked).toHaveLength(3);
    expect(marked.at(-1)).toBe(messages.length - 1);
    for (let i = 1; i < marked.length; i++) {
      expect(marked[i]! - marked[i - 1]!).toBeLessThanOrEqual(20);
    }
    // A normal turn needs none.
    const normal: WireMessage[] = buildMessages(
      args({ task: 'next', history: [...turnEntries(1), { at: 'x', role: 'user', body: 'next' }] }),
    );
    expect(normal.filter((m) => m.content.some((b) => b.cache_control))).toHaveLength(1);
  });

  it('⛔ never sends a FIFTH marker, even when a third stepping stone would fit — the provider rejects the whole request', async () => {
    // The customer's task, 46 manual steps, then the customer again: 48 entries,
    // the most the window holds, and the one shape in which THREE stones fit
    // between the two customer entries (at 15, 30 and 45 messages back). With
    // the system and task markers that would be five, and a request over the
    // limit of four is a 400 on every call of the turn — a session that a long
    // manual stretch has made permanently unplannable.
    const history: TranscriptEntry[] = [{ at: 'x', role: 'user', body: 'log in and export it' }];
    for (let i = 0; i < 46; i++) {
      history.push({ at: 'x', role: 'operator', body: `manual step ${i.toString()}` });
    }
    history.push({ at: 'x', role: 'user', body: 'take over again' });
    expect(history).toHaveLength(TRANSCRIPT_WINDOW_MAX_ENTRIES);
    const { fetchImpl, bodies } = recordingFetch();
    await new ClaudeAgentDecomposer({ fetch: fetchImpl }).decompose(
      args({ task: 'take over again', history }),
    );
    const body = bodies[0]!;
    // Nothing was windowed away, so the gap really is 46 messages wide…
    expect(body.messages).toHaveLength(TRANSCRIPT_WINDOW_MAX_ENTRIES);
    // …and the count is taken on the SERIALIZED request, system marker included.
    expect(markerCount(body)).toBe(4);
  });

  it('the size pre-check estimates what is SENT, not the whole transcript', async () => {
    const history: TranscriptEntry[] = [];
    // 120 maximum-length (8,000-char) customer messages: ~960k chars, an
    // estimated ~240k tokens. Counted whole, that is refused outright against a
    // 100k budget; what is actually SENT is the window (~80k chars, ~20k tokens).
    for (let i = 0; i < 120; i++) {
      history.push({ at: 'x', role: 'user', body: `${i.toString()} ${'z'.repeat(7_990)}` });
    }
    history.push({ at: 'x', role: 'user', body: 'go' });
    const { fetchImpl, bodies } = recordingFetch();
    const result = await new ClaudeAgentDecomposer({ fetch: fetchImpl }).decompose(
      args({ task: 'go', history, budgetTokensRemaining: 100_000 }),
    );
    expect(result.kind).toBe('clarify');
    expect(bodies).toHaveLength(1);
  });
});

describe('C2 — the accounting reads the cache and prices it as neither free nor full', () => {
  const CACHED_USAGE = {
    input_tokens: 40,
    output_tokens: 200,
    cache_creation_input_tokens: 300,
    cache_read_input_tokens: 9_000,
    cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 },
    output_tokens_details: { thinking_tokens: 120 },
  };

  it('carries every cache field from a BUFFERED envelope onto the usage object', async () => {
    const { fetchImpl } = recordingFetch(CACHED_USAGE);
    const result = await new ClaudeAgentDecomposer({ fetch: fetchImpl }).decompose(args());
    expect(result.usage).toMatchObject({
      anthropicInputTokens: 40,
      anthropicOutputTokens: 200,
      anthropicCacheCreationInputTokens: 300,
      anthropicCacheReadInputTokens: 9_000,
      anthropicCacheCreation5mInputTokens: 300,
      anthropicCacheCreation1hInputTokens: 0,
      anthropicPromptTokens: 9_340,
      anthropicThinkingTokens: 120,
      anthropicStopReason: 'end_turn',
    });
  });

  it('carries them from a STREAM too — and the last cumulative frame wins for every field', async () => {
    const frames = [
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 40,
            output_tokens: 1,
            cache_creation_input_tokens: 300,
            cache_read_input_tokens: 9_000,
            cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 },
          },
        },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: '{"kind":"clarify","clarifyingQuestion":"which?"}' },
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        // Restated, and one of them CHANGED — as the provider's own streaming
        // examples show when the input side moves mid-message.
        usage: {
          input_tokens: 55,
          output_tokens: 200,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 9_000,
          output_tokens_details: { thinking_tokens: 120 },
        },
      },
      { type: 'message_stop' },
    ];
    const encoder = new TextEncoder();
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const frame of frames) {
                controller.enqueue(
                  encoder.encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`),
                );
              }
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      )) as unknown as typeof globalThis.fetch;
    const result = await new ClaudeAgentDecomposer({ fetch: fetchImpl }).decompose(args());
    expect(result.usage).toMatchObject({
      anthropicInputTokens: 55,
      anthropicOutputTokens: 200,
      anthropicCacheCreationInputTokens: 300,
      anthropicCacheReadInputTokens: 9_000,
      anthropicCacheCreation5mInputTokens: 300,
      anthropicPromptTokens: 9_355,
      anthropicThinkingTokens: 120,
      anthropicStopReason: 'end_turn',
    });
  });

  it('⛔ a NULL on a later stream frame never erases the count an earlier frame reported', async () => {
    // `null` is how the provider spells "nothing to say about this field here",
    // and the final `message_delta` may carry it for the whole input side. Merged
    // as a value it turns this cached call into an uncached one (debit 240, not
    // 1,515) — or, for `input_tokens`, into a thrown validation error and a paid
    // call with no usage row at all.
    const frames = [
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 40,
            output_tokens: 1,
            cache_creation_input_tokens: 300,
            cache_read_input_tokens: 9_000,
            cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 },
          },
        },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: '{"kind":"clarify","clarifyingQuestion":"which?"}' },
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          input_tokens: null,
          output_tokens: 200,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          cache_creation: { ephemeral_5m_input_tokens: null, ephemeral_1h_input_tokens: null },
        },
      },
      { type: 'message_stop' },
    ];
    const encoder = new TextEncoder();
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const frame of frames) {
                controller.enqueue(
                  encoder.encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`),
                );
              }
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      )) as unknown as typeof globalThis.fetch;
    const result = await new ClaudeAgentDecomposer({ fetch: fetchImpl }).decompose(args());
    expect(result.usage).toMatchObject({
      anthropicInputTokens: 40,
      anthropicOutputTokens: 200,
      anthropicCacheCreationInputTokens: 300,
      anthropicCacheReadInputTokens: 9_000,
      // The split survived too, so the write is still priced as the 5-minute
      // one it was rather than falling back to the dearer rate.
      anthropicCacheCreation5mInputTokens: 300,
      anthropicCacheCreation1hInputTokens: 0,
      anthropicPromptTokens: 9_340,
    });
    expect(result.tokensConsumed).toBe(1_515);
  });

  it('⛔ a write reported ONLY in the per-lifetime split is still a write — never priced at zero', () => {
    // No `cache_creation_input_tokens`, but a split that says 3,000 tokens were
    // written. The bare total would drop them from the cost, the debit and the
    // prompt size at once.
    const splitOnly = parseAnthropicUsage({
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 2_000 },
      },
    });
    expect(splitOnly.cacheCreationInputTokens).toBe(3_000);
    // 1 + 1 + ceil(1000 × 1.25 + 2000 × 2).
    expect(billableTokens(splitOnly, 'claude-opus-5')).toBe(5_252);
    expect(makeClaudeUsage(1, 1, 'claude-opus-5', splitOnly).anthropicPromptTokens).toBe(3_001);
    // A total SMALLER than its own split is the same fault, and gets the same answer.
    const shortTotal = parseAnthropicUsage({
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 500,
        cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 2_000 },
      },
    });
    expect(billableTokens(shortTotal, 'claude-opus-5')).toBe(5_252);
    // And a hand-assembled usage block cannot get zero out of it either.
    expect(
      billableTokens(
        {
          inputTokens: 1,
          outputTokens: 1,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreation5mInputTokens: 1_000,
          cacheCreation1hInputTokens: 2_000,
        },
        'claude-opus-5',
      ),
    ).toBe(5_252);
  });

  it('the READ-BACK call is accounted the same way: cache fields carried, debit weighted, cost priced', async () => {
    // It sends no marker today, so these read zero in production — which is
    // exactly when a second, cache-blind copy of the accounting would go unseen.
    const fetchAnswer = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '{"answer":"203.0.113.7"}' }],
            stop_reason: 'end_turn',
            usage: CACHED_USAGE,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )) as unknown as typeof globalThis.fetch;
    const result = await new ClaudeAgentDecomposer({ fetch: fetchAnswer }).answerFromObservation({
      task: 'what is my IP?',
      observation: 'Your IP is 203.0.113.7',
      budgetTokensRemaining: 100_000,
      byokAnthropicApiKey: 'test-key-not-a-secret',
      model: 'claude-opus-5',
    });
    expect(result.tokensConsumed).toBe(1_515);
    expect(result.usage).toMatchObject({
      anthropicInputTokens: 40,
      anthropicCacheCreationInputTokens: 300,
      anthropicCacheReadInputTokens: 9_000,
      anthropicPromptTokens: 9_340,
      anthropicThinkingTokens: 120,
      // 40 × 0.5 + 200 × 2.5 + (300 × 1.25 + 9000 × 0.1) × 0.5, per 1k, in
      // cents = 1.1575, rounded up. At the full input rate it would be 6.
      costUsdCents: 2,
    });
  });

  it('⛔ prices a cache read at a TENTH and a write ABOVE base — not free, not full', () => {
    // Opus 5: $5/MTok input → 0.5c per 1k. 100k cached-read tokens:
    //   full price would be 50c; free would be 0c; the truth is 5c.
    const read = makeClaudeUsage(0, 0, 'claude-opus-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 100_000,
    });
    expect(read.costUsdCents).toBe(5);
    // 100k written at the 5-minute rate: 1.25 × 50c = 62.5c → 63 (rounded up).
    const write5m = makeClaudeUsage(0, 0, 'claude-opus-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 100_000,
      cacheReadInputTokens: 0,
      cacheCreation5mInputTokens: 100_000,
      cacheCreation1hInputTokens: 0,
    });
    expect(write5m.costUsdCents).toBe(63);
    // …and at the 1-hour rate: 2 × 50c = 100c.
    const write1h = makeClaudeUsage(0, 0, 'claude-opus-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 100_000,
      cacheReadInputTokens: 0,
      cacheCreation5mInputTokens: 0,
      cacheCreation1hInputTokens: 100_000,
    });
    expect(write1h.costUsdCents).toBe(100);
    // A write with NO breakdown is priced at the dearer rate: an upper bound.
    const unattributed = makeClaudeUsage(0, 0, 'claude-opus-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 100_000,
      cacheReadInputTokens: 0,
    });
    expect(unattributed.costUsdCents).toBe(100);
    // No cache activity: exactly what it always was.
    expect(makeClaudeUsage(10_000, 1_000, 'claude-opus-5').costUsdCents).toBe(8);
  });

  it('the multipliers are the documented ones, on every model, and every row prices a read below a write', () => {
    for (const model of AgentModelSchema.options) {
      const rate = CLAUDE_MODELS[model];
      expect(rate.cacheWrite5mMultiplier).toBe(1.25);
      expect(rate.cacheWrite1hMultiplier).toBe(2);
      expect(rate.cacheReadMultiplier).toBe(0.1);
      expect(rate.minCacheablePromptTokens).toBeGreaterThanOrEqual(512);
    }
    expect(CLAUDE_MODELS['claude-opus-5'].minCacheablePromptTokens).toBe(512);
    expect(CLAUDE_MODELS['claude-sonnet-5'].minCacheablePromptTokens).toBe(1024);
    expect(CLAUDE_MODELS['claude-opus-4-8'].minCacheablePromptTokens).toBe(1024);
    expect(CLAUDE_MODELS['claude-opus-4-7'].minCacheablePromptTokens).toBe(2048);
    expect(CLAUDE_MODELS['claude-sonnet-4-6'].minCacheablePromptTokens).toBe(1024);
    expect(CLAUDE_MODELS['claude-haiku-4-5'].minCacheablePromptTokens).toBe(4096);
    // Verified list prices (the Sonnet 5 row had carried Sonnet 4.6's by mistake).
    expect(CLAUDE_MODELS['claude-opus-5'].inputCentsPer1k).toBe(0.5);
    expect(CLAUDE_MODELS['claude-opus-5'].outputCentsPer1k).toBe(2.5);
    expect(CLAUDE_MODELS['claude-sonnet-5'].inputCentsPer1k).toBe(0.2);
    expect(CLAUDE_MODELS['claude-sonnet-5'].outputCentsPer1k).toBe(1);
  });

  it('⛔ the budget DEBIT is price-weighted; the prompt SIZE is reported beside it', async () => {
    const { fetchImpl } = recordingFetch(CACHED_USAGE);
    const result = await new ClaudeAgentDecomposer({ fetch: fetchImpl }).decompose(args());
    // 40 uncached + 200 output + ceil(300 × 1.25 + 9000 × 0.1 = 1275) = 1515.
    expect(result.tokensConsumed).toBe(1_515);
    // Not the raw total (which would charge a tenth-price token in full)…
    expect(result.tokensConsumed).not.toBe(40 + 200 + 300 + 9_000);
    // …and not the uncached remainder (which would make cached tokens free).
    expect(result.tokensConsumed).not.toBe(40 + 200);
    expect(result.usage?.anthropicPromptTokens).toBe(9_340);
    // With no cache activity the debit is exactly input + output, as before.
    const parts = parseAnthropicUsage({ usage: { input_tokens: 120, output_tokens: 80 } });
    expect(billableTokens(parts, 'claude-opus-5')).toBe(200);
  });

  it('a cache field that is PRESENT but wrong throws; only absent (or null) is zero', () => {
    expect(
      parseAnthropicUsage({
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: null },
      }).cacheReadInputTokens,
    ).toBe(0);
    for (const bad of ['120', -1, 1.5, Number.NaN]) {
      expect(() =>
        parseAnthropicUsage({
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: bad },
        }),
      ).toThrow('Anthropic response usage was missing or invalid');
      expect(() =>
        parseAnthropicUsage({
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation: { ephemeral_1h_input_tokens: bad },
          },
        }),
      ).toThrow('Anthropic response usage was missing or invalid');
    }
  });
});

describe('C4 — a reply cut off at the output ceiling says so', () => {
  it('names the truncation, keeps the classifier-matched wording, and still accounts for the call', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '{"kind":"plan","intents":[{"kind":"navi' }],
            stop_reason: 'max_tokens',
            usage: { input_tokens: 100, output_tokens: 8_192 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )) as unknown as typeof globalThis.fetch;
    const error = await new ClaudeAgentDecomposer({ fetch: fetchImpl }).decompose(args()).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AgentDecomposerSettledError);
    if (!(error instanceof AgentDecomposerSettledError)) throw new Error('narrow');
    // The runtime classifies by this wording, so it stays the prefix.
    expect(error.message).toMatch(/^Anthropic response was not valid JSON/);
    expect(error.message).toContain('cut off at the output limit');
    expect(error.usage.anthropicStopReason).toBe('max_tokens');
    expect(error.tokensConsumed).toBe(8_292);
  });

  it.each([
    [
      'spent the whole ceiling thinking and wrote nothing',
      [],
      'Anthropic answer response missing text content block',
    ],
    [
      'was cut off mid-answer',
      [{ type: 'text', text: '{"answer":"Your IP addr' }],
      'Anthropic answer response was not valid JSON',
    ],
  ])(
    'a READ-BACK that %s says so too — the call where a ceiling spent on thinking is likeliest',
    async (_label, content, prefix) => {
      const fetchImpl = (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              content,
              stop_reason: 'max_tokens',
              usage: { input_tokens: 100, output_tokens: 4_096 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        )) as unknown as typeof globalThis.fetch;
      const error = await new ClaudeAgentDecomposer({ fetch: fetchImpl })
        .answerFromObservation({
          task: 'what is my IP?',
          observation: 'Your IP is 203.0.113.7',
          budgetTokensRemaining: 100_000,
          byokAnthropicApiKey: 'test-key-not-a-secret',
        })
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(AgentDecomposerSettledError);
      if (!(error instanceof AgentDecomposerSettledError)) throw new Error('narrow');
      expect(error.message.startsWith(prefix)).toBe(true);
      expect(error.message).toContain('cut off at the output limit');
      expect(error.usage.anthropicStopReason).toBe('max_tokens');
      expect(error.tokensConsumed).toBe(4_196);
    },
  );

  it('records a stop reason only from the documented set — an upstream string never reaches the usage row verbatim', async () => {
    const hostile = `max_tokens ${'A'.repeat(50_000)}`;
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '{"kind":"clarify","clarifyingQuestion":"which?"}' }],
            stop_reason: hostile,
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )) as unknown as typeof globalThis.fetch;
    const result = await new ClaudeAgentDecomposer({ fetch: fetchImpl }).decompose(args());
    expect(result.usage?.anthropicStopReason).toBe('other');
    expect(JSON.stringify(result.usage)).not.toContain('AAAA');
  });

  it('an ordinary malformed reply is NOT labelled as a truncation', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'Sure! Here is the plan:' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 9 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )) as unknown as typeof globalThis.fetch;
    await expect(new ClaudeAgentDecomposer({ fetch: fetchImpl }).decompose(args())).rejects.toThrow(
      /^Anthropic response was not valid JSON$/,
    );
  });
});
