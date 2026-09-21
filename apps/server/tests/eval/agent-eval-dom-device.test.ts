// The device resolves selectors the way a BROWSER does, against real markup —
// and swapping it in changed nothing the scripted tier pins.
//
// WHY THIS FILE EXISTS. The fake device used to match a planned selector by
// exact string equality against a hand-listed element array. That is sound only
// while we write both sides. A live model writes whatever valid CSS it likes, so
// an exact-match device would fail every live plan for a reason that is not a
// fact about the agent. The page is parsed HTML now, `get_page_source`
// serialises that same document, and lookups have `querySelector` semantics.
//
// ⛔ THE SWAP WAS ITSELF AN EXPERIMENT, AND THIS FILE KEEPS ITS RESULT. Moving
// the scripted tier onto the DOM-backed device left every task's outcome, death
// reason, per-step attempt count, simulated time and answer text identical (the
// full report was diffed; only wall-clock moved). What made that possible is
// pinned below: the words a reader sees on each scripted page are the words the
// old text model declared, line for line — so the stand-in answerer's line rules
// and the extraction bound read exactly what they read before.
//
// Each page behaviour carries its POSITIVE CONTROL in the same test. "The click
// was refused" proves nothing alone: a device that refuses everything produces
// that observation too.

import { agentIntentToDispatch } from '../../src/services/agent-intent-to-dispatch.js';
import { describe, expect, it } from 'vitest';
import type { HarnessIntentName } from '../../src/schemas/harness-control-protocol.js';
import { summarizePageForPlanning } from '../../src/services/agent-executor-control-plane.js';
import { serializeIntentDispatch } from '../../src/services/harness-control-codec.js';
import { PageDom, queryAll, visibleTextOf } from './_lib/dom.js';
import { FakeDevice, FixtureError, type FakeDeviceOptions } from './_lib/fake-device.js';
import { LIVE_SITES } from './_lib/live-sites.js';
import { EVAL_SITES, siteOf, type FixturePage, type SiteMap } from './_lib/page-model.js';
import { ELEMENT_NOT_INTERACTABLE } from './_lib/score.js';
import { VirtualClock } from './_lib/virtual-clock.js';

function makeDevice(sites: SiteMap, extra: Partial<FakeDeviceOptions> = {}) {
  const clock = new VirtualClock();
  const device = new FakeDevice({ sites, startUrl: 'about:blank', clock, ...extra });
  let seq = 0;
  const send = (intentName: HarnessIntentName, params: Record<string, unknown>) =>
    device.dispatcher.dispatch(
      serializeIntentDispatch({
        sessionId: 'agt_eval',
        intentId: `int_${(seq += 1).toString()}`,
        intentName,
        params,
      }),
    );
  const click = (value: string) => send('click', { strategy: 'css selector', value });
  const type = (value: string, text: string) =>
    send('send_keys', { strategy: 'css selector', value, text });
  const source = async (): Promise<string> =>
    (((await send('get_page_source', {})).outputData ?? {}) as { source: string }).source;
  return { clock, device, send, click, type, source };
}

