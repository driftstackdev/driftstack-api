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

// ── I18N — A QUESTION IS READ IN THE SCRIPT IT WAS WRITTEN IN ─────────────
//
// The gate knew ONE question mark, the ASCII one. A customer who wrote
// "多少钱？" with the full-width mark their keyboard gives them, or "؟" in
// Arabic, watched every step succeed and was told nothing — P5 again, for every
// customer who does not write English punctuation.
//
// ⛔ WHAT THE LEXICAL GATE DELIBERATELY DOES NOT DO: read a question with no mark
// at all. Russian and Chinese customers routinely ask with none, and the common
// question words in those languages double as ordinary words, so the planner's
// `answerWanted` reads those (see
// the-planner-can-open-the-read-back-for-a-question-with-no-mark-and-never-close-one).
// The arms below pin that they are NOT caught here, so that nobody mistakes this
// gate for the whole answer.
describe('I18N — the read-back gate reads a question mark in every script a customer writes', () => {
  it.each([
    // Chinese and Japanese write the FULL-WIDTH mark (U+FF1F). NFKC folds it.
    ['full-width ？ (Chinese)', '打开 chaguan.test 的茶单，告诉我一壶西湖龙井多少钱？'],
    ['full-width ？ (Japanese)', 'shop.test を開いて、青いマグの値段はいくらですか？'],
    ['Arabic ؟', 'افتح shop.test وأخبرني كم سعر الكوب؟'],
    ['Persian ؟', 'سایت shop.test را باز کن، قیمت لیوان آبی چقدر است؟'],
    // Spanish may OPEN a question and never close it in a chat message.
    ['Spanish ¿ alone', 'abre plans.test ¿cuánto cuesta el plan Team'],
    // Armenian writes its mark over a vowel INSIDE the questioned word.
    ['Armenian ՞', 'Բացիր shop.test-ը, ո՞րն է գինը'],
    ['Ethiopic ፧', 'shop.test ክፈት፣ ዋጋው ስንት ነው፧'],
    ['the interrobang ‽', 'open shop.test — the plan doubled‽'],
    ['a Russian question WITH its mark', 'зайди на apteka.test, до скольки работает аптека?'],
  ])('asks for information — %s', (_label, message) => {
    expect(asksForInformation(message)).toBe(true);
  });

  it.each([
    // ⛔ THE STRIP USED TO EAT THE QUESTION. A URL ran to the next space, and
    // Chinese puts no space after one: the address, the question, its mark and
    // the "thanks" after it were one "URL". (The mark is NOT last on purpose:
    // a mark at the very end is handed back by the trailing-punctuation rule
    // whatever the URL pattern does, so only a mark mid-run tests the pattern.)
    [
      'a Chinese question run straight on from an address',
      'https://chaguan.test/menu上的龙井多少钱？谢谢',
    ],
    // A mark glued to the END of an address is the customer's, not the URL's.
    ['a mark glued to the end of a full URL', 'is the Team plan on https://plans.test/pricing?'],
    ['a mark glued to the end of a bare address', 'is it cheaper on shop.test/pricing?'],
    ['a full-width mark glued to an address', '价格在 https://chaguan.test/menu？'],
    // The query run is stripped on its own, and only the query: a question
    // written after it is still the customer's. (Mark mid-run again, so a query
    // rule that ran on to the next space would fail here.)
    [
      'a question after the query of an address with a non-ASCII path',
      '打开 https://baike.test/item/龙井?fromModule=search，一壶多少钱？谢谢',
    ],
  ])('a question beside an address is still a question — %s', (_label, message) => {
    expect(asksForInformation(message)).toBe(true);
  });

  it('an English word a customer drops between Chinese characters is still read — the boundary is Latin letters, not ASCII', () => {
    expect(asksForInformation('帮我check一下 shop.test 的价格')).toBe(true);
  });

  it.each([
    // ⛔ THE COST GATE, IN OTHER SCRIPTS. A pure instruction in Chinese is still
    // an instruction, and must not buy a second model call.
    ['a Chinese screenshot-only instruction', '打开 news.test 并截图'],
    ['the same, with a Chinese full stop and comma', '打开 news.test，截个图。'],
    ['a Japanese screenshot-only instruction', 'news.test を開いてスクリーンショットを撮って'],
    // A query string with no path is a URL too; its `?` used to read as a question.
    ['a query with no path', 'go to example.com?ref=mail and take a screenshot'],
    // ⛔ THE ASCII-ONLY URL STOPS AT THE FIRST NON-ASCII LETTER, and the query
    // after it used to be left behind as prose, its `?` read as a question.
    [
      'a query after an address with a non-ASCII path',
      '打开 https://baike.test/item/龙井?fromModule=search 并截图',
    ],
    ['a query after an address with a non-ASCII host', '打开 https://例子.测试/?q=1 并截图'],
    // ⛔ A SEMICOLON IS A CLAUSE BREAK. The Greek question mark folds into one
    // under NFKC, and reading it would spend a read-back on every "X; Y".
    ['an ordinary semicolon', 'open news.test; take a screenshot'],
    // `\b` read "listés" as the token "list" (é is not an ASCII word character).
    [
      'a French word that merely STARTS with an English token',
      'ouvre shop.test, les produits listés, et fais une capture',
    ],
  ])('does NOT ask for information — %s', (_label, message) => {
    expect(asksForInformation(message)).toBe(false);
  });

  it.each([
    // "Go to apteka.test and tell me until what time the pharmacy is open on
    // Saturday" — an imperative, and Russian writes it with no mark.
    ['Russian', 'зайди на apteka.test и скажи, до скольки аптека работает в субботу'],
    // "Open chaguan.test's tea menu and tell me how much a pot of Longjing costs"
    ['Chinese', '打开 chaguan.test 的茶单，告诉我一壶西湖龙井多少钱'],
    // The Greek question mark (U+037E) is deliberately not read — see above.
    ['Greek, with its own question mark', 'άνοιξε το news.test, πόση είναι η τιμή\u037E'],
  ])(
    '⛔ a %s question with no mark the gate reads is NOT caught lexically — that is the planner signal’s job',
    (_label, message) => {
      expect(asksForInformation(message)).toBe(false);
    },
  );
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
