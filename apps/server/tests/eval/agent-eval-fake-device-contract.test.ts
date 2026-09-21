// The fake device answers the CONTRACT, or it is not a device.
//
// A double that drifts from the wire contract feeds the agent loop a shape the
// real box never sends, and every number measured through it is a number about
// a system that does not exist. Two properties are checked here:
//
//  1. EVERY result the device produces survives `parseIntentResult`, which
//     validates the decoded payload against `HARNESS_INTENT_RESULT_SCHEMAS`.
//     The device cannot opt out of this — it has no other way to build a result.
//  2. Every page-model rule has a POSITIVE CONTROL in the same breath as its
//     negative one. "The click was refused" proves nothing on its own: a device
//     that refuses everything also produces that observation.

import { agentIntentToDispatch } from '../../src/services/agent-intent-to-dispatch.js';
import { describe, expect, it } from 'vitest';
import {
  HARNESS_ERROR_CODES,
  HARNESS_INTENT_RESULT_SCHEMAS,
  type HarnessIntentName,
} from '../../src/schemas/harness-control-protocol.js';
import { serializeIntentDispatch } from '../../src/services/harness-control-codec.js';
import { FakeDevice, ONE_PIXEL_PNG_B64 } from './_lib/fake-device.js';
import { EVAL_SITES, type FixturePage, type SiteMap } from './_lib/page-model.js';
import { VirtualClock } from './_lib/virtual-clock.js';

function makeDevice(startUrl = 'about:blank', sites: SiteMap = EVAL_SITES) {
  const clock = new VirtualClock();
  const device = new FakeDevice({ sites, startUrl, clock });
  const send = (intentName: HarnessIntentName, params: Record<string, unknown>) =>
    device.dispatcher.dispatch(
      serializeIntentDispatch({
        sessionId: 'agt_eval',
        intentId: `int_${intentName}`,
        intentName,
        params,
      }),
    );
  return { clock, device, send };
}

/**
 * R7 — built by the PRODUCT MAPPER rather than typed here. The settle is
 * recognised by its shape now (see `classifyWaitPredicate`), and a hand-written
 * copy of that shape would drift from the mapper the first time the predicate
 * moved — which is exactly the failure `agent-eval-wait-discriminator` exists to
 * catch, so this file must not reproduce it.
 */
const IDLE_PREDICATE = (() => {
  const mapped = agentIntentToDispatch({ kind: 'wait', condition: 'idle' });
  if (!mapped.ok || typeof mapped.params.predicate !== 'string') {
    throw new Error('the mapper stopped producing a settle predicate');
  }
  return mapped.params.predicate;
})();
function selectorPredicate(selector: string): string {
  return `const element = deepQuery(${JSON.stringify(selector)}); if (element === null) return false; return true;`;
}

