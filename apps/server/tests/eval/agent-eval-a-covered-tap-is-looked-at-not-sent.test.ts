// THE LOOK BEFORE A TAP, against the DOM-backed device and the real loop.
//
// Two things are pinned here that the executor-level test cannot pin:
//
//  1. THE FAKE DEVICE MODELS perceive(selector) FAITHFULLY — resolved by the
//     same lookup its click uses, occluded exactly where its click would come
//     back intercepted (the fixture's own `overlays`), the cover's label as the
//     hit, outside-viewport / nothing-hit where the fixture declares them, and
//     an older device that ignores the selector. A device kinder or harsher than
//     its own click would make every number the eval reports about taps a fact
//     about the fixture.
//  2. THE LOOP USES IT. A tap on a covered control is not sent, the turn looks
//     again, closes the cover and finishes — where before the look the same
//     script died "intercepted" with no re-plan; and two spellings of one id-less
//     button are refused as one repeated step.
//
// Deterministic: virtual clock, scripted planner, no network.

import { describe, expect, it } from 'vitest';
import type { AgentIntent } from '@driftstack/api-types';
import {
  AgentRuntime,
  TURN_LOOP_STOP_SENTENCES,
  type RunTurnResult,
} from '../../src/services/agent-runtime.js';
import { ControlPlaneAgentExecutor } from '../../src/services/agent-executor-control-plane.js';
import type {
  DecomposeArgs,
  DecomposeResult,
  PlanStatus,
} from '../../src/services/agent-decomposer.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import { encodeWireData } from '../../src/services/harness-control-codec.js';
import { FakeDevice, PERCEIVE_BY_SELECTOR_MS } from './_lib/fake-device.js';
import { LIVE_SITES, type LiveSite } from './_lib/live-sites.js';
import { siteOf, type FixturePage } from './_lib/page-model.js';
import { queryFirst } from './_lib/dom.js';
import {
  EVAL_ARCHETYPE,
  EVAL_MAX_RETRIES,
  EVAL_OBSERVE_TIMEOUT_MS,
  EVAL_RETRY_DELAY_MS,
  EVAL_SESSION_ESTABLISH_RETRY_DELAY_MS,
  EVAL_TOKEN_BUDGET,
  countsAsElapsedBrowsingTime,
  evalRandom,
} from './_lib/runner.js';
import { VirtualClock } from './_lib/virtual-clock.js';

const SETTLE: AgentIntent = { kind: 'wait', condition: 'idle' };
const tap = (selector: string): AgentIntent => ({ kind: 'interact', action: 'tap', selector });

// ── the device, asked directly ────────────────────────────────────────

let seq = 0;
async function ask(
  device: FakeDevice,
  intentName: 'navigate' | 'perceive' | 'click',
  params: Record<string, unknown>,
) {
  seq += 1;
  return device.dispatcher.dispatch({
    type: 'intentDispatch',
    sessionId: 's',
    intentId: `i_${String(seq)}`,
    intentName,
    inputParams: encodeWireData(params),
  });
}

interface LookedAt {
  selector: string;
  label: string;
  occluded: boolean;
  occlusion_reason: string | null;
  hit: { label: string; selector: string } | null;
}

async function look(device: FakeDevice, selector: string): Promise<LookedAt[]> {
  const parsed = await ask(device, 'perceive', { selector, strategy: 'css' });
  if (!parsed.success) throw new Error(`perceive failed: ${parsed.errorCode ?? ''}`);
  return (parsed.outputData as { value: { elements: LookedAt[] } }).value.elements;
}

function mugsDevice(opts: { predatesTapLook?: boolean } = {}): FakeDevice {
  return new FakeDevice({
    sites: LIVE_SITES.mugs.pages,
    startUrl: 'https://mugs.test/',
    clock: new VirtualClock(),
    notFound: LIVE_SITES.mugs.notFound,
    ...opts,
  });
}

