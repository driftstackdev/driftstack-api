// A TAP THE LOOK CANNOT SEE IS CHECKED WHERE IT LANDS — against the DOM-backed
// device and the real loop.
//
// The look before a tap never scrolls, so a control below the fold reads
// "outside the viewport" and, until click `require_unoccluded` (V-3358), was
// tapped unchecked: the click scrolled it into view and tapped whatever the
// scroll had put on top — a sticky offer bar, a chat button. Two things are
// pinned here that the executor-level test cannot pin:
//
//  1. THE FAKE DEVICE MODELS THE CHECK FAITHFULLY — the exact refusal message,
//     each reason where the fixture declares its cause (a cover that arrives
//     with the scroll, an overlay, nothing at the point, an element replaced
//     before the tap, a check that cannot run and fails closed), the legacy
//     code the production box sends today and the dedicated one, and a device
//     that predates the parameter and taps unchecked.
//  2. THE LOOP USES IT. An approved purchase whose button is covered once
//     scrolled to is REFUSED — nothing is bought, neither the order nor the
//     offer on top of it — and the customer is ASKED AGAIN rather than the
//     approval being carried into a plan they never saw. Against a device that
//     predates the check, the same approval buys the offer instead: the unsafe
//     behaviour this closes.
//
// ⚠️ An ARM, not a corpus task: the scripted corpus's plans are run once and
// never approved, so a purchase there always halts before any tap. Adding the
// approval flow to the corpus runner would move every rate for a reason that is
// not a fact about the tasks. The baseline is unchanged by this round.
//
// Deterministic: virtual clock, scripted planner, no network.

import { describe, expect, it } from 'vitest';
import type { AgentIntent } from '@driftstack/api-types';
import { AgentRuntime, type RunTurnResult } from '../../src/services/agent-runtime.js';
import { ControlPlaneAgentExecutor } from '../../src/services/agent-executor-control-plane.js';
import { consequentialSignature } from '../../src/services/agent-executor.js';
import type {
  DecomposeArgs,
  DecomposeResult,
  PlanStatus,
} from '../../src/services/agent-decomposer.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import { TARGET_UNVERIFIED_REASON } from '../../src/services/agent-intent-result.js';
import { encodeWireData } from '../../src/services/harness-control-codec.js';
import {
  FakeDevice,
  TAP_REFUSAL_MESSAGE_PREFIX,
  type FakeDeviceOptions,
} from './_lib/fake-device.js';
import { siteOf, type FixturePage } from './_lib/page-model.js';
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
import { classifyDispatchDeath } from './_lib/score.js';

const SETTLE: AgentIntent = { kind: 'wait', condition: 'idle' };
const tap = (selector: string): AgentIntent => ({ kind: 'interact', action: 'tap', selector });

// ── the pages ─────────────────────────────────────────────────────────

/** A checkout whose Place order button is below the fold, and whose sticky
 *  offer bar sits exactly where the click's scroll puts it. */
const CHECKOUT: FixturePage = {
  url: 'https://till.test/checkout',
  title: 'Checkout',
  loadMs: 50,
  settleMs: 50,
  body:
    '<main><h1>Checkout</h1><p>Blue mug — £12</p><button id="place-order" type="button">Place order</button>' +
    '<aside id="offer"><button id="add-protection" type="button">Add 2-year protection for £49</button>' +
    '<button id="close-offer" type="button" aria-label="Close offer">×</button></aside></main>',
  offViewport: ['#place-order'],
  coveredAfterScroll: [{ target: '#place-order', cover: '#add-protection' }],
  onClick: [
    { target: '#place-order', effects: [{ kind: 'set_flag', flag: 'bought:order' }] },
    { target: '#add-protection', effects: [{ kind: 'set_flag', flag: 'bought:protection' }] },
    { target: '#close-offer', effects: [{ kind: 'remove', target: '#offer' }] },
  ],
};

/** A form whose Continue is below the fold, under a floating chat button once
 *  scrolled to — nothing consequential, just the wrong thing to tap. */
const FORM: FixturePage = {
  url: 'https://till.test/details',
  title: 'Your details',
  loadMs: 50,
  settleMs: 50,
  body:
    '<main><h1>Your details</h1><button id="continue" type="button">Continue</button>' +
    '<div id="chat"><button id="open-chat" type="button">Chat with us</button>' +
    '<button id="hide-chat" type="button" aria-label="Hide chat">–</button></div></main>',
  offViewport: ['#continue'],
  coveredAfterScroll: [{ target: '#continue', cover: '#open-chat' }],
  onClick: [
    { target: '#continue', effects: [{ kind: 'set_flag', flag: 'details:continued' }] },
    { target: '#open-chat', effects: [{ kind: 'set_flag', flag: 'chat:opened' }] },
    { target: '#hide-chat', effects: [{ kind: 'remove', target: '#chat' }] },
  ],
};

