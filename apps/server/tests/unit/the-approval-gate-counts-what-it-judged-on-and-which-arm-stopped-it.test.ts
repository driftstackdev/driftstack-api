// WHAT THE APPROVAL GATE HAD TO GO ON, AND WHICH ARM STOPPED A STEP.
//
// ⛔ WHY THIS FILE EXISTS. The structural arm shipped with NO telemetry at all.
// Its cost is one extra `get_page_source` per step whose page reading is stale,
// up to sixteen a turn, and its blind spot is having no reading at all — the
// exact shape that was measured completing an unapproved purchase ten times out
// of ten. Neither was observable in production, so nobody could state a
// wild-web false-positive rate, price the read allowance, or tell "the gate
// stopped this" from "the planner declined to do it".
//
// Two counters close that, and both are driven HERE through the real
// ControlPlaneAgentExecutor and the real gate rather than by calling the
// recorder:
//
//   driftstack_agent_commitment_facts_total{outcome}
//       refreshed | unavailable | budget_spent | stale_used
//   driftstack_agent_consequential_halt_total{arm}
//       caption | structure | declared
//
// Every label value below is REACHED by driving the executor, the per-turn
// journal line carries the same numbers from the same sites, and each arm has a
// negative control that would leave a green-looking counter behind.

import { describe, expect, it } from 'vitest';
import type { AgentIntent } from '@driftstack/api-types';
import {
  ControlPlaneAgentExecutor,
  type IntentDispatcher,
} from '../../src/services/agent-executor-control-plane.js';
import type { ExecuteArgs, ExecutorRunResult } from '../../src/services/agent-executor.js';
import { encodeWireData, parseIntentResult } from '../../src/services/harness-control-codec.js';
import type { IntentDispatch } from '../../src/schemas/harness-control-protocol.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';
import {
  COMMITMENT_FACTS_OUTCOMES,
  CONSEQUENTIAL_HALT_ARMS,
  agentActionPathLogFields,
  emptyAgentActionPathCounts,
} from '../../src/services/agent-turn-telemetry.js';
import { newCommitmentBudget } from '../../src/services/agent-page-commitment.js';

// ── the pages ─────────────────────────────────────────────────────────

/** A fieldless POST checkout with the total in a sibling section: the shape the
 *  STRUCTURAL arm was built for, and its caption says nothing. */
const CHECKOUT =
  '<html><body><main><h1>Checkout</h1>' +
  '<section><p class="total">Total — £133.50</p></section>' +
  '<form id="pay" action="/orders" method="post">' +
  '<button id="go" type="submit">Weiter</button></form></main></body></html>';

/** The same page with a caption the ENGLISH arm matches. */
const CAPTIONED = CHECKOUT.replace('>Weiter<', '>Place order<');

/** Nothing commitment-shaped at all. */
const PLAIN = '<html><body><main><h1>Hello</h1><p>Nothing here.</p></main></body></html>';

// ── a device that answers however a test says ─────────────────────────

interface Device {
  dispatcher: IntentDispatcher;
  sent: string[];
}

function device(opts: { source?: string | null; sourceFails?: boolean } = {}): Device {
  const sent: string[] = [];
  const ok = (d: IntentDispatch, output: unknown) =>
    parseIntentResult(
      {
        type: 'intentResult',
        sessionId: d.sessionId,
        intentId: d.intentId,
        success: true,
        durationMs: 3,
        outputData: encodeWireData(output),
      },
      d.intentName,
    );
  const bad = (d: IntentDispatch, code: string) =>
    parseIntentResult(
      {
        type: 'intentResult',
        sessionId: d.sessionId,
        intentId: d.intentId,
        success: false,
        durationMs: 2,
        errorCode: code,
      },
      d.intentName,
    );
  return {
    sent,
    dispatcher: {
      dispatch: (d: IntentDispatch) => {
        sent.push(d.intentName);
        if (d.intentName === 'get_page_source') {
          if (opts.sourceFails === true) return Promise.resolve(bad(d, 'result_too_large'));
          const source = opts.source ?? CHECKOUT;
          return Promise.resolve(ok(d, { source, length: source.length, truncated: false }));
        }
        if (d.intentName === 'perceive') {
          // No answer: the look falls back and the tap goes ahead, which is the
          // ordinary path for a device that cannot resolve the selector.
          return Promise.resolve(bad(d, 'intent_not_implemented'));
        }
        if (d.intentName === 'click') {
          return Promise.resolve(ok(d, { clicked: '#go', behavioral: false, activated: true }));
        }
        return Promise.resolve(bad(d, 'intent_not_implemented'));
      },
    },
  };
}