describe('the fake device models perceive(selector) as its own click resolves', () => {
  it('a covered control reads occluded, with the COVER as the hit — the same page its click calls intercepted', async () => {
    const device = mugsDevice();
    const [element] = await look(device, '#add-blue-mug');
    expect(element).toMatchObject({
      selector: '#add-blue-mug',
      occluded: true,
      occlusion_reason: 'hit_is_not_target_or_descendant',
      hit: { selector: '#onetrust-banner-sdk', label: 'Privacy' },
    });
    // And the click, asked the same question, agrees.
    const click = await ask(device, 'click', { strategy: 'css selector', value: '#add-blue-mug' });
    expect(click.success).toBe(false);
    expect(click.errorMessage).toBe('element click intercepted');
  });

  it('a control INSIDE the cover is clear, and it is its own hit', async () => {
    const [element] = await look(mugsDevice(), '#onetrust-accept-btn-handler');
    expect(element).toMatchObject({
      occluded: false,
      occlusion_reason: null,
      hit: { selector: '#onetrust-accept-btn-handler', label: 'Accept all' },
    });
  });

  it('once the cover is closed, the same control reads clear', async () => {
    const device = mugsDevice();
    await ask(device, 'click', { strategy: 'css selector', value: '#onetrust-accept-btn-handler' });
    const [element] = await look(device, '#add-blue-mug');
    expect(element?.occluded).toBe(false);
  });

  it('resolves ANY spelling to the first match, as click does, and names it canonically', async () => {
    const device = mugsDevice();
    const [loose] = await look(device, 'button.add-to-basket');
    // First match in document order — the red mug, exactly what the click takes.
    expect(loose?.selector).toBe('#add-red-mug');
    expect(loose?.label).toBe('Add Red mug to basket');
  });

  it('a selector that matches nothing resolves to NO element — and is marked as a resolved answer', async () => {
    const parsed = await ask(mugsDevice(), 'perceive', { selector: '#no-such', strategy: 'css' });
    expect(parsed.success).toBe(true);
    expect(parsed.outputData).toMatchObject({
      value: { elements: [], total_matched: 0, resolved_by: 'script' },
    });
  });

  it('an unparsable selector is refused the way click refuses it', async () => {
    const parsed = await ask(mugsDevice(), 'perceive', {
      selector: 'button:has-text(x)',
      strategy: 'css',
    });
    expect(parsed.success).toBe(false);
    expect(parsed.errorCode).toBe('intent_invalid_parameter');
  });

  it('a device that PREDATES the look lists the page and carries none of the new fields', async () => {
    const parsed = await ask(mugsDevice({ predatesTapLook: true }), 'perceive', {
      selector: '#add-blue-mug',
      strategy: 'css',
    });
    const value = (parsed.outputData as { value: Record<string, unknown> }).value;
    expect(value.resolved_by).toBeUndefined();
    const elements = value.elements as Array<Record<string, unknown>>;
    expect(elements.length).toBeGreaterThan(1);
    expect(elements.every((e) => !('occluded' in e) && !('hit' in e))).toBe(true);
  });

  it('…and caps that listing at max_elements, which the look sends as 1', async () => {
    const parsed = await ask(mugsDevice({ predatesTapLook: true }), 'perceive', {
      selector: '#add-blue-mug',
      strategy: 'css',
      max_elements: 1,
    });
    const value = (parsed.outputData as { value: Record<string, unknown> }).value;
    expect(value.resolved_by).toBeUndefined();
    expect(value.elements as unknown[]).toHaveLength(1);
    expect(value.truncated).toBe(true);
  });

  it('a look’s deadline that LOST its race leaves the clock — the page’s time does not jump by it', async () => {
    // Every tap races its look against a 2s deadline. A deadline that stayed
    // queued after the look answered would be pumped on the next macrotask and
    // move the page's clock forward by the whole timeout once per tap — a late
    // render would appear "sooner" for a reason that is not a fact about it.
    const clock = new VirtualClock();
    const timer = clock.deadline(2_000);
    timer.cancel();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(clock.now()).toBe(0);
    // CONTROL: one that was not cancelled does move it — the jump is real.
    const kept = clock.deadline(2_000);
    await kept.elapsed;
    expect(clock.now()).toBe(2_000);
  });

  it('an id-less element’s canonical selector resolves back to that same element', async () => {
    const page: FixturePage = {
      url: 'https://plain.test/',
      title: 'Plain',
      loadMs: 10,
      settleMs: 10,
      body: '<main><section class="compose"><p>Hi</p><button type="button" class="primary">Send</button></section></main>',
    };
    const device = new FakeDevice({
      sites: siteOf([page]),
      startUrl: page.url,
      clock: new VirtualClock(),
    });
    const [a] = await look(device, 'section.compose > button.primary');
    const [b] = await look(device, 'main button');
    expect(a?.selector).toBe(b?.selector);
    expect(a?.selector).not.toContain('primary');
    // The canonical spelling is one the click accepts, and it lands on the same button.
    const { PageDom, documentHtml } = await import('./_lib/dom.js');
    const dom = new PageDom(documentHtml(page), page.url);
    expect(queryFirst(dom.document, a?.selector ?? '')?.textContent).toBe('Send');
    dom.close();
  });

  it('outside the viewport and nothing-at-the-tap-point are reported where the fixture declares them', async () => {
    const page: FixturePage = {
      url: 'https://long.test/',
      title: 'Long',
      loadMs: 10,
      settleMs: 10,
      body: '<main><button id="top" type="button">Top</button><button id="far" type="button">Far down</button><button id="ghost" type="button">Ghost</button></main>',
      offViewport: ['#far'],
      nothingAtTapPoint: ['#ghost'],
    };
    const device = new FakeDevice({
      sites: siteOf([page]),
      startUrl: page.url,
      clock: new VirtualClock(),
    });
    expect((await look(device, '#far'))[0]).toMatchObject({
      occluded: true,
      occlusion_reason: 'tap_point_outside_viewport',
      hit: null,
    });
    expect((await look(device, '#ghost'))[0]).toMatchObject({
      occluded: true,
      occlusion_reason: 'nothing_hit',
      hit: null,
    });
    // The click is unaffected by either: it scrolls first.
    expect((await ask(device, 'click', { strategy: 'css selector', value: '#far' })).success).toBe(
      true,
    );
  });

  it('is deterministic and read-only: the same answer twice, the page untouched, a fixed cost', async () => {
    const device = mugsDevice();
    const before = device.visibleText();
    const first = await look(device, '#add-blue-mug');
    const second = await look(device, '#add-blue-mug');
    expect(second).toEqual(first);
    expect(device.visibleText()).toBe(before);
    expect(device.events()).toEqual([]);
    const costs = device.dispatches().map((d) => d.deviceMs);
    expect(costs).toEqual([PERCEIVE_BY_SELECTOR_MS, PERCEIVE_BY_SELECTOR_MS]);
  });
});