/** Every declared cause of a refusal, one element each. */
const CAUSES: FixturePage = {
  url: 'https://causes.test/',
  title: 'Causes',
  loadMs: 10,
  settleMs: 10,
  body:
    '<main><button id="clear" type="button">Clear</button><button id="far" type="button">Far down</button>' +
    '<button id="under" type="button">Under</button><button id="ghost" type="button">Ghost</button>' +
    '<button id="swapped" type="button">Swapped</button>' +
    '<div id="banner"><button id="accept" type="button">Accept</button></div></main>',
  offViewport: ['#far'],
  overlays: [],
  nothingAtTapPoint: ['#ghost'],
  detachedAtTap: ['#swapped'],
  onClick: [
    { target: '#swapped', effects: [{ kind: 'set_flag', flag: 'swapped:tapped' }] },
    { target: '#clear', effects: [{ kind: 'set_flag', flag: 'clear:tapped' }] },
  ],
};
/** A styled checkbox below the fold: its input is visually hidden inside its
 *  `<label>`, so every tap on it lands on the label — which toggles it. */
const TERMS: FixturePage = {
  url: 'https://till.test/terms',
  title: 'Terms',
  loadMs: 50,
  settleMs: 50,
  body:
    '<main><h1>Terms</h1><label><input id="agree" type="checkbox"><span>I agree to the terms</span></label>' +
    '<label for="news">Send me offers</label><input id="news" type="checkbox"></main>',
  offViewport: ['#agree'],
  tapPointOnOwnLabel: ['#agree', '#news'],
  onClick: [
    { target: '#agree', effects: [{ kind: 'set_flag', flag: 'terms:agreed' }] },
    { target: '#news', effects: [{ kind: 'set_flag', flag: 'news:ticked' }] },
  ],
};

/** The same page with a banner over everything outside it. */
const CAUSES_WITH_BANNER: FixturePage = { ...CAUSES, overlays: ['#banner'] };

/** A styled checkbox below the fold whose label has a "terms" LINK written into
 *  it — and the click's tap point lands on the link. HTML gives that tap to the
 *  link, not the checkbox: an unchecked tap opens the terms page. */
const TERMS_LINK: FixturePage = {
  url: 'https://till.test/accept',
  title: 'Accept',
  loadMs: 50,
  settleMs: 50,
  body:
    '<main><h1>Accept</h1><label><input id="accept" type="checkbox">' +
    '<span id="accept-text">I accept the </span><a id="terms-link" href="https://till.test/terms-doc">terms</a>' +
    '</label><label><input id="promo" type="checkbox"><span id="promo-text">Send me offers</span></label></main>',
  offViewport: ['#accept'],
  tapPointInsideOwnLabel: [
    { target: '#accept', hit: '#terms-link' },
    { target: '#promo', hit: '#promo-text' },
  ],
  onClick: [
    { target: '#accept', effects: [{ kind: 'set_flag', flag: 'terms:accepted' }] },
    { target: '#terms-link', effects: [{ kind: 'set_flag', flag: 'terms:opened' }] },
    { target: '#promo', effects: [{ kind: 'set_flag', flag: 'promo:ticked' }] },
  ],
};

/** A sign-up form whose email field is below the fold, under a floating chat
 *  button once the focus tap's scroll brings it up. */
const SIGNUP: FixturePage = {
  url: 'https://till.test/signup',
  title: 'Sign up',
  loadMs: 50,
  settleMs: 50,
  body:
    '<main><h1>Sign up</h1><form><input id="email" name="email" type="email"></form>' +
    '<div id="chat"><button id="open-chat" type="button">Chat with us</button>' +
    '<button id="hide-chat" type="button" aria-label="Hide chat">–</button></div></main>',
  offViewport: ['#email'],
  coveredAfterScroll: [{ target: '#email', cover: '#open-chat' }],
  onClick: [
    { target: '#open-chat', effects: [{ kind: 'set_flag', flag: 'chat:opened' }] },
    { target: '#hide-chat', effects: [{ kind: 'remove', target: '#chat' }] },
  ],
};

// ── the device, asked directly ────────────────────────────────────────

let seq = 0;
function click(device: FakeDevice, selector: string, requireUnoccluded?: boolean) {
  seq += 1;
  return device.dispatcher.dispatch({
    type: 'intentDispatch',
    sessionId: 's',
    intentId: `i_${String(seq)}`,
    intentName: 'click',
    inputParams: encodeWireData({
      strategy: 'css selector',
      value: selector,
      ...(requireUnoccluded === undefined ? {} : { require_unoccluded: requireUnoccluded }),
    }),
  });
}

function typeInto(device: FakeDevice, selector: string, text: string, requireUnoccluded?: boolean) {
  seq += 1;
  return device.dispatcher.dispatch({
    type: 'intentDispatch',
    sessionId: 's',
    intentId: `i_${String(seq)}`,
    intentName: 'send_keys',
    inputParams: encodeWireData({
      strategy: 'css selector',
      value: selector,
      text,
      ...(requireUnoccluded === undefined ? {} : { require_unoccluded: requireUnoccluded }),
    }),
  });
}