/** ⛔ A SLEEP THAT LOSES ITS RACE. `observe` races the dispatch against
 *  `sleep(observeTimeoutMs)`, so a sleep that resolves immediately makes every
 *  page read time out — the arm would read `unavailable` for reasons that exist
 *  only in the test, and the pass would be about nothing. A macrotask always
 *  settles after the dispatch's microtask chain. */
const laterThanADispatch = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

function registry(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.registerCounter(METRIC_NAMES.agentCommitmentFactsTotal, 'facts', ['outcome']);
  m.registerCounter(METRIC_NAMES.agentConsequentialHaltTotal, 'halts', ['arm']);
  return m;
}

function reading(m: MetricsRegistry, name: string, label: string, value: string): number {
  const line = m
    .render()
    .split('\n')
    .find((l) => l.startsWith(`${name}{${label}="${value}"}`));
  return line === undefined ? 0 : Number(line.split(' ').at(-1));
}

const tap = (selector: string, value?: string): AgentIntent => ({
  kind: 'interact',
  action: 'tap',
  selector,
  ...(value !== undefined ? { value } : {}),
});

function run(
  dev: Device,
  metrics: MetricsRegistry,
  intents: AgentIntent[],
  extra: Partial<ExecuteArgs> = {},
): Promise<ExecutorRunResult> {
  let n = 0;
  const exec = new ControlPlaneAgentExecutor(dev.dispatcher, () => `int_${String((n += 1))}`, {
    sleep: laterThanADispatch,
    metrics,
  });
  return exec.execute({
    sessionId: 'agt_counted',
    plan: { kind: 'plan', intents, tokensConsumed: 0 },
    commitmentBudget: newCommitmentBudget(),
    ...extra,
  });
}

// ── what the arm judged on ────────────────────────────────────────────

