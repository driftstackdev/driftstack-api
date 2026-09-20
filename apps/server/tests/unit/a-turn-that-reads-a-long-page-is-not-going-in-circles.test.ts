// S4 — a page being read is not a page going in circles.
//
// THE DEFECT THIS FILE EXISTS FOR. The no-progress check allows a repeated plan
// on an unchanged page only when it acts on nothing AND scrolls, because the
// look is a digest of the DOCUMENT and a scroll moves the VIEWPORT — content
// that renders when scrolled into view is the ordinary case. `scrolls` tested
// for a scroll intent and nothing else, so a plan of "read what is on this page"
// failed it, even though the mapper turns every pause carrying a word count into
// `scroll_through` and the device reads long content by traversing it. The phone
// was scrolling and reading exactly as asked, and the product told the customer
// it had gone in circles — on the first repeat, with a digest that had not
// changed because the document had not.
//
// The repeat guard already exempts pauses, with the reason in its source. This
// check was never taught the same thing.
//
// ⛔ AND NARROWLY. Only a pause carrying a reading word count counts — see
// a-plan-of-bare-pauses-is-still-going-in-circles for the other half, which is
// the half that keeps the check worth having.

import { describe, expect, it } from 'vitest';
import { AgentRuntime, TURN_LOOP_STOP_SENTENCES } from '../../src/services/agent-runtime.js';
import { agentIntentToDispatch } from '../../src/services/agent-intent-to-dispatch.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type {
  AgentExecutor,
  ExecuteArgs,
  ExecutorRunResult,
  IntentResult,
} from '../../src/services/agent-executor.js';
import type {
  AgentIntent,
  DecomposeArgs,
  DecomposeResult,
  PlanStatus,
} from '../../src/services/agent-decomposer.js';

const NAV: AgentIntent = { kind: 'navigate', url: 'https://shop.test/recalls' };
const READ: AgentIntent = { kind: 'behavioral_pause', reading_word_count: 1_400 };
const SCROLL_DOWN: AgentIntent = { kind: 'scroll', direction: 'down', amount_px: 600 };

function segment(intents: AgentIntent[], status?: PlanStatus): DecomposeResult {
  return {
    kind: 'plan',
    intents,
    ...(status !== undefined ? { status } : {}),
    tokensConsumed: 100,
  };
}

interface Harness {
  runs: ExecuteArgs[];
  seen: DecomposeArgs[];
}

/** Every step green, and a page digest that never changes — the state in which
 *  the no-progress check has to decide. */
function frozenPageExecutor(h: Harness): AgentExecutor {
  return {
    execute: (args: ExecuteArgs): Promise<ExecutorRunResult> => {
      h.runs.push(args);
      const results: IntentResult[] = args.plan.intents.map(
        (intent): IntentResult => ({ kind: 'success', intent, summary: `did ${intent.kind}` }),
      );
      return Promise.resolve({ results, ok: true });
    },
    observeDigest: () => Promise.resolve('a long page that never changes'),
    observe: () => Promise.resolve('Recall notice: model 4A, 2019–2021.'),
  };
}

async function makeRuntime(h: Harness, plans: DecomposeResult[]) {
  const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-20T00:00:00Z'));
  const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
  const runtime = new AgentRuntime({
    decomposer: {
      decompose: (args: DecomposeArgs): Promise<DecomposeResult> => {
        h.seen.push(args);
        const next = plans[Math.min(h.seen.length - 1, plans.length - 1)];
        return Promise.resolve(next ?? segment([], 'done'));
      },
      answerFromObservation: () =>
        Promise.resolve({ answer: 'Models 4A from 2019 to 2021.', tokensConsumed: 40 }),
    },
    executor: frozenPageExecutor(h),
    sessions,
    archetype: 'iphone16pro_ios18_7_safari26_4',
    // Nothing here measures time; the turn's clock must not end the loop first.
    nowMs: () => 1_000,
  });
  return {
    turn: (userMessage: string) =>
      runtime.runTurn({
        agentSessionId: seed.id,
        userMessage,
        byokApiKey: 'sk-ant-test-fake-key',
      }),
  };
}