async function perceiveOne(device: FakeDevice, selector: string) {
  seq += 1;
  const answer = await device.dispatcher.dispatch({
    type: 'intentDispatch',
    sessionId: 's',
    intentId: `i_${String(seq)}`,
    intentName: 'perceive',
    inputParams: encodeWireData({ selector }),
  });
  const value = (answer.outputData as { value: { elements: Array<Record<string, unknown>> } })
    .value;
  return value.elements[0];
}

function typedFields(device: FakeDevice): Array<string | null> {
  return device.events().flatMap((e) => (e.kind === 'typed' ? [e.field] : []));
}

function deviceOn(page: FixturePage, opts: Partial<FakeDeviceOptions> = {}): FakeDevice {
  return new FakeDevice({
    sites: siteOf([page]),
    startUrl: page.url,
    clock: new VirtualClock(),
    ...opts,
  });
}

function clickedIds(device: FakeDevice): string[] {
  return device.events().flatMap((e) => (e.kind === 'clicked' ? [e.id] : []));
}

describe('the fake device models click require_unoccluded as the harness describes it', () => {
  it('a cover that ARRIVES WITH THE SCROLL: the look said off-screen; the checked click is refused, word for word, and nothing is touched', async () => {
    const device = deviceOn(CHECKOUT);
    const refused = await click(device, '#place-order', true);
    expect(refused.success).toBe(false);
    // The production box today: the coarse code, the exact message.
    expect(refused.errorCode).toBe('intent_webdriver_failed');
    expect(refused.errorMessage).toBe(
      'element occluded at the tap point: hit_is_not_target_or_descendant',
    );
    expect(device.events()).toEqual([]);
    expect(device.flags().size).toBe(0);
  });

  it('…and where the node arms the dedicated code, the same refusal carries intent_element_occluded', async () => {
    const refused = await click(
      deviceOn(CHECKOUT, { elementOccludedCode: true }),
      '#place-order',
      true,
    );
    expect(refused.errorCode).toBe('intent_element_occluded');
    expect(refused.errorMessage).toBe(
      `${TAP_REFUSAL_MESSAGE_PREFIX}hit_is_not_target_or_descendant`,
    );
  });

  it('UNCHECKED, the same click reports a tap — and the tap landed on the cover, which bought the offer', async () => {
    const device = deviceOn(CHECKOUT);
    const tapped = await click(device, '#place-order');
    expect(tapped.success).toBe(true);
    expect(clickedIds(device)).toEqual(['add-protection']);
    expect(device.hasFlag('bought:protection')).toBe(true);
    expect(device.hasFlag('bought:order')).toBe(false);
  });

  it('require_unoccluded: false is the unchecked click', async () => {
    const device = deviceOn(CHECKOUT);
    expect((await click(device, '#place-order', false)).success).toBe(true);
    expect(device.hasFlag('bought:protection')).toBe(true);
  });

  it('a device that PREDATES the parameter ignores it and taps unchecked', async () => {
    const device = deviceOn(CHECKOUT, { predatesRequireUnoccluded: true });
    expect((await click(device, '#place-order', true)).success).toBe(true);
    expect(clickedIds(device)).toEqual(['add-protection']);
  });

  it('once the cover is closed, the checked click taps the button itself', async () => {
    const device = deviceOn(CHECKOUT);
    await click(device, '#close-offer', true);
    expect((await click(device, '#place-order', true)).success).toBe(true);
    expect(device.hasFlag('bought:order')).toBe(true);
    expect(device.hasFlag('bought:protection')).toBe(false);
  });

  it('off-screen ALONE is not a refusal — the click scrolled it into view', async () => {
    const device = deviceOn(CAUSES);
    expect((await click(device, '#far', true)).success).toBe(true);
  });

  it('a clear control with the check is tapped as before', async () => {
    const device = deviceOn(CAUSES);
    expect((await click(device, '#clear', true)).success).toBe(true);
    expect(device.hasFlag('clear:tapped')).toBe(true);
  });

  it('a declared OVERLAY: refused hit_is_not_target_or_descendant checked; intercepted unchecked, as before', async () => {
    const checked = await click(deviceOn(CAUSES_WITH_BANNER), '#clear', true);
    expect(checked.errorMessage).toBe(
      'element occluded at the tap point: hit_is_not_target_or_descendant',
    );
    const unchecked = await click(deviceOn(CAUSES_WITH_BANNER), '#clear');
    expect(unchecked.errorMessage).toBe('element click intercepted');
  });

  it('NOTHING at the tap point: refused nothing_hit checked; tapped unchecked', async () => {
    const checked = await click(deviceOn(CAUSES), '#ghost', true);
    expect(checked.errorMessage).toBe('element occluded at the tap point: nothing_hit');
    expect((await click(deviceOn(CAUSES), '#ghost')).success).toBe(true);
  });

  it('REPLACED before the tap: refused target_not_resolved checked; unchecked, the tap lands where it was and activates nothing', async () => {
    const device = deviceOn(CAUSES);
    const checked = await click(device, '#swapped', true);
    expect(checked.errorMessage).toBe('element occluded at the tap point: target_not_resolved');
    const unchecked = await click(device, '#swapped');
    expect(unchecked.success).toBe(true);
    expect(unchecked.outputData).toMatchObject({ activated: false });
    expect(device.hasFlag('swapped:tapped')).toBe(false);
  });

  it('a check that CANNOT RUN fails closed: even a clear control is refused, nothing tapped', async () => {
    const device = deviceOn(CAUSES, { occlusionCheckUnavailable: true });
    const refused = await click(device, '#clear', true);
    expect(refused.errorMessage).toBe(
      'element occluded at the tap point: occlusion_check_unavailable',
    );
    expect(device.events()).toEqual([]);
    // Unchecked, the same device taps: the fault is the check's, not the tap's.
    expect((await click(device, '#clear')).success).toBe(true);
  });

  it('a selector that matches nothing, or cannot be parsed, gets the click’s own answer — the lookup runs first', async () => {
    const device = deviceOn(CAUSES, { occlusionCheckUnavailable: true });
    expect((await click(device, '#no-such', true)).errorCode).toBe('intent_element_not_found');
    expect((await click(device, 'button:has-text(x)', true)).errorCode).toBe(
      'intent_invalid_parameter',
    );
  });

  it('a tap point on the control’s OWN LABEL: a device with the own-label verdict taps it checked, and the label toggles it', async () => {
    for (const selector of ['#agree', '#news']) {
      const device = deviceOn(TERMS);
      expect((await click(device, selector, true)).success).toBe(true);
      expect(clickedIds(device)).toEqual([selector.slice(1)]);
    }
  });

  it('…a device that PREDATES the own-label verdict has no such rule, so it refuses — unchecked, the label toggles it', async () => {
    for (const selector of ['#agree', '#news']) {
      const device = deviceOn(TERMS, { predatesOwnLabelVerdict: true });
      const checked = await click(device, selector, true);
      expect(checked.errorMessage).toBe(
        'element occluded at the tap point: hit_is_not_target_or_descendant',
      );
      expect(device.events()).toEqual([]);
      expect((await click(device, selector)).success).toBe(true);
      expect(clickedIds(device)).toEqual([selector.slice(1)]);
    }
  });

  it('…and perceive on the own-label build reports the label as a CLEAR hit, by its own label', async () => {
    expect(await perceiveOne(deviceOn(TERMS), '#news')).toMatchObject({
      type: 'checkbox',
      label: 'Send me offers',
      occluded: false,
      occlusion_reason: null,
      hit_via_own_label: true,
      hit: { type: 'other', label: 'Send me offers' },
    });
    // Every element from that build carries the field — it is the build's tell.
    expect(await perceiveOne(deviceOn(CAUSES), '#clear')).toMatchObject({
      hit_via_own_label: false,
    });
    expect(await perceiveOne(deviceOn(CAUSES), '#far')).toMatchObject({
      occlusion_reason: 'tap_point_outside_viewport',
      hit_via_own_label: false,
    });
  });

  it('…while perceive on an older build reports the label as the hit, occluded, with no field', async () => {
    const device = deviceOn(TERMS, { predatesOwnLabelVerdict: true });
    expect(await perceiveOne(device, '#news')).not.toHaveProperty('hit_via_own_label');
    const answer = await device.dispatcher.dispatch({
      type: 'intentDispatch',
      sessionId: 's',
      intentId: 'i_label_look',
      intentName: 'perceive',
      inputParams: encodeWireData({ selector: '#news' }),
    });
    expect(answer.outputData).toMatchObject({
      value: {
        elements: [
          {
            type: 'checkbox',
            label: 'Send me offers',
            occluded: true,
            occlusion_reason: 'hit_is_not_target_or_descendant',
            hit: { type: 'other', label: 'Send me offers' },
          },
        ],
      },
    });
  });

  it('a LINK inside the own label is interactive content: covered to perceive and to the check, and an unchecked tap opens it', async () => {
    const device = deviceOn({ ...TERMS_LINK, offViewport: [] });
    expect(await perceiveOne(device, '#accept')).toMatchObject({
      occluded: true,
      occlusion_reason: 'hit_is_not_target_or_descendant',
      hit_via_own_label: false,
      hit: { type: 'link', selector: '#terms-link' },
    });
    const checked = await click(device, '#accept', true);
    expect(checked.errorMessage).toBe(
      'element occluded at the tap point: hit_is_not_target_or_descendant',
    );
    expect(device.events()).toEqual([]);
    expect((await click(device, '#accept')).success).toBe(true);
    expect(device.hasFlag('terms:opened')).toBe(true);
    expect(device.hasFlag('terms:accepted')).toBe(false);
  });

  it('a NON-interactive span inside the own label forwards the tap like the label: clear, and it toggles', async () => {
    const device = deviceOn(TERMS_LINK);
    expect(await perceiveOne(device, '#promo')).toMatchObject({
      occluded: false,
      hit_via_own_label: true,
      hit: { label: 'Send me offers' },
    });
    expect((await click(device, '#promo', true)).success).toBe(true);
    expect(device.hasFlag('promo:ticked')).toBe(true);
  });

  it('a hit declared inside a label that is NOT the control’s own is a fixture bug, and throws', async () => {
    const device = deviceOn({
      ...TERMS_LINK,
      tapPointInsideOwnLabel: [{ target: '#accept', hit: '#promo-text' }],
    });
    await expect(click(device, '#accept', true)).rejects.toThrow(/not/);
  });

  it('a refusal costs the device a lookup and a check, never a tap', async () => {
    const device = deviceOn(CHECKOUT);
    await click(device, '#place-order', true);
    const [record] = device.dispatches();
    expect(record?.deviceMs).toBe(60);
    expect(record?.params).toMatchObject({ require_unoccluded: true });
  });
});