describe('⛔ what the commitment arm had to judge on is counted, once per step it judged', () => {
  it('refreshed — a read was taken and the facts describe the page in front of it', async () => {
    const m = registry();
    const dev = device();
    const result = await run(dev, m, [tap('#go', 'Weiter')]);
    expect(reading(m, METRIC_NAMES.agentCommitmentFactsTotal, 'outcome', 'refreshed')).toBe(1);
    expect(result.actionPaths?.commitmentFacts.refreshed).toBe(1);
    expect(dev.sent.filter((s) => s === 'get_page_source')).toHaveLength(1);
  });

  it('unavailable — the read failed and there are no earlier facts, so the gate ran blind', async () => {
    const m = registry();
    const result = await run(device({ sourceFails: true }), m, [tap('#go', 'Weiter')]);
    expect(reading(m, METRIC_NAMES.agentCommitmentFactsTotal, 'outcome', 'unavailable')).toBe(1);
    expect(result.actionPaths?.commitmentFacts.unavailable).toBe(1);
    // ⛔ AND THE STEP WENT THROUGH, which is what makes this the label to alert
    // on: with no reading, the gate is the caption matcher alone.
    expect(result.results.at(-1)?.kind).toBe('success');
  });

  it('⛔ stale_used — a read was ATTEMPTED and gave nothing, so the last facts were used', async () => {
    const m = registry();
    // First tap: the source reads. Then the source starts failing, so the
    // second tap's read gives nothing and the arm falls back to what it has.
    let sourceCalls = 0;
    const sent: string[] = [];
    const dispatcher: IntentDispatcher = {
      dispatch: (d: IntentDispatch) => {
        sent.push(d.intentName);
        const frame = (output: unknown) =>
          parseIntentResult(
            {
              type: 'intentResult',
              sessionId: d.sessionId,
              intentId: d.intentId,
              success: true,
              durationMs: 3,
              outputData: encodeWireData(output),
            },
            d.intentName,
          );
        const fail = (code: string) =>
          parseIntentResult(
            {
              type: 'intentResult',
              sessionId: d.sessionId,
              intentId: d.intentId,
              success: false,
              durationMs: 2,
              errorCode: code,
            },
            d.intentName,
          );
        if (d.intentName === 'get_page_source') {
          sourceCalls += 1;
          return Promise.resolve(
            sourceCalls === 1
              ? frame({ source: CHECKOUT, length: CHECKOUT.length, truncated: false })
              : fail('result_too_large'),
          );
        }
        if (d.intentName === 'click') {
          return Promise.resolve(frame({ clicked: '#x', behavioral: false, activated: true }));
        }
        return Promise.resolve(fail('intent_not_implemented'));
      },
    };
    const result = await run({ dispatcher, sent }, m, [tap('#nothing'), tap('#go', 'Weiter')], {});
    expect(reading(m, METRIC_NAMES.agentCommitmentFactsTotal, 'outcome', 'stale_used')).toBe(1);
    expect(result.actionPaths?.commitmentFacts.stale_used).toBe(1);
    // ⛔ AND STALE FACTS STILL HALT. Going blind here is a page's cheapest way
    // to switch the arm off — make the agent tap twice before the order button.
    expect(result.results.at(-1)?.kind).toBe('confirmation_required');
  });

  it('budget_spent — the turn has no read allowance left, so the last facts were used', async () => {
    const m = registry();
    const budget = newCommitmentBudget({ sawMoney: true });
    // Prime the session's facts with one ordinary step, then spend the whole
    // allowance and watch the next step fall back to what was read.
    const dev = device();
    let n = 0;
    const exec = new ControlPlaneAgentExecutor(dev.dispatcher, () => `int_${String((n += 1))}`, {
      sleep: laterThanADispatch,
      metrics: m,
    });
    await exec.execute({
      sessionId: 'agt_spent',
      plan: { kind: 'plan', intents: [tap('#nothing')], tokensConsumed: 0 },
      commitmentBudget: budget,
    });
    budget.pageReads = 999;
    const result = await exec.execute({
      sessionId: 'agt_spent',
      plan: { kind: 'plan', intents: [tap('#go', 'Weiter')], tokensConsumed: 0 },
      commitmentBudget: budget,
    });
    expect(reading(m, METRIC_NAMES.agentCommitmentFactsTotal, 'outcome', 'budget_spent')).toBe(1);
    expect(result.actionPaths?.commitmentFacts.budget_spent).toBe(1);
    expect(result.results.at(-1)?.kind, 'the last facts still halt').toBe('confirmation_required');
  });

  it('a step that could never submit a form is not counted at all', async () => {
    const m = registry();
    const result = await run(device({ source: PLAIN }), m, [
      { kind: 'navigate', url: 'https://x.test/' },
      { kind: 'capture', capture: 'screenshot' },
    ]);
    for (const outcome of COMMITMENT_FACTS_OUTCOMES) {
      expect(reading(m, METRIC_NAMES.agentCommitmentFactsTotal, 'outcome', outcome), outcome).toBe(
        0,
      );
    }
    expect(
      result.actionPaths?.commitmentFacts ?? emptyAgentActionPathCounts().commitmentFacts,
    ).toEqual(emptyAgentActionPathCounts().commitmentFacts);
  });

  it('⛔ NO BUDGET THREADED — the arm is off, so nothing is counted and nothing is read', async () => {
    const m = registry();
    const dev = device();
    let n = 0;
    const exec = new ControlPlaneAgentExecutor(dev.dispatcher, () => `int_${String((n += 1))}`, {
      sleep: laterThanADispatch,
      metrics: m,
    });
    const result = await exec.execute({
      sessionId: 'agt_off',
      plan: { kind: 'plan', intents: [tap('#go', 'Weiter')], tokensConsumed: 0 },
    });
    expect(dev.sent).not.toContain('get_page_source');
    expect(m.render()).not.toContain(METRIC_NAMES.agentCommitmentFactsTotal + '{');
    expect(result.results.at(-1)?.kind, 'and the step goes through, exactly as it did').toBe(
      'success',
    );
  });
});