function selectorPredicate(selector: string): string {
  return `const element = deepQuery(${JSON.stringify(selector)}); if (element === null) return false; return true;`;
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

describe('DOM-backed device — selectors resolve the way a browser resolves them', () => {
  it('every valid spelling of the same element lands on it, not just the one a fixture author typed', async () => {
    // The old device knew this control ONLY as the string "button#show-sold-out".
    // A model is as likely to write any of the others, and they are the same node.
    const spellings = [
      'button#show-sold-out',
      '#show-sold-out',
      'main button[type="button"]',
      'ul.deals ~ p > button',
      'button:not([disabled])',
      '#nope, #show-sold-out',
    ];
    for (const selector of spellings) {
      const { device, send, click, source } = makeDevice(EVAL_SITES);
      await send('navigate', { url: 'https://shop.test/deals' });
      const clicked = await click(selector);
      expect(clicked.success, selector).toBe(true);
      // The click LANDED — read off the document, not off the result.
      expect(await source(), selector).toContain('65% off');
      expect(device.events().some((e) => e.kind === 'clicked' && e.id === 'show-sold-out')).toBe(
        true,
      );
    }
  });

  it('a selector that matches nothing is NOT FOUND, and one the engine cannot parse is INVALID — two different failures', async () => {
    const { send, click } = makeDevice(EVAL_SITES);
    await send('navigate', { url: 'https://shop.test/deals' });
    const missing = await click('#no-such-control');
    expect(missing.errorCode).toBe('intent_element_not_found');
    const unparsable = await click('button[');
    // A planning fault, never page state: the executor must not wait for it.
    expect(unparsable.errorCode).toBe('intent_invalid_parameter');
  });

  it('get_page_source IS the document: a change shows up in it, and a typed value does not', async () => {
    const { send, click, type, source } = makeDevice(EVAL_SITES);
    await send('navigate', { url: 'https://shop.test/deals' });
    const before = await source();
    expect(before.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(before).toContain('<h1 class="deal-headline">');
    expect(before).not.toContain('<li class="sold-out-deal">');
    await click('#show-sold-out');
    expect(await source()).toContain('<li class="sold-out-deal">');

    // A typed value is a PROPERTY, never an attribute — so the page source, the
    // planner's digest and a read-back can never carry what a customer typed.
    await send('navigate', { url: 'https://mail.test/login' });
    await type('#password', 'hunter2-typed-by-the-customer');
    expect(await source()).not.toContain('hunter2-typed-by-the-customer');
  });
});

describe('DOM-backed device — the swap left the scripted tier reading the same words', () => {
  // ⛔ LITERALS, COPIED FROM THE TEXT MODEL THE DEVICE USED TO SERVE. These are
  // the pages whose text reaches the stand-in answerer and the extraction bound;
  // if one of them drifts by a line, a `line_at` rule picks a different line and
  // a scripted outcome flips for a reason that is a fixture edit, not a product
  // change.
  const LEGACY_TEXT: ReadonlyArray<readonly [url: string, lines: string[], prepare?: string]> = [
    [
      'https://shop.test/deals',
      [
        'Deals',
        'Autumn sale — 40% off everything in stock',
        'Walnut desk lamp — 40% off',
        'Show sold out',
      ],
    ],
    ['https://news.test/', ['news.test', 'Today', 'Ferry service resumes on the north route']],
    ['https://docs.test/pricing', ['Pricing', 'Compare plans']],
    [
      'https://blog.test/',
      [
        'blog.test',
        'What the tide leaves behind',
        'A long piece about coastal erosion, in nine parts.',
      ],
    ],
    ['https://search.test/', ['search.test', 'Search the web']],
    [
      'https://search.test/results',
      [
        'Results for wireless keyboard',
        '1. Quietkey 7 wireless keyboard, low-profile',
        '2. Slab 60 mechanical keyboard',
      ],
    ],
    [
      'https://slow.test/',
      ['slow.test status', 'All systems operational — last checked 2 minutes ago'],
    ],
    ['https://app.test/', ['app.test', 'Setting things up']],
    [
      'https://forum.test/',
      ['forum.test', 'Battery recall — what we know', 'Ferry timetable 2027'],
    ],
    [
      'https://forum.test/t/9182',
      ['Battery recall — what we know', 'Top reply: Only the 2024 units are affected.'],
    ],
    ['https://hello.test/', ['hello.test', 'Good morning, traveller']],
    ['https://void.test/', ['void.test']],
    [
      'https://quiet.test/',
      [
        'quiet.test',
        'A small page with very little on it.',
        'No contact details are published here.',
      ],
    ],
    [
      'https://forum.test/threads/battery-recall',
      ['Not found', 'The page you asked for does not exist.'],
    ],
  ];

  it.each(LEGACY_TEXT)('%s reads exactly as the text model declared it', async (url, lines) => {
    const { send, source } = makeDevice(EVAL_SITES);
    await send('navigate', { url });
    expect(visibleTextOf(await source()).split('\n')).toEqual(lines);
  });

  it('state-dependent text moves with the state, as the text model did', async () => {
    const { send, click, source, clock } = makeDevice(EVAL_SITES);
    await send('navigate', { url: 'https://docs.test/pricing' });
    await send('scroll', { direction: 'down', distance_px: 900 });
    expect(visibleTextOf(await source()).split('\n')).toEqual([
      'Pricing',
      'Compare plans',
      'Starter — $29 per month, billed annually',
      'Team — $89 per month',
    ]);
    await send('navigate', { url: 'https://shop.test/deals' });
    await click('#show-sold-out');
    expect(
      visibleTextOf(await source())
        .split('\n')
        .at(-1),
    ).toBe('Cobalt travel mug (out of stock) — 65% off when restocked');
    await send('navigate', { url: 'https://app.test/' });
    clock.advance(3000);
    expect(visibleTextOf(await source()).split('\n')).toEqual([
      'app.test',
      'Setting things up',
      'Continue',
    ]);
  });

  it('the scripted site still reports NO status for an unknown address — the cost F4 exists to measure', async () => {
    const { send } = makeDevice(EVAL_SITES);
    const navigated = await send('navigate', { url: 'https://forum.test/threads/battery-recall' });
    expect(navigated.success).toBe(true);
    expect(navigated.outputData).toEqual({ url: 'https://forum.test/threads/battery-recall' });
  });

  it('markup-free text reads as itself, so a device that returned rendered text still works', () => {
    expect(visibleTextOf('hello.test\nGood morning, traveller')).toBe(
      'hello.test\nGood morning, traveller',
    );
  });
});

describe('DOM-backed device — page behaviour is declared on the fixture', () => {
  it('a late control is absent, then present; a wait costs exactly as long as it took to render', async () => {
    const { send, click, clock, device } = makeDevice(LIVE_SITES.tickets.pages);
    await send('navigate', { url: 'https://tickets.test/queue' });
    expect((await click('#enter-sale')).errorCode).toBe('intent_element_not_found');
    const before = clock.now();
    const waited = await send('wait_for', {
      predicate: selectorPredicate('#enter-sale'),
      timeout_seconds: 5,
    });
    expect(waited.success).toBe(true);
    // Rendered 3200ms after the navigation STARTED (t=0), and not a tick later.
    expect(clock.now()).toBe(3200);
    expect(clock.now() - before).toBeLessThan(5000);
    expect((await click('#enter-sale')).success).toBe(true);
    expect(device.hasFlag('queue:continued')).toBe(true);
    expect(device.url()).toBe('https://tickets.test/sale');
  });

  it('a wait for something the page will never render costs the whole budget and says so', async () => {
    const { send, clock } = makeDevice(LIVE_SITES.tickets.pages);
    await send('navigate', { url: 'https://tickets.test/queue' });
    const before = clock.now();
    const waited = await send('wait_for', {
      predicate: selectorPredicate('#never-rendered'),
      timeout_seconds: 5,
    });
    expect(waited.success).toBe(false);
    expect(waited.errorMessage).toContain('never became visible');
    expect(clock.now() - before).toBe(5000);
  });

  it('an overlay intercepts EVERYTHING outside it until it is dismissed, and stays dismissed', async () => {
    const { send, click, device } = makeDevice(LIVE_SITES.mugs.pages);
    await send('navigate', { url: 'https://mugs.test/' });
    const covered = await click('#add-blue-mug');
    expect(covered.errorCode).toBe('intent_webdriver_failed');
    expect(covered.errorMessage).toContain('element click intercepted');
    expect(device.hasFlag('basket:blue-mug')).toBe(false);
    // The overlay's own controls are NOT covered by it.
    expect((await click('#onetrust-reject-all-handler')).success).toBe(true);
    expect((await click('#add-blue-mug')).success).toBe(true);
    expect(device.hasFlag('basket:blue-mug')).toBe(true);
    // Consent outlives the page, the way a cookie does.
    await send('navigate', { url: 'https://mugs.test/' });
    expect((await click('#add-red-mug')).success).toBe(true);
  });

  it('a link navigates within the site, and a relative href resolves against the page', async () => {
    const { send, click, device } = makeDevice(LIVE_SITES.boards.pages);
    await send('navigate', { url: 'https://boards.test/' });
    expect((await click('a[href="/t/9182"]')).success).toBe(true);
    expect(device.url()).toBe('https://boards.test/t/9182');
    expect(device.events().at(-1)).toMatchObject({ kind: 'navigated', via: 'link' });
  });

  it('a form submits what was TYPED — by its button or by Enter — and the site decides', async () => {
    const byButton = makeDevice(LIVE_SITES.gearfinder.pages);
    await byButton.send('navigate', { url: 'https://gearfinder.test/' });
    await byButton.type('#search-input', 'trail stove');
    await byButton.click('#search-submit');
    expect(byButton.device.url()).toBe('https://gearfinder.test/search/trail-stove');

    const byEnter = makeDevice(LIVE_SITES.gearfinder.pages);
    await byEnter.send('navigate', { url: 'https://gearfinder.test/' });
    await byEnter.type('input[name="q"]', 'trail stove');
    await byEnter.send('press_key', { key: 'Enter' });
    expect(byEnter.device.url()).toBe('https://gearfinder.test/search/trail-stove');

    // The negative control: the SAME form, a different query, a different page.
    const wrong = makeDevice(LIVE_SITES.gearfinder.pages);
    await wrong.send('navigate', { url: 'https://gearfinder.test/' });
    await wrong.type('#search-input', 'kayak');
    await wrong.click('#search-submit');
    expect(wrong.device.url()).toBe('https://gearfinder.test/search/no-results');

    // And the address a model might type instead of using the form lands the same.
    const typedAddress = makeDevice(LIVE_SITES.gearfinder.pages);
    await typedAddress.send('navigate', { url: 'https://gearfinder.test/search?q=trail+stove' });
    expect(typedAddress.device.url()).toBe('https://gearfinder.test/search/trail-stove');
  });

  it('Enter with nothing focused submits nothing', async () => {
    const { send, device } = makeDevice(LIVE_SITES.gearfinder.pages);
    await send('navigate', { url: 'https://gearfinder.test/' });
    await send('press_key', { key: 'Enter' });
    expect(device.url()).toBe('https://gearfinder.test/');
    expect(device.submissions()).toEqual([]);
  });

  it('Enter in a TEXTAREA is a newline, not a submit — the device is no kinder than a browser', async () => {
    // A plan that types the message and presses Enter leaves a customer's form
    // UNSENT. A device that submitted it would score that plan as a sent form.
    const inTextarea = makeDevice(LIVE_SITES.parcels.pages);
    await inTextarea.send('navigate', { url: 'https://parcels.test/contact' });
    await inTextarea.type('#name', 'Dana Whit');
    await inTextarea.type('#email', 'dana@example.test');
    await inTextarea.type('#message', 'Where is parcel 7731?');
    await inTextarea.send('press_key', { key: 'Enter' });
    expect(inTextarea.device.submissions()).toEqual([]);
    expect(inTextarea.device.hasFlag('contact:sent')).toBe(false);
    expect(inTextarea.device.url()).toBe('https://parcels.test/contact');
    // The newline went INTO the field, and the button still sends the form.
    await inTextarea.click('#send');
    expect(inTextarea.device.submissions().at(-1)?.values.message).toBe('Where is parcel 7731?\n');
    expect(inTextarea.device.hasFlag('contact:sent')).toBe(true);

    // The positive control: the SAME form, Enter in a single-line field, submits.
    const inInput = makeDevice(LIVE_SITES.parcels.pages);
    await inInput.send('navigate', { url: 'https://parcels.test/contact' });
    await inInput.type('#name', 'Dana Whit');
    await inInput.type('#message', 'Where is parcel 7731?');
    await inInput.type('#email', 'dana@example.test');
    await inInput.send('press_key', { key: 'Enter' });
    expect(inInput.device.hasFlag('contact:sent')).toBe(true);
    expect(inInput.device.url()).toBe('https://parcels.test/contact/thanks');
  });

  it('Enter submits IMPLICITLY only where HTML says it does', async () => {
    const field = (id: string) => `<input id="${id}" name="${id}" type="text">`;
    const page: FixturePage = {
      url: 'https://forms.test/',
      title: 'Forms',
      loadMs: 100,
      settleMs: 100,
      body:
        `<form id="lone">${field('only')}</form>` +
        `<form id="pair">${field('first')}${field('second')}</form>` +
        `<form id="choice"><select id="size" name="size"><option>S</option></select>${field('note')}<button type="submit">Go</button></form>`,
      forms: ['lone', 'pair', 'choice'].map((id) => ({
        form: `#${id}`,
        onAccepted: [{ kind: 'set_flag', flag: `submitted:${id}` }],
      })),
    };
    const { send, click, type, device } = makeDevice(siteOf([page]));
    await send('navigate', { url: page.url });
    // Two fields and no submit button: Enter does nothing.
    await type('#first', 'a');
    await send('press_key', { key: 'Enter' });
    // Focus on a <select>: Enter is not a submit either, button or no button.
    await click('#size');
    await send('press_key', { key: 'Enter' });
    expect(device.submissions()).toEqual([]);
    // The positive control: the form's ONE field submits it.
    await type('#only', 'a');
    await send('press_key', { key: 'Enter' });
    expect(device.submissions().map((s) => s.form)).toEqual([expect.stringContaining('lone')]);
    expect(device.hasFlag('submitted:lone')).toBe(true);
  });

  it('Enter on a focused BUTTON activates it again, as a click would', async () => {
    const { send, click, device } = makeDevice(LIVE_SITES.kettles.pages);
    await send('navigate', { url: 'https://kettles.test/product/aurora' });
    await click('#tab-reviews');
    await send('press_key', { key: 'Enter' });
    expect(
      device.events().filter((e) => e.kind === 'clicked' && e.id === 'tab-reviews').length,
    ).toBe(2);
    // A `type="button"` submits nothing, by Enter as by click.
    expect(device.submissions()).toEqual([]);
  });

  it('a REJECTED login can be retried: the form comes back empty, as a server renders it', async () => {
    // send-keys appends. Had the rejected values stayed in the fields, the right
    // password re-typed would land AFTER the wrong one and no retry could ever
    // succeed — a fixture trap, not a fact about any agent.
    const { send, type, click, device, source } = makeDevice(LIVE_SITES.postbox.pages);
    await send('navigate', { url: 'https://postbox.test/login' });
    await type('#username', 'dana.whit@example.test');
    await type('#password', 'not-the-password');
    await click('#sign-in');
    expect(device.submissions().at(-1)?.accepted).toBe(false);
    expect(visibleTextOf(await source())).toContain('Those details were not recognised.');
    await type('#username', 'dana.whit@example.test');
    await type('#password', 'eval-only-Wren!Lantern-4471');
    await click('#sign-in');
    expect(device.submissions().at(-1)).toMatchObject({
      accepted: true,
      values: { username: 'dana.whit@example.test', password: 'eval-only-Wren!Lantern-4471' },
    });
    expect(device.url()).toBe('https://postbox.test/inbox');
  });

  it('send-keys APPENDS, as WebDriver does — typing twice is not typing once', async () => {
    const { send, type, click, device } = makeDevice(LIVE_SITES.gearfinder.pages);
    await send('navigate', { url: 'https://gearfinder.test/' });
    await type('#search-input', 'trail ');
    await type('#search-input', 'stove');
    await click('#search-submit');
    expect(device.submissions().at(-1)?.values).toEqual({ q: 'trail stove' });
  });

  it('a login form accepts the right values, rejects the wrong ones, and signs the device in', async () => {
    const wrong = makeDevice(LIVE_SITES.postbox.pages);
    await wrong.send('navigate', { url: 'https://postbox.test/inbox' });
    expect(wrong.device.url()).toBe('https://postbox.test/login');
    await wrong.type('#username', 'dana.whit@example.test');
    await wrong.type('#password', 'not-the-password');
    await wrong.click('#sign-in');
    expect(wrong.device.url()).toBe('https://postbox.test/login');
    expect(visibleTextOf(await wrong.source())).toContain('Those details were not recognised.');

    const right = makeDevice(LIVE_SITES.postbox.pages);
    await right.send('navigate', { url: 'https://postbox.test/login' });
    await right.type('#username', 'dana.whit@example.test');
    await right.type('#password', 'eval-only-Wren!Lantern-4471');
    await right.click('button[type="submit"]');
    expect(right.device.url()).toBe('https://postbox.test/inbox');
    expect(right.device.hasFlag('session:postbox.test')).toBe(true);
    // ⛔ The event log is what reports copy, and it never holds a typed value.
    expect(JSON.stringify(right.device.events())).not.toContain('Wren!Lantern');
  });

  it('content below the fold is not in the document until the page is scrolled to it', async () => {
    const { send, source } = makeDevice(LIVE_SITES.plans.pages);
    await send('navigate', { url: 'https://plans.test/pricing' });
    expect(await source()).not.toContain('$89');
    await send('scroll', { direction: 'down', distance_px: 300 });
    expect(await source()).not.toContain('$89');
    await send('scroll', { direction: 'down', distance_px: 500 });
    expect(await source()).toContain('$89');
    // Scrolling back up does not un-render a lazily loaded section.
    await send('scroll', { direction: 'up', distance_px: 800 });
    expect(await source()).toContain('$89');
  });

  it('an unknown address on a LIVE site is a 404 that SAYS it is one', async () => {
    const { send, source } = makeDevice(LIVE_SITES.boards.pages, {
      notFound: LIVE_SITES.boards.notFound,
    });
    const navigated = await send('navigate', { url: 'https://boards.test/threads/battery-recall' });
    expect(navigated.success).toBe(true);
    expect(navigated.outputData).toMatchObject({ http_status: 404 });
    // And the error page is somewhere a plan can recover FROM.
    expect(await source()).toContain('href="/"');
  });

  it('a page that loads and never settles fails the idle wait, and only the idle wait', async () => {
    const restless: FixturePage = {
      url: 'https://restless.test/',
      title: 'restless',
      loadMs: 200,
      settleMs: 100,
      neverSettles: true,
      body: '<main><h1 id="headline">Live scores</h1></main>',
    };
    const { send, clock } = makeDevice(siteOf([restless]));
    const navigated = await send('navigate', { url: restless.url });
    expect(navigated.success).toBe(true);
    expect(navigated.outputData).not.toHaveProperty('loadedAtTimeout');
    const before = clock.now();
    const idle = await send('wait_for', { predicate: IDLE_PREDICATE, timeout_seconds: 4 });
    expect(idle.success).toBe(false);
    expect(clock.now() - before).toBe(4000);
    // The page itself is perfectly usable: the control is that a selector wait works.
    expect(
      (await send('wait_for', { predicate: selectorPredicate('#headline'), timeout_seconds: 4 }))
        .success,
    ).toBe(true);
  });

  it('an address is not a string: the scheme a customer never said, and a www., reach the same page', async () => {
    // Measured, not imagined: the first live run lost six of eleven tasks at
    // step one because the model wrote `http://` for a host the customer named
    // without a scheme, and the device knew the page only as `https://`.
    for (const spelling of [
      'https://gearfinder.test/',
      'http://gearfinder.test/',
      'http://gearfinder.test',
      'https://www.gearfinder.test/',
      'http://www.gearfinder.test/search?q=trail+stove',
    ]) {
      const { send, device } = makeDevice(LIVE_SITES.gearfinder.pages, {
        notFound: LIVE_SITES.gearfinder.notFound,
      });
      const navigated = await send('navigate', { url: spelling });
      expect(navigated.outputData, spelling).not.toHaveProperty('http_status');
      expect(device.url().startsWith('https://gearfinder.test/'), spelling).toBe(true);
    }
    // The negative control: a page the site does NOT have is still a 404.
    const { send } = makeDevice(LIVE_SITES.gearfinder.pages, {
      notFound: LIVE_SITES.gearfinder.notFound,
    });
    expect(
      (await send('navigate', { url: 'http://gearfinder.test/nope' })).outputData,
    ).toMatchObject({ http_status: 404 });
  });

  it('a redirect onto a page behind a login still hits the login — no hop skips the wall', async () => {
    const signedOut = makeDevice(LIVE_SITES.postbox.pages);
    await signedOut.send('navigate', { url: 'https://postbox.test/' });
    expect(signedOut.device.url()).toBe('https://postbox.test/login');
    // The positive control: the SAME address, signed in, reaches the inbox.
    const signedIn = makeDevice(LIVE_SITES.postbox.pages, {
      authenticatedHosts: new Set(['postbox.test']),
    });
    await signedIn.send('navigate', { url: 'https://postbox.test/' });
    expect(signedIn.device.url()).toBe('https://postbox.test/inbox');
  });

  it('every live site answers at its bare host, which is all a customer ever names', async () => {
    for (const [name, site] of Object.entries(LIVE_SITES)) {
      const host = new URL([...site.pages.keys()][0] ?? '').host;
      const { send } = makeDevice(site.pages, { notFound: site.notFound });
      const navigated = await send('navigate', { url: `http://${host}` });
      expect(navigated.success, name).toBe(true);
      expect(navigated.outputData, name).not.toHaveProperty('http_status');
    }
  });

  it('a collapsed menu is IN the document and cannot be tapped until it is opened', async () => {
    const { send, click, device, source } = makeDevice(LIVE_SITES.bakery.pages);
    await send('navigate', { url: 'https://bakery.test/' });
    // The link is in the source — which is exactly why a planner that reads the
    // source believes it can tap it.
    expect(await source()).toContain('href="/opening-hours"');
    const hidden = await click('a[href="/opening-hours"]');
    expect(hidden.errorCode).toBe('intent_webdriver_failed');
    expect(hidden.errorMessage).toContain(ELEMENT_NOT_INTERACTABLE);
    expect(device.url()).toBe('https://bakery.test/');
    // Hidden text is not text a reader sees, either.
    expect(visibleTextOf(await source())).not.toContain('Find us');

    expect((await click('#menu-toggle')).success).toBe(true);
    expect((await click('a[href="/opening-hours"]')).success).toBe(true);
    expect(device.url()).toBe('https://bakery.test/opening-hours');
  });

  it('the footer copy of a collapsed link IS tappable, by a selector that reaches it', async () => {
    const { send, click, device } = makeDevice(LIVE_SITES.bakery.pages);
    await send('navigate', { url: 'https://bakery.test/' });
    expect((await click('footer a[href="/opening-hours"]')).success).toBe(true);
    expect(device.url()).toBe('https://bakery.test/opening-hours');
  });

  it('a gesture the fixture has no behaviour for is a FIXTURE error, never a quiet no-op', async () => {
    const orphan: FixturePage = {
      url: 'https://orphan.test/',
      title: 'orphan',
      loadMs: 10,
      settleMs: 10,
      body: '<form id="f"><input name="a"><button id="go" type="submit">Go</button></form>',
    };
    const { send, click } = makeDevice(siteOf([orphan]));
    await send('navigate', { url: orphan.url });
    await expect(click('#go')).rejects.toBeInstanceOf(FixtureError);
  });
});

describe("DOM-backed device — the product's page digest and the DOM agree", () => {
  /** Every fixture page, in the state a planner would first see it. */
  async function everyPageSource(): Promise<Array<{ url: string; source: string }>> {
    const sites: Array<{ pages: SiteMap; notFound?: FakeDeviceOptions['notFound'] }> = [
      { pages: EVAL_SITES },
      ...Object.values(LIVE_SITES),
    ];
    const out: Array<{ url: string; source: string }> = [];
    for (const site of sites) {
      for (const url of site.pages.keys()) {
        const { send, source, clock, device } = makeDevice(site.pages, {
          authenticatedHosts: new Set(['postbox.test', 'mail.test']),
        });
        await send('navigate', { url });
        // Past every late render, so late controls are in the digest too.
        clock.advance(10_000);
        if (device.url() === url) out.push({ url, source: await source() });
      }
    }
    return out;
  }

  it('every selector the digest PROPOSES resolves in the DOM it was read from', async () => {
    // If the digest proposes a selector the DOM cannot resolve, the planner is
    // being told to aim at nothing. That would be a finding about the product
    // (or about this DOM), and it must not pass silently.
    const unresolvable: string[] = [];
    let proposed = 0;
    for (const { url, source } of await everyPageSource()) {
      const page = new PageDom(source, url);
      try {
        for (const line of summarizePageForPlanning(source).split('\n')) {
          const parts = line.split(' · ');
          const selector = parts[0];
          if (parts.length < 2 || selector === undefined) continue;
          proposed += 1;
          if (queryAll(page.document, selector).length === 0) {
            unresolvable.push(`${url}: ${selector}`);
          }
        }
      } finally {
        page.close();
      }
    }
    // The positive control: the digest really did propose selectors here.
    expect(proposed).toBeGreaterThan(40);
    expect(unresolvable).toEqual([]);
  });
});