// ── the loop ──────────────────────────────────────────────────────────

interface Segment {
  intents: AgentIntent[];
  status: PlanStatus;
}

function harness(
  page: FixturePage,
  script: Segment[],
  deviceOpts: Partial<FakeDeviceOptions> = {},
) {
  const clock = new VirtualClock(countsAsElapsedBrowsingTime);
  const device = new FakeDevice({
    sites: siteOf([page]),
    startUrl: 'about:blank',
    clock,
    notFound: { httpStatus: 404 },
    ...deviceOpts,
  });
  let intentSeq = 0;
  const executor = new ControlPlaneAgentExecutor(
    device.dispatcher,
    () => `int_check_${(intentSeq += 1).toString()}`,
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
    },
  );
  const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-18T00:00:00.000Z'));
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
  let seedId: string | null = null;
  const turn = async (
    userMessage: string,
    approvals?: ReadonlySet<string>,
  ): Promise<Extract<RunTurnResult, { kind: 'plan-executed' }>> => {
    seedId ??= (
      await sessions.create({ accountId: 'acc_eval_check', tokenBudgetTotal: EVAL_TOKEN_BUDGET })
    ).id;
    const result = await runtime.runTurn({
      agentSessionId: seedId,
      userMessage,
      now: new Date('2026-09-18T00:00:00.000Z'),
      ...(approvals !== undefined ? { approvedConsequentialActions: approvals } : {}),
    });
    if (result.kind !== 'plan-executed') throw new Error(`the turn was ${result.kind}`);
    return result;
  };
  const lastAgentEntry = async () => {
    if (seedId === null) throw new Error('no turn has run');
    return (await sessions.get(seedId))?.transcript.filter((e) => e.role === 'agent').at(-1);
  };
  return { device, turn, priorFailures, lastAgentEntry, decomposeCalls: () => calls };
}