describe('a turn that reads a long page is not going in circles', () => {
  it('the premise the exemption rests on, asked of the MAPPER rather than repeated in a comment: a word count is sent as a traversal, a duration is not', () => {
    const reading = agentIntentToDispatch(READ);
    if (!reading.ok) throw new Error('the mapper refused a reading pause');
    // This is why a reading pause may be repeated once on an unchanged digest:
    // the device is scrolling through the content, so the viewport moved even
    // though the document did not. If this stops being true, the exemption in
    // agent-runtime.ts is excusing a dwell on a frozen screen.
    expect(reading.params['scroll_through']).toBe(true);

    const dwell = agentIntentToDispatch({ kind: 'behavioral_pause', duration_ms: 9_000 });
    if (!dwell.ok) throw new Error('the mapper refused a plain pause');
    expect(dwell.params['scroll_through']).toBeUndefined();
  });

  it('CRITICAL "read this page" asked again on an unchanged page gets its second read, not the going-in-circles sentence', async () => {
    const h: Harness = { runs: [], seen: [] };
    const readAgain = segment([READ], 'continue');
    const { turn } = await makeRuntime(h, [segment([NAV], 'continue'), readAgain, readAgain]);

    const result = await turn('read me the whole recall notice');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    // The navigate, the read, and THE READ AGAIN. Before this the second read
    // was refused and the turn ended with "the page did not change and I was
    // about to try the same thing again".
    expect(h.runs).toHaveLength(3);
    expect(result.executor.results.map((r) => r.intent.kind)).toEqual([
      'navigate',
      'behavioral_pause',
      'behavioral_pause',
    ]);
  });

  it('CRITICAL one repeat only — a THIRD identical reading plan on an unchanged page is still circles', async () => {
    const h: Harness = { runs: [], seen: [] };
    const readAgain = segment([READ], 'continue');
    const { turn } = await makeRuntime(h, [
      segment([NAV], 'continue'),
      readAgain,
      readAgain,
      readAgain,
      readAgain,
    ]);

    const result = await turn('read me the whole recall notice');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.runs).toHaveLength(3);
    expect(result.loop?.stopped).toBe('no_progress');
    expect(result.notice).toBe(TURN_LOOP_STOP_SENTENCES.no_progress);
  });

  it('a plan that scrolls AND reads is allowed the same one repeat, and says so through both halves', async () => {
    const h: Harness = { runs: [], seen: [] };
    const scrollAndRead = segment([SCROLL_DOWN, READ], 'continue');
    const { turn } = await makeRuntime(h, [
      segment([NAV], 'continue'),
      scrollAndRead,
      scrollAndRead,
      scrollAndRead,
    ]);

    const result = await turn('read me the whole recall notice');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.runs).toHaveLength(3);
    expect(result.loop?.stopped).toBe('no_progress');
  });

  it('a page that DID change is not a repeat at all — the exemption is for the unchanged-digest case only', async () => {
    const h: Harness = { runs: [], seen: [] };
    const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-20T00:00:00Z'));
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    let looks = 0;
    const runtime = new AgentRuntime({
      decomposer: {
        decompose: (args: DecomposeArgs): Promise<DecomposeResult> => {
          h.seen.push(args);
          return Promise.resolve(
            h.seen.length >= 4 ? segment([], 'done') : segment([READ], 'continue'),
          );
        },
        answerFromObservation: () => Promise.resolve({ answer: 'Done.', tokensConsumed: 40 }),
      },
      executor: {
        execute: (args: ExecuteArgs): Promise<ExecutorRunResult> => {
          h.runs.push(args);
          return Promise.resolve({
            results: args.plan.intents.map(
              (intent): IntentResult => ({ kind: 'success', intent, summary: 'did it' }),
            ),
            ok: true,
          });
        },
        observeDigest: () => {
          looks += 1;
          return Promise.resolve(`page as of look ${String(looks)}`);
        },
        observe: () => Promise.resolve('Recall notice.'),
      },
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
      nowMs: () => 1_000,
    });

    const result = await runtime.runTurn({
      agentSessionId: seed.id,
      userMessage: 'keep reading as the page loads more',
      byokApiKey: 'sk-ant-test-fake-key',
    });

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(result.loop?.stopped).toBeUndefined();
    expect(h.runs.length).toBeGreaterThan(2);
  });
});