// ── the loop ──────────────────────────────────────────────────────────

interface Segment {
  intents: AgentIntent[];
  status: PlanStatus;
}

async function runTurn(
  site: LiveSite,
  script: Segment[],
  opts: { look: boolean },
): Promise<{
  result: RunTurnResult;
  device: FakeDevice;
  priorFailures: Array<string | undefined>;
}> {
  const clock = new VirtualClock(countsAsElapsedBrowsingTime);
  const device = new FakeDevice({
    sites: site.pages,
    startUrl: 'about:blank',
    clock,
    notFound: site.notFound,
  });
  let intentSeq = 0;
  const executor = new ControlPlaneAgentExecutor(
    device.dispatcher,
    () => `int_look_${(intentSeq += 1).toString()}`,
    {
      maxRetries: EVAL_MAX_RETRIES,
      retryDelayMs: EVAL_RETRY_DELAY_MS,
      sessionEstablishRetryDelayMs: EVAL_SESSION_ESTABLISH_RETRY_DELAY_MS,
      observeTimeoutMs: EVAL_OBSERVE_TIMEOUT_MS,
      planningObserveTimeoutMs: EVAL_OBSERVE_TIMEOUT_MS,
      sleep: clock.sleep,
      // Fixed, so a sequence assertion here is about traffic shape rather
      // than about which numbers the draws produced.
      makeRandom: () => evalRandom('eval-fixture'),
      deadline: clock.deadline,
      ...(opts.look ? {} : { preTapLookTimeoutMs: 0 }),
    },
  );
  const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-18T00:00:00.000Z'));
  const seed = await sessions.create({
    accountId: 'acc_eval_look',
    tokenBudgetTotal: EVAL_TOKEN_BUDGET,
  });
  const priorFailures: Array<string | undefined> = [];
  let calls = 0;
  const runtime = new AgentRuntime({
    decomposer: {
      decompose: (args: DecomposeArgs): Promise<DecomposeResult> => {
        calls += 1;
        priorFailures.push(args.priorFailure);
        const next = script[calls - 1] ?? { intents: [], status: 'done' as const };
        return Promise.resolve({ kind: 'plan', ...next, tokensConsumed: 900 });
      },
    },
    executor,
    sessions,
    archetype: EVAL_ARCHETYPE,
    nowMs: () => clock.now(),
  });
  const result = await runtime.runTurn({
    agentSessionId: seed.id,
    userMessage: 'add the blue mug to my basket',
    now: new Date('2026-09-18T00:00:00.000Z'),
  });
  return { result, device, priorFailures };
}