/** The signature a halt asks the customer to approve, as the route builds it. */
function approvalFor(turn: Extract<RunTurnResult, { kind: 'plan-executed' }>): Set<string> {
  const halt = turn.executor.results.at(-1);
  if (halt?.kind !== 'confirmation_required') throw new Error('expected a halt');
  return new Set([consequentialSignature(halt.category, halt.matchedText)]);
}

function clickDispatches(device: FakeDevice) {
  return device.dispatches().filter((d) => d.intentName === 'click');
}

describe('an approved purchase whose button is covered once scrolled to', () => {
  const BUY: Segment = {
    intents: [{ kind: 'navigate', url: CHECKOUT.url }, SETTLE, tap('#place-order')],
    status: 'done',
  };
  // Only reached if the customer is asked again and approves again: it closes
  // the offer first, which is a step they will now have seen.
  const CLOSE_THEN_BUY: Segment = {
    intents: [tap('#close-offer'), tap('#place-order')],
    status: 'done',
  };

  it('⛔ the purchase is HALTED first, with nothing sent to the button', async () => {
    const { device, turn } = harness(CHECKOUT, [BUY]);
    const halted = await turn('buy the blue mug');
    expect(halted.executor.awaitingConfirmation).toBe(true);
    expect(clickDispatches(device)).toEqual([]);
  });

  it('APPROVED, the tap is checked where it lands and REFUSED: nothing is bought — not the order, not the offer on top', async () => {
    const { device, turn } = harness(CHECKOUT, [BUY]);
    const approvals = approvalFor(await turn('buy the blue mug'));
    const resumed = await turn('yes, place the order', approvals);
    expect(device.hasFlag('bought:order')).toBe(false);
    expect(device.hasFlag('bought:protection')).toBe(false);
    expect(clickedIds(device)).toEqual([]);
    const [sent] = clickDispatches(device);
    expect(sent?.params).toEqual({
      strategy: 'css selector',
      value: '#place-order',
      require_unoccluded: true,
    });
    expect(sent?.errorMessage).toBe(
      'element occluded at the tap point: hit_is_not_target_or_descendant',
    );
    const step = resumed.executor.results.at(-1);
    if (step?.kind !== 'failure') throw new Error('expected the approved tap to fail');
    expect(step.diagnosis).toEqual({ category: 'element_covered', retryable: false });
    expect(step.reason).toContain('nothing was tapped');
    // Not retried, and — an approval resume never loops — not re-planned.
    expect(clickDispatches(device)).toHaveLength(1);
  });

  it('⛔ the approval is NOT carried forward: the transcript shows nothing awaiting it, and the customer is ASKED AGAIN', async () => {
    const { device, turn, lastAgentEntry, decomposeCalls } = harness(CHECKOUT, [
      BUY,
      CLOSE_THEN_BUY,
    ]);
    const approvals = approvalFor(await turn('buy the blue mug'));
    await turn('yes, place the order', approvals);
    const afterRefusal = await lastAgentEntry();
    expect(afterRefusal?.awaitingConfirmation).not.toBe(true);
    expect(decomposeCalls()).toBe(1);

    // The same approval sent again resumes nothing: a fresh plan is made, and
    // its purchase step halts for a new confirmation before anything is sent.
    const again = await turn('yes, place the order', approvals);
    expect(decomposeCalls()).toBe(2);
    expect(again.executor.awaitingConfirmation).toBe(true);
    const halt = again.executor.results.at(-1);
    expect(halt?.kind === 'confirmation_required' && halt.intent).toEqual(tap('#place-order'));
    // The offer was closed by the new plan's first step; the order is still
    // not placed, because it has not been approved again.
    expect(device.hasFlag('bought:order')).toBe(false);
    expect(device.hasFlag('bought:protection')).toBe(false);

    // Approved again, for the plan the customer has now seen: it goes through.
    await turn('yes', approvalFor(again));
    expect(device.hasFlag('bought:order')).toBe(true);
    expect(device.hasFlag('bought:protection')).toBe(false);
  });

  it('CONTROL — against a device that PREDATES the check, the same approval buys the OFFER instead (the unsafe behaviour this closes)', async () => {
    const { device, turn } = harness(CHECKOUT, [BUY], { predatesRequireUnoccluded: true });
    const approvals = approvalFor(await turn('buy the blue mug'));
    const resumed = await turn('yes, place the order', approvals);
    expect(device.hasFlag('bought:protection')).toBe(true);
    expect(device.hasFlag('bought:order')).toBe(false);
    // And the step reported success: nothing told the customer.
    expect(resumed.executor.results.at(-1)?.kind).toBe('success');
  });
});

