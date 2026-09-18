// P5 — every step succeeded and the customer still got nothing.
//
// Two separate defects wearing one symptom.
//
// 1. THE GATE WAS TOO NARROW. The read-back fires only when the wording matches
//    READ_INTENT_RE, and the pattern had no token for "give", none for "say",
//    and — the cheapest signal of all — it did not read a literal question mark.
//    "search X and GIVE ME the first result" ran every step, read nothing, and
//    said nothing.
//
// 2. WHEN IT WAS BLOCKED, IT WAS SILENT. Eight other conjuncts can block the
//    answer, every one of them for a reason that has nothing to do with whether
//    the customer asked — budget left, key configured, page readable. A customer
//    who asks a question, watches the work happen, and is then told nothing
//    cannot tell that apart from being ignored. "I did the steps but could not
//    read the page back because X" is a far better answer than silence.
//
// ⛔ THE WIDENING MUST STILL SAY NO. A pattern that matched everything would
// make every pure-action task pay for a second model call, which is money spent
// answering a question nobody asked. The refusal arms below are as load-bearing
// as the acceptance arms.

import { describe, expect, it } from 'vitest';
import { asksForInformation, AgentRuntime } from '../../src/services/agent-runtime.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import { StubAgentExecutor } from '../../src/services/agent-executor.js';
import type { AgentExecutor, ExecuteArgs } from '../../src/services/agent-executor.js';
import type { DecomposeArgs, DecomposeResult } from '../../src/services/agent-decomposer.js';
import type { ExecutorRunResult, IntentResult } from '../../src/services/agent-executor.js';

describe('P5 — the read-back gate reads the question the customer actually asked', () => {
  it.each([
    // The measured one. `give` was simply not a token.
    "search search.test for 'wireless keyboard' and give me the first result",
    // A question mark and nothing else — the signal that was never read at all.
    'go to the pricing page and see if the starter plan changed?',
    'type my email in the form and tell me what it says',
    'open the dashboard and summarise the alerts',
    'go to the status page and confirm everything is green',
    'check the inbox and say how many are unread',
    'describe the top article on blog.test',
    'count the items in the cart',
    'what is my IP',
    'how many unread messages do I have',
    // A question mark inside a URL is NOT this — but a real question beside one
    // still is, so stripping the URL must not strip the question.
    'open https://shop.test/?ref=email and tell me the price',
  ])('asks for information: %s', (message) => {
    expect(asksForInformation(message)).toBe(true);
  });

  it.each([
    // ⛔ THE ONE THE COST GATE EXISTS FOR. A pure-action task must not pay for a
    // second model call.
    'open news.test and take a screenshot',
    'scroll down on example.com and capture the page',
    'go to shop.test and add the blue mug to the cart',
    'go to app.test and click Continue',
    // "checkout" must not be read as "check". It is a purchase step, and the
    // word is a substring of a token this pattern accepts.
    'go to shop.test/checkout and buy the blue mug',
    'warm up this profile',
    // ⛔ THE QUERY STRING IS NOT A QUESTION. `?` is the cheapest read-intent
    // signal there is in prose and a separator in a URL, and browser-automation
    // tasks are full of URLs. Reading one as a question spends a second model
    // call on a task nobody asked a question about — the exact cost the gate's
    // refusal side exists to prevent.
    'open https://news.test/?utm_source=x and take a screenshot',
    'go to example.com/p?id=7 and click Continue',
    'navigate to https://a.test/search?q=mug and screenshot it',
    // "confirm the purchase" is an action, the same way "check out" is.
    'go to the checkout page and confirm the purchase',
  ])('does NOT ask for information: %s', (message) => {
    expect(asksForInformation(message)).toBe(false);
  });

  it('and a genuine "confirm" question is still read as one', () => {
    expect(asksForInformation('confirm the price is under twenty')).toBe(true);
  });
});