function executed(result: RunTurnResult): Extract<RunTurnResult, { kind: 'plan-executed' }> {
  if (result.kind !== 'plan-executed') throw new Error(`the turn was ${result.kind}`);
  return result;
}

describe('a covered control in the loop: looked at, not tapped, the cover closed, the task done', () => {
  // The planner aims straight at the product, blind to the consent banner; told
  // what covers it, it closes the banner and tries again.
  const script: Segment[] = [
    {
      intents: [{ kind: 'navigate', url: 'https://mugs.test/' }, SETTLE, tap('#add-blue-mug')],
      status: 'done',
    },
    { intents: [tap('#onetrust-accept-btn-handler'), tap('#add-blue-mug')], status: 'done' },
  ];

  it('the covered tap is never sent, the re-plan is told what is on top, and the basket fills', async () => {
    const { result, device, priorFailures } = await runTurn(LIVE_SITES.mugs, script, {
      look: true,
    });
    const turn = executed(result);
    expect(device.flags()).toContain('basket:blue-mug');
    expect(turn.executor.ok).toBe(true);
    expect(turn.executor.recoveredAfterReplan).toBe(true);
    const covered = turn.executor.results[2];
    if (covered?.kind !== 'failure') throw new Error('the first tap should have failed');
    expect(covered.diagnosis?.category).toBe('element_covered');
    // What the re-plan was told, in the customer's words.
    expect(priorFailures[1]).toContain('“Privacy” is covering this button, so nothing was tapped');
    // Only two taps reached the page: the banner's button and the product's.
    expect(
      device
        .events()
        .filter((e) => e.kind === 'clicked')
        .map((e) => e.selector),
    ).toEqual(['#onetrust-accept-btn-handler', '#add-blue-mug']);
  });

  it('CONTROL — without the look, the same script dies on the device’s intercepted click and is never re-planned', async () => {
    const { result, device, priorFailures } = await runTurn(LIVE_SITES.mugs, script, {
      look: false,
    });
    const turn = executed(result);
    expect(device.flags()).not.toContain('basket:blue-mug');
    expect(priorFailures).toHaveLength(1);
    const last = turn.executor.results.at(-1);
    if (last?.kind !== 'failure') throw new Error('expected the tap to fail');
    expect(last.diagnosis?.category).toBe('unknown');
  });
});

describe('the repeat guard, told what a tap lands on, sees two spellings of one button', () => {
  // An id-less Send button whose tap changes nothing the look can see (a toast
  // that is not in the document), so a second tap is "the same thing again".
  const page: FixturePage = {
    url: 'https://notes.test/',
    title: 'Notes',
    loadMs: 50,
    settleMs: 50,
    body: '<main><section class="compose"><textarea name="note" placeholder="Note"></textarea><button type="button" class="primary" aria-label="Send note">Send</button></section></main>',
    onClick: [
      { target: 'section.compose > button', effects: [{ kind: 'set_flag', flag: 'sent' }] },
    ],
  };
  const site: LiveSite = { pages: siteOf([page]), notFound: { httpStatus: 404 } };
  const script: Segment[] = [
    { intents: [{ kind: 'navigate', url: 'https://notes.test/' }, SETTLE], status: 'continue' },
    { intents: [tap('section.compose > button.primary')], status: 'continue' },
    // The planner, shown the unchanged page, spells the same button another way
    // — and says it would carry on after it, so the refusal alone ends the turn.
    { intents: [tap('[aria-label="Send note"]')], status: 'continue' },
    { intents: [tap('[aria-label="Send note"]')], status: 'done' },
  ];

  it('the second spelling is REFUSED before it is sent, and the turn says why', async () => {
    const { result, device, priorFailures } = await runTurn(site, script, { look: true });
    const clicks = device.events().filter((e) => e.kind === 'clicked');
    expect(clicks).toHaveLength(1);
    // The turn ENDS there: no fourth plan is asked for after the refusal.
    expect(priorFailures).toHaveLength(3);
    const turn = executed(result);
    expect(turn.executor.repeatRefused).toBe('no_progress');
    expect(turn.notice).toBe(TURN_LOOP_STOP_SENTENCES.no_progress);
  });

  it('CONTROL — compared by spelling alone, the same button is pressed twice', async () => {
    const { device } = await runTurn(site, script, { look: false });
    expect(device.events().filter((e) => e.kind === 'clicked')).toHaveLength(2);
  });
});