describe('an ordinary off-screen tap covered once scrolled to', () => {
  const script: Segment[] = [
    {
      intents: [{ kind: 'navigate', url: FORM.url }, SETTLE, tap('#continue')],
      status: 'done',
    },
    { intents: [tap('#hide-chat'), tap('#continue')], status: 'done' },
  ];

  it('is refused, the re-plan is told something is covering it, closes it, and the task is done', async () => {
    const { device, turn, priorFailures } = harness(FORM, script);
    const done = await turn('continue to the next step');
    expect(done.executor.ok).toBe(true);
    expect(done.executor.recoveredAfterReplan).toBe(true);
    expect(device.hasFlag('details:continued')).toBe(true);
    expect(device.hasFlag('chat:opened')).toBe(false);
    expect(priorFailures[1]).toContain('nothing was tapped');
    expect(clickedIds(device)).toEqual(['hide-chat', 'continue']);
  });

  it('CONTROL — a device that predates the check opens the chat and reports the step done', async () => {
    const { device, turn } = harness(FORM, script, { predatesRequireUnoccluded: true });
    const done = await turn('continue to the next step');
    expect(done.executor.ok).toBe(true);
    expect(device.hasFlag('chat:opened')).toBe(true);
    expect(device.hasFlag('details:continued')).toBe(false);
  });

  it('a device whose check CANNOT RUN refuses the tap; the re-plan is told it could not be confirmed, not that it is covered', async () => {
    const { device, turn, priorFailures } = harness(FORM, script, {
      occlusionCheckUnavailable: true,
    });
    await turn('continue to the next step');
    expect(device.hasFlag('chat:opened')).toBe(false);
    expect(priorFailures[1]).toContain(TARGET_UNVERIFIED_REASON);
    expect(priorFailures[1]).not.toContain('covering');
  });
});