// ── which arm stopped it ──────────────────────────────────────────────

describe('⛔ which arm raised a halt is counted, and all three are reachable', () => {
  it('caption — the English phrases, over the page’s own name for the control', async () => {
    const m = registry();
    const result = await run(device({ source: CAPTIONED }), m, [tap('#go', 'Place order')]);
    expect(reading(m, METRIC_NAMES.agentConsequentialHaltTotal, 'arm', 'caption')).toBe(1);
    expect(result.actionPaths?.haltArms.caption).toBe(1);
    expect(result.results.at(-1)?.kind).toBe('confirmation_required');
  });

  it('structure — the markup says the control submits a form that commits value', async () => {
    const m = registry();
    const result = await run(device(), m, [tap('#go', 'Weiter')]);
    expect(reading(m, METRIC_NAMES.agentConsequentialHaltTotal, 'arm', 'structure')).toBe(1);
    expect(reading(m, METRIC_NAMES.agentConsequentialHaltTotal, 'arm', 'caption')).toBe(0);
    expect(result.actionPaths?.haltArms.structure).toBe(1);
  });

  it('declared — the planner said the step commits, on a page whose markup says nothing', async () => {
    const m = registry();
    const result = await run(device({ source: PLAIN }), m, [tap('#place', 'Weiter')], {
      declaredCommitments: [{ at: 0, category: 'account_deletion' }],
    });
    expect(reading(m, METRIC_NAMES.agentConsequentialHaltTotal, 'arm', 'declared')).toBe(1);
    expect(result.actionPaths?.haltArms.declared).toBe(1);
    const last = result.results.at(-1);
    expect(last?.kind).toBe('confirmation_required');
    if (last?.kind === 'confirmation_required') expect(last.category).toBe('account_deletion');
  });

  it('⛔ NEGATIVE CONTROL — the same declared step with no declaration is not halted or counted', async () => {
    const m = registry();
    const result = await run(device({ source: PLAIN }), m, [tap('#place', 'Weiter')]);
    for (const arm of CONSEQUENTIAL_HALT_ARMS) {
      expect(reading(m, METRIC_NAMES.agentConsequentialHaltTotal, 'arm', arm), arm).toBe(0);
    }
    expect(result.results.at(-1)?.kind).toBe('success');
  });

  it('⛔ the arm labels never overlap: a caption halt is counted ONCE, as caption', async () => {
    // The captioned page is ALSO structurally a commitment, so a gate that
    // counted both would double every ordinary purchase and make the split
    // meaningless. The caption arm decides first and the structural one is
    // never consulted for a step it halted.
    const m = registry();
    await run(device({ source: CAPTIONED }), m, [tap('#go', 'Place order')]);
    const total = CONSEQUENTIAL_HALT_ARMS.reduce(
      (sum, arm) => sum + reading(m, METRIC_NAMES.agentConsequentialHaltTotal, 'arm', arm),
      0,
    );
    expect(total).toBe(1);
  });

  it('the journal line carries both, as numbers, with no page content anywhere', async () => {
    const m = registry();
    const result = await run(device(), m, [tap('#go', 'Weiter')]);
    const fields = agentActionPathLogFields(result.actionPaths ?? emptyAgentActionPathCounts());
    expect(fields.halt_arm_structure).toBe(1);
    expect(fields.commit_facts_refreshed).toBe(1);
    for (const [key, value] of Object.entries(fields)) {
      expect(typeof value, key).toBe('number');
    }
    // Every closed label value has a field, so a new one cannot be added to the
    // metric and silently left off the line an operator actually greps.
    for (const outcome of COMMITMENT_FACTS_OUTCOMES) {
      expect(Object.keys(fields)).toContain(`commit_facts_${outcome}`);
    }
    for (const arm of CONSEQUENTIAL_HALT_ARMS) {
      expect(Object.keys(fields)).toContain(`halt_arm_${arm}`);
    }
  });
});