describe('agent eval — the fake device answers the harness contract', () => {
  it('every intent the corpus dispatches produces a schema-valid result', async () => {
    const { device, send } = makeDevice();
    const results = [
      await send('navigate', { url: 'https://shop.test/deals' }),
      await send('wait_for', { predicate: IDLE_PREDICATE }),
      await send('screenshot', {}),
      await send('get_page_source', {}),
      await send('scroll', { direction: 'down', distance_px: 400 }),
      await send('behavioral_pause', { kind: 'reading', word_count: 20, scroll_through: true }),
      await send('click', { strategy: 'css selector', value: 'button#show-sold-out' }),
      await send('extract', {
        extractions: [{ name: 'headline', selector: 'h1.deal-headline', type: 'text' }],
      }),
    ];
    expect(results.at(-1)?.outputData).toMatchObject({
      value: { headline: 'Autumn sale — 40% off everything in stock' },
    });
    const dispatched = device.dispatches();
    expect(dispatched.length).toBe(results.length);
    results.forEach((result, index) => {
      const record = dispatched[index];
      expect(record).toBeDefined();
      if (record === undefined) return;
      expect(result.success).toBe(true);
      // parseIntentResult already validated this; re-asserting names WHICH
      // payload would be at fault if the device ever grew a hand-built result.
      expect(
        HARNESS_INTENT_RESULT_SCHEMAS[record.intentName].safeParse(result.outputData).success,
      ).toBe(true);
    });
  });

  it('send_keys and press_key round-trip their result shapes', async () => {
    const { send } = makeDevice();
    await send('navigate', { url: 'https://search.test/' });
    const typed = await send('send_keys', {
      strategy: 'css selector',
      value: 'input[name="q"]',
      text: 'wireless keyboard',
    });
    expect(typed.success).toBe(true);
    expect(typed.outputData).toMatchObject({ typed_into: 'input[name="q"]', length: 17 });
    const pressed = await send('press_key', { key: 'Enter' });
    expect(pressed.success).toBe(true);
    expect(pressed.outputData).toMatchObject({ pressed: 'Enter' });
  });

  it('a screenshot carries fixed bytes, so a run is byte-identical to the last one', async () => {
    const { send } = makeDevice();
    await send('navigate', { url: 'https://news.test/' });
    const shot = await send('screenshot', {});
    expect(shot.outputData).toMatchObject({
      screenshot_b64: ONE_PIXEL_PNG_B64,
      format: 'png',
      full_page: false,
    });
  });

  it('every failure the device can emit uses a code the wire enum contains', async () => {
    const { send } = makeDevice();
    await send('navigate', { url: 'https://app.test/' });
    const observed = [
      await send('click', { strategy: 'css selector', value: '#continue' }),
      await send('press_key', { key: 'NotAKey' }),
      await send('wait_for', { predicate: selectorPredicate('#never'), timeout_seconds: 1 }),
    ];
    for (const result of observed) {
      expect(result.success).toBe(false);
      expect(result.errorCode).toBeDefined();
      expect(HARNESS_ERROR_CODES).toContain(result.errorCode);
    }
    expect(observed[0]?.errorCode).toBe('intent_element_not_found');
    expect(observed[1]?.errorCode).toBe('intent_invalid_parameter');
    expect(observed[2]?.errorCode).toBe('intent_webdriver_failed');
  });

  describe('page-model rules, each with its positive control', () => {
    it('an overlay INTERCEPTS rather than hides — and a dismissed overlay lets the click through', async () => {
      const blocked = makeDevice();
      await blocked.send('navigate', { url: 'https://shop.test/' });
      const intercepted = await blocked.send('click', {
        strategy: 'css selector',
        value: 'button[data-add-to-cart="blue-mug"]',
      });
      expect(intercepted.success).toBe(false);
      // NOT element_not_found. The element is there; something is over it, and
      // the two failures want opposite handling from the executor.
      expect(intercepted.errorCode).toBe('intent_webdriver_failed');
      expect(intercepted.errorMessage).toContain('element click intercepted');
      expect(blocked.device.hasFlag('cart:blue-mug')).toBe(false);

      const allowed = makeDevice();
      await allowed.send('navigate', { url: 'https://shop.test/' });
      await allowed.send('click', {
        strategy: 'css selector',
        value: '#consent-overlay button.accept',
      });
      const through = await allowed.send('click', {
        strategy: 'css selector',
        value: 'button[data-add-to-cart="blue-mug"]',
      });
      expect(through.success).toBe(true);
      expect(allowed.device.hasFlag('cart:blue-mug')).toBe(true);
    });

    it('an element past appearsAfterMs IS found once that much time has elapsed', async () => {
      const early = makeDevice();
      await early.send('navigate', { url: 'https://app.test/' });
      expect(
        (await early.send('click', { strategy: 'css selector', value: '#continue' })).errorCode,
      ).toBe('intent_element_not_found');

      const late = makeDevice();
      await late.send('navigate', { url: 'https://app.test/' });
      // The positive control: advance past the render and the SAME click lands.
      late.clock.advance(3000);
      const found = await late.send('click', { strategy: 'css selector', value: '#continue' });
      expect(found.success).toBe(true);
      expect(late.device.hasFlag('continue:clicked')).toBe(true);
    });

    it('a below-the-fold element is absent until scrolled, and present after', async () => {
      const { device, send } = makeDevice();
      await send('navigate', { url: 'https://docs.test/pricing' });
      const before = await send('get_page_source', {});
      expect(String((before.outputData as { source: string }).source)).not.toContain('$29');
      await send('scroll', { direction: 'down', distance_px: 900 });
      const after = await send('get_page_source', {});
      expect(String((after.outputData as { source: string }).source)).toContain('$29');
      expect(device.dispatches().every((d) => d.success)).toBe(true);
    });

    it('a revealedBy element does not exist until its control is clicked', async () => {
      const { send } = makeDevice();
      await send('navigate', { url: 'https://shop.test/deals' });
      expect(
        (await send('click', { strategy: 'css selector', value: 'li.sold-out-deal' })).errorCode,
      ).toBe('intent_element_not_found');
      await send('click', { strategy: 'css selector', value: 'button#show-sold-out' });
      const revealed = await send('get_page_source', {});
      expect(String((revealed.outputData as { source: string }).source)).toContain('65% off');
    });

    it('a login wall lands the navigate somewhere else and reports THAT url as a success', async () => {
      const { device, send } = makeDevice();
      const navigated = await send('navigate', { url: 'https://mail.test/inbox' });
      expect(navigated.success).toBe(true);
      expect(navigated.outputData).toMatchObject({ url: 'https://mail.test/login' });
      expect(device.url()).toBe('https://mail.test/login');
      // This is the expensive shape: a green navigate, and every later selector
      // belongs to a page the plan never reached.
      expect(
        (await send('click', { strategy: 'css selector', value: '#unread-count' })).errorCode,
      ).toBe('intent_element_not_found');
    });

    it('an unknown url resolves to a 404 that LOADS — so the plan dies later than the mistake', async () => {
      const { send } = makeDevice();
      const navigated = await send('navigate', {
        url: 'https://forum.test/threads/battery-recall',
      });
      expect(navigated.success).toBe(true);
      expect(
        (await send('click', { strategy: 'css selector', value: '.reply.top' })).errorCode,
      ).toBe('intent_element_not_found');
    });

    it('a page that never finishes loading SUCCEEDS carrying loadedAtTimeout', async () => {
      const dead: FixturePage = {
        url: 'https://hang.test/',
        title: 'hang',
        loadMs: 500,
        settleMs: 500,
        neverFinishesLoading: true,
        body: '',
      };
      const { send } = makeDevice('about:blank', new Map([[dead.url, dead]]));
      const navigated = await send('navigate', { url: dead.url });
      // The executor will count this as a completed step. The scorer must not:
      // a green step on a dead page is the failure the owner reported.
      expect(navigated.success).toBe(true);
      expect(navigated.outputData).toMatchObject({ loadedAtTimeout: true });
      const settle = await send('wait_for', { predicate: IDLE_PREDICATE, timeout_seconds: 5 });
      expect(settle.success).toBe(false);
      expect(settle.errorCode).toBe('intent_webdriver_failed');
    });

    it('a load that errors reports page_load_failed rather than a success on nothing', async () => {
      const broken: FixturePage = {
        url: 'https://broken.test/',
        title: 'broken',
        loadMs: 200,
        settleMs: 100,
        loadFails: true,
        body: '',
      };
      const { send } = makeDevice('about:blank', new Map([[broken.url, broken]]));
      const navigated = await send('navigate', { url: broken.url });
      expect(navigated.success).toBe(false);
      expect(navigated.errorCode).toBe('intent_page_load_failed');
    });

    it('an over-cap page source fails with result_too_large instead of returning a truncated DOM', async () => {
      const huge: FixturePage = {
        url: 'https://huge.test/',
        title: 'huge',
        loadMs: 10,
        settleMs: 10,
        body: `<p>${'x'.repeat(5_000)}</p>`,
      };
      const clock = new VirtualClock();
      const device = new FakeDevice({
        sites: new Map([[huge.url, huge]]),
        startUrl: huge.url,
        clock,
        pageSourceMaxChars: 1_000,
      });
      const result = await device.dispatcher.dispatch(
        serializeIntentDispatch({
          sessionId: 'agt_eval',
          intentId: 'int_1',
          intentName: 'get_page_source',
          params: {},
        }),
      );
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('result_too_large');
    });
  });

  it('the device refuses to invent a result for an intent it has no model of', async () => {
    const { device } = makeDevice();
    // `login` is in the harness vocabulary and no AgentIntent maps to it. If the
    // mapper ever gains that target, this throw is how we find out — rather than
    // a quiet success that makes a brand-new dispatch path look tested.
    await expect(
      device.dispatcher.dispatch(
        serializeIntentDispatch({
          sessionId: 'agt_eval',
          intentId: 'int_login',
          intentName: 'login',
          params: { username: 'a', password: 'b' },
        }),
      ),
    ).rejects.toThrow(/no model for harness intent "login"/);
  });
});