describe('⛔ on a device that predates the own-label verdict, a styled checkbox still toggles', () => {
  // That device's check refuses a hit on the control's own label, which is
  // where every tap on a styled checkbox lands. Sent the check, this step
  // would be refused as "covered" and the identical re-plan would end the turn.
  const script: Segment[] = [
    {
      intents: [{ kind: 'navigate', url: TERMS.url }, SETTLE, tap('#agree'), tap('#news')],
      status: 'done',
    },
  ];

  it('below the fold AND on-screen, it is tapped unchecked and toggles, first time, with no re-plan', async () => {
    const { device, turn, decomposeCalls } = harness(TERMS, script, {
      predatesOwnLabelVerdict: true,
    });
    const done = await turn('accept the terms and sign up for offers');
    expect(done.executor.ok).toBe(true);
    expect(device.hasFlag('terms:agreed')).toBe(true);
    expect(device.hasFlag('news:ticked')).toBe(true);
    expect(decomposeCalls()).toBe(1);
    expect(clickDispatches(device).map((d) => d.params)).toEqual([
      { strategy: 'css selector', value: '#agree' },
      { strategy: 'css selector', value: '#news' },
    ]);
  });
});

describe('the fake device models send_keys require_unoccluded as the harness describes it (V-3360)', () => {
  it('a field covered once its focus tap scrolls to it: refused word for word, and NOTHING is typed', async () => {
    const device = deviceOn(SIGNUP);
    const refused = await typeInto(device, '#email', 'me@example.test', true);
    expect(refused.success).toBe(false);
    expect(refused.errorCode).toBe('intent_webdriver_failed');
    expect(refused.errorMessage).toBe(
      'element occluded at the tap point: hit_is_not_target_or_descendant',
    );
    expect(device.events()).toEqual([]);
    expect(device.flags().size).toBe(0);
  });

  it('a clear field with the check is typed into, and the result says the focus tap was checked', async () => {
    const device = deviceOn({ ...SIGNUP, coveredAfterScroll: [] });
    const typed = await typeInto(device, '#email', 'me@example.test', true);
    expect(typed.outputData).toMatchObject({ focus_tap_unoccluded_checked: true, length: 15 });
    expect(typedFields(device)).toEqual(['email']);
  });

  it('WITHOUT the check the result says so — false — and types as before', async () => {
    const device = deviceOn(SIGNUP);
    const typed = await typeInto(device, '#email', 'me@example.test');
    expect(typed.outputData).toMatchObject({ focus_tap_unoccluded_checked: false });
    expect(typedFields(device)).toEqual(['email']);
  });

  it('the native no-persona path focuses by script: NO TAP, so nothing is checked — false, and typed', async () => {
    const device = deviceOn(SIGNUP, { sendKeysFocusesByScript: true });
    const typed = await typeInto(device, '#email', 'me@example.test', true);
    expect(typed.success).toBe(true);
    expect(typed.outputData).toMatchObject({ focus_tap_unoccluded_checked: false });
    expect(typedFields(device)).toEqual(['email']);
  });

  it('a device that PREDATES the build ignores the parameter, types, and never sends the field', async () => {
    const device = deviceOn(SIGNUP, { predatesOwnLabelVerdict: true });
    const typed = await typeInto(device, '#email', 'me@example.test', true);
    expect(typed.success).toBe(true);
    expect(typed.outputData).not.toHaveProperty('focus_tap_unoccluded_checked');
    expect(typedFields(device)).toEqual(['email']);
  });

  it('each older option implies the older build: no field from a device that predates the look or the click check', async () => {
    for (const older of [{ predatesTapLook: true }, { predatesRequireUnoccluded: true }]) {
      const typed = await typeInto(deviceOn(SIGNUP, older), '#email', 'x', true);
      expect(typed.outputData).not.toHaveProperty('focus_tap_unoccluded_checked');
    }
  });
});