describe('P5 — when there is no answer, the customer is told why', () => {
  async function runWith(opts: {
    observe?: () => Promise<string | null>;
    answer?: string;
    tokenBudgetTotal?: number;
    byokApiKey?: string | undefined;
    canAnswer?: boolean;
  }) {
    const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-17T00:00:00Z'));
    const seed = await sessions.create({
      accountId: 'acc_1',
      tokenBudgetTotal: opts.tokenBudgetTotal ?? 100_000,
    });
    const stub = new StubAgentExecutor();
    const executor: AgentExecutor = {
      execute: (a: ExecuteArgs) => stub.execute(a),
      observe: opts.observe ?? (() => Promise.resolve('Results\n1. Quietkey 7')),
    };
    const decomposer: {
      decompose: (a: DecomposeArgs) => Promise<DecomposeResult>;
      answerFromObservation?: () => Promise<{ answer: string; tokensConsumed: number }>;
    } = {
      decompose: () =>
        Promise.resolve({
          kind: 'plan',
          intents: [
            { kind: 'navigate', url: 'https://search.test/' },
            { kind: 'capture', capture: 'screenshot' },
          ],
          tokensConsumed: 100,
        }),
    };
    if (opts.canAnswer !== false) {
      decomposer.answerFromObservation = () =>
        Promise.resolve({ answer: opts.answer ?? '1. Quietkey 7', tokensConsumed: 40 });
    }
    const runtime = new AgentRuntime({
      decomposer,
      executor,
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    const result = await runtime.runTurn({
      agentSessionId: seed.id,
      userMessage: "search search.test for 'wireless keyboard' and give me the first result",
      ...(opts.byokApiKey !== undefined ? { byokApiKey: opts.byokApiKey } : {}),
    });
    return { result, transcript: (await sessions.get(seed.id))?.transcript ?? [] };
  }

  it('the widened gate actually answers the measured task, end to end', async () => {
    const { result, transcript } = await runWith({ byokApiKey: 'sk-ant-test-fake-key' });
    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(result.answer).toBe('1. Quietkey 7');
    expect(result.readbackUnavailable).toBeUndefined();
    expect(transcript.at(-1)?.body).toBe('1. Quietkey 7');
  });

  it.each([
    ['no key is configured', { byokApiKey: undefined }, /no AI key/i],
    [
      'the page could not be read',
      { byokApiKey: 'k', observe: () => Promise.resolve(null) },
      /could not read the page back/i,
    ],
    ['the session budget is nearly gone', { byokApiKey: 'k', tokenBudgetTotal: 5_000 }, /budget/i],
    [
      'reading back is not available at all',
      { byokApiKey: 'k', canAnswer: false },
      /not available/i,
    ],
  ])('says so when %s', async (_label, opts, expected) => {
    const { result, transcript } = await runWith(opts);
    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    // ⛔ THE SENTENCE NAMES THE CAUSE. Every one of these has a DIFFERENT repair
    // for the customer, so a single "could not read the page" would be honest
    // about the outcome and useless about the fix.
    expect(result.readbackUnavailable).toMatch(expected);
    expect(result.answer).toBeUndefined();
    // It is published where the answer would have been — same transcript, same
    // event bus — so every surface that renders an answer renders this.
    expect(transcript.at(-1)?.role).toBe('agent');
    expect(transcript.at(-1)?.body).toBe(result.readbackUnavailable);
    // Customer-facing copy names nothing internal.
    expect(result.readbackUnavailable).not.toMatch(
      /fleet|node|control plane|harness|observer|vantage|token budget remaining/i,
    );
  });

  it('⛔ A PURE-ACTION TASK STAYS SILENT — there is no question to apologise for not answering', async () => {
    const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-17T00:00:00Z'));
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    const stub = new StubAgentExecutor();
    const runtime = new AgentRuntime({
      decomposer: {
        decompose: () =>
          Promise.resolve({
            kind: 'plan',
            intents: [{ kind: 'capture', capture: 'screenshot' }],
            tokensConsumed: 10,
          }),
      },
      executor: { execute: (a: ExecuteArgs) => stub.execute(a) },
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    const result = await runtime.runTurn({
      agentSessionId: seed.id,
      userMessage: 'open news.test and take a screenshot',
    });
    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(result.readbackUnavailable).toBeUndefined();
    // user + plan, and nothing else.
    expect((await sessions.get(seed.id))?.transcript).toHaveLength(2);
  });
});

// ── AND THE SILENCE HAS A SECOND DOOR ────────────────────────────────
//
// P5's whole complaint is that the customer got the work done and was told
// nothing. P1 opened a new way into exactly that: the gate asked whether the
// FIRST plan contained a capture, and a turn whose first plan died and whose
// RE-PLAN carried the capture answers that question "no" — so no answer, and no
// sentence saying why. Everything else about the turn had already moved to
// "what was attempted"; this conjunct had not.
describe('P5 — a turn that re-planned into the answer still answers', () => {
  it('⛔ THE CAPTURE THAT APPEARS ONLY IN THE RE-PLAN STILL COUNTS AS BEING ASKED', async () => {
    const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-17T00:00:00Z'));
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    const plans: DecomposeResult[] = [
      // First plan: no capture at all, and it dies on a guessed selector.
      {
        kind: 'plan',
        intents: [{ kind: 'interact', action: 'tap', selector: '#guessed' }],
        tokensConsumed: 100,
      },
      // The re-plan looks at the page and captures — this is the plan that
      // produces the thing the customer asked for.
      {
        kind: 'plan',
        intents: [
          { kind: 'interact', action: 'tap', selector: '#actually-there' },
          { kind: 'capture', capture: 'screenshot' },
        ],
        tokensConsumed: 100,
      },
    ];
    let call = 0;
    const runtime = new AgentRuntime({
      decomposer: {
        decompose: (): Promise<DecomposeResult> => {
          const next = plans[Math.min(call, plans.length - 1)];
          call += 1;
          return Promise.resolve(next ?? plans[0]!);
        },
        answerFromObservation: () =>
          Promise.resolve({ answer: 'The order is out for delivery.', tokensConsumed: 40 }),
      },
      executor: {
        execute: (a: ExecuteArgs): Promise<ExecutorRunResult> => {
          const results: IntentResult[] = [];
          for (const intent of a.plan.intents) {
            if (intent.kind === 'interact' && intent.selector === '#guessed') {
              results.push({
                kind: 'failure',
                intent,
                reason: 'no element on the page matched this selector',
                diagnosis: { category: 'element_not_found', retryable: true },
              });
              return Promise.resolve({ results, ok: false });
            }
            results.push({ kind: 'success', intent, summary: 'ok' });
          }
          return Promise.resolve({ results, ok: true });
        },
        observeDigest: () => Promise.resolve('#actually-there · button · "Orders"'),
        observe: () => Promise.resolve('Order 41 — out for delivery'),
      },
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });

    const result = await runtime.runTurn({
      agentSessionId: seed.id,
      userMessage: 'open the orders page and tell me the latest status',
      byokApiKey: 'sk-ant-test-fake-key',
    });

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(result.executor.ok).toBe(true);
    // ⛔ NOT SILENCE. Reading the gate off the FIRST plan returns neither an
    // answer nor an explanation here, which is the original P5 defect arriving
    // through P1's door.
    expect(result.answer).toBe('The order is out for delivery.');
  });
});