describe('the loop, on the own-label build', () => {
  it('a styled checkbox OFF-SCREEN now carries the check and toggles; the on-screen one, clear through its label, taps as before', async () => {
    const { device, turn, decomposeCalls } = harness(TERMS, [
      {
        intents: [{ kind: 'navigate', url: TERMS.url }, SETTLE, tap('#agree'), tap('#news')],
        status: 'done',
      },
    ]);
    const done = await turn('accept the terms and sign up for offers');
    expect(done.executor.ok).toBe(true);
    expect(device.hasFlag('terms:agreed')).toBe(true);
    expect(device.hasFlag('news:ticked')).toBe(true);
    expect(decomposeCalls()).toBe(1);
    expect(clickDispatches(device).map((d) => d.params)).toEqual([
      { strategy: 'css selector', value: '#agree', require_unoccluded: true },
      { strategy: 'css selector', value: '#news' },
    ]);
  });

  it('⛔ a "terms" LINK inside the checkbox’s label, where the tap would land: refused as covered — the terms page is not opened, the box not ticked', async () => {
    const { device, turn } = harness(TERMS_LINK, [
      {
        intents: [{ kind: 'navigate', url: TERMS_LINK.url }, SETTLE, tap('#accept')],
        status: 'done',
      },
    ]);
    const done = await turn('accept the terms');
    expect(device.hasFlag('terms:opened')).toBe(false);
    expect(device.hasFlag('terms:accepted')).toBe(false);
    expect(device.url()).toBe(TERMS_LINK.url);
    const [sent] = clickDispatches(device);
    expect(sent?.params).toEqual({
      strategy: 'css selector',
      value: '#accept',
      require_unoccluded: true,
    });
    const step = done.executor.results.find((r) => r.kind === 'failure');
    if (step?.kind !== 'failure') throw new Error('expected the tap to fail');
    expect(step.diagnosis).toEqual({ category: 'element_covered', retryable: false });
    expect(step.reason).toContain('nothing was tapped');
  });

  it('CONTROL — on a device that predates the build the checkbox is exempt, tapped unchecked, and the tap OPENS THE TERMS PAGE', async () => {
    const { device, turn } = harness(
      TERMS_LINK,
      [
        {
          intents: [{ kind: 'navigate', url: TERMS_LINK.url }, SETTLE, tap('#accept')],
          status: 'done',
        },
      ],
      { predatesOwnLabelVerdict: true },
    );
    await turn('accept the terms');
    expect(clickDispatches(device).map((d) => d.params)).toEqual([
      { strategy: 'css selector', value: '#accept' },
    ]);
    expect(device.hasFlag('terms:opened')).toBe(true);
    expect(device.hasFlag('terms:accepted')).toBe(false);
  });

  const TYPE_EMAIL: Segment = {
    intents: [
      { kind: 'navigate', url: SIGNUP.url },
      SETTLE,
      { kind: 'interact', action: 'type', selector: '#email', value: 'me@example.test' },
    ],
    status: 'done',
  };

  it('⛔ an off-screen field covered after the scroll: the typed step is refused and NOTHING is typed', async () => {
    const { device, turn } = harness(SIGNUP, [TYPE_EMAIL]);
    const done = await turn('sign me up with me@example.test');
    expect(typedFields(device)).toEqual([]);
    expect(device.hasFlag('chat:opened')).toBe(false);
    const typed = device.dispatches().filter((d) => d.intentName === 'send_keys');
    expect(typed).toHaveLength(1);
    expect(typed[0]?.params).toMatchObject({ value: '#email', require_unoccluded: true });
    const step = done.executor.results.find((r) => r.kind === 'failure');
    if (step?.kind !== 'failure') throw new Error('expected the typed step to fail');
    expect(step.diagnosis).toEqual({ category: 'element_covered', retryable: false });
    expect(step.reason).toContain('nothing was typed');
  });

  it('…and once the re-plan hides the cover, the same checked typing goes through', async () => {
    const { device, turn } = harness(SIGNUP, [
      TYPE_EMAIL,
      {
        intents: [
          tap('#hide-chat'),
          { kind: 'interact', action: 'type', selector: '#email', value: 'me@example.test' },
        ],
        status: 'done',
      },
    ]);
    const done = await turn('sign me up with me@example.test');
    expect(done.executor.ok).toBe(true);
    expect(typedFields(device)).toEqual(['email']);
    expect(device.hasFlag('chat:opened')).toBe(false);
  });

  it('CONTROL — the older device behaves exactly as before: no parameter, and the field is typed into', async () => {
    const { device, turn } = harness(SIGNUP, [TYPE_EMAIL], { predatesOwnLabelVerdict: true });
    const done = await turn('sign me up with me@example.test');
    expect(done.executor.ok).toBe(true);
    const typed = device.dispatches().filter((d) => d.intentName === 'send_keys');
    expect(typed.map((d) => d.params)).toEqual([
      { strategy: 'css selector', value: '#email', text: 'me@example.test' },
    ]);
    expect(typedFields(device)).toEqual(['email']);
  });

  it('the native no-tap path with the check asked for: typed, and nothing claims it was verified', async () => {
    const { device, turn } = harness(SIGNUP, [TYPE_EMAIL], { sendKeysFocusesByScript: true });
    const done = await turn('sign me up with me@example.test');
    expect(done.executor.ok).toBe(true);
    expect(typedFields(device)).toEqual(['email']);
  });
});

describe('the scorer files a refused tap the way production does', () => {
  it('a target that went away is a missing element, even under the refusal’s own code', () => {
    for (const code of ['intent_element_occluded', 'intent_webdriver_failed'] as const) {
      expect(
        classifyDispatchDeath(
          'interact',
          code,
          `${TAP_REFUSAL_MESSAGE_PREFIX}target_not_resolved`,
          'element_not_found',
        ),
      ).toBe('element_never_appeared_in_retry_budget');
    }
  });

  it('a check that could not run is the device’s own inability, not a cover', () => {
    expect(
      classifyDispatchDeath(
        'interact',
        'intent_element_occluded',
        `${TAP_REFUSAL_MESSAGE_PREFIX}occlusion_check_unavailable`,
        'target_unverified',
      ),
    ).toBe('harness_error_unclassified');
  });

  it('a cover is still a cover', () => {
    expect(
      classifyDispatchDeath(
        'interact',
        'intent_element_occluded',
        `${TAP_REFUSAL_MESSAGE_PREFIX}hit_is_not_target_or_descendant`,
        'element_covered',
      ),
    ).toBe('element_click_intercepted');
  });
});
