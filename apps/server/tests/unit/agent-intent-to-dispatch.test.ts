// Increment-2 (b) — unit tests for agentIntentToDispatch(): the pure map
// from customer AgentIntent → harness { intentName, params }. Covers every
// clean 1:1 mapping, every typed-unsupported verb, the missing-required-
// field cases, the wait_for predicate construction (+ injection safety),
// and that produced params pass the canonical harness param-schema.

import { createContext, runInContext, runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { AgentIntent } from '@driftstack/api-types';
import {
  SETTLE_CEILING_APPLIES_WITHIN_MS,
  SETTLE_CEILING_MS,
  SETTLE_QUIET_MS,
  SETTLE_TIMEOUT_SECONDS,
  agentIntentToDispatch,
} from '../../src/services/agent-intent-to-dispatch.js';
import { HARNESS_INTENT_PARAM_SCHEMAS } from '../../src/schemas/harness-control-protocol.js';

describe('agentIntentToDispatch — clean 1:1 mappings', () => {
  it('navigate → navigate { url }', () => {
    const r = agentIntentToDispatch({ kind: 'navigate', url: 'https://example.com' });
    expect(r).toEqual({ ok: true, intentName: 'navigate', params: { url: 'https://example.com' } });
  });

  it('V-820.sec navigate with a non-http(s) url → ok:false (harness-contract validation rejects file:/javascript:/data:)', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x']) {
      const r = agentIntentToDispatch({ kind: 'navigate', url });
      expect(r.ok, url).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/navigate params failed harness-contract validation/);
    }
  });

  it('interact:tap → click { strategy: css, value: selector }', () => {
    const r = agentIntentToDispatch({ kind: 'interact', action: 'tap', selector: '#submit' });
    expect(r).toEqual({
      ok: true,
      intentName: 'click',
      params: { strategy: 'css selector', value: '#submit' },
    });
  });

  it('W140 scroll → harness scroll { direction, distance_px } (amount_px omitted → no distance_px, persona default)', () => {
    expect(agentIntentToDispatch({ kind: 'scroll', direction: 'down', amount_px: 800 })).toEqual({
      ok: true,
      intentName: 'scroll',
      params: { direction: 'down', distance_px: 800 },
    });
    expect(agentIntentToDispatch({ kind: 'scroll', direction: 'up' })).toEqual({
      ok: true,
      intentName: 'scroll',
      params: { direction: 'up' },
    });
  });

  it('W140 behavioral_pause → harness behavioral_pause: reading_word_count wins → {kind:reading}; else duration_ms; else {} (idle)', () => {
    expect(agentIntentToDispatch({ kind: 'behavioral_pause', reading_word_count: 120 })).toEqual({
      ok: true,
      intentName: 'behavioral_pause',
      // W1223 — reading pauses always request scroll_through (harness read→scroll→read
      // on long content; byte-identical single dwell for content that fits).
      params: { kind: 'reading', word_count: 120, scroll_through: true },
    });
    expect(agentIntentToDispatch({ kind: 'behavioral_pause', duration_ms: 2500 })).toEqual({
      ok: true,
      intentName: 'behavioral_pause',
      params: { duration_ms: 2500 },
    });
    // reading_word_count wins over duration_ms when both present.
    expect(
      agentIntentToDispatch({
        kind: 'behavioral_pause',
        duration_ms: 2500,
        reading_word_count: 50,
      }),
    ).toEqual({
      ok: true,
      intentName: 'behavioral_pause',
      params: { kind: 'reading', word_count: 50, scroll_through: true },
    });
    // neither → bare {} (harness persona idle pause).
    expect(agentIntentToDispatch({ kind: 'behavioral_pause' })).toEqual({
      ok: true,
      intentName: 'behavioral_pause',
      params: {},
    });
  });

  it('interact:type → send_keys { strategy, value: selector, text: value }', () => {
    const r = agentIntentToDispatch({
      kind: 'interact',
      action: 'type',
      selector: '#email',
      value: 'a@b.com',
    });
    expect(r).toEqual({
      ok: true,
      intentName: 'send_keys',
      params: { strategy: 'css selector', value: '#email', text: 'a@b.com' },
    });
  });

  it('forces sensitive=true for obvious secret selectors and preserves ordinary false', () => {
    expect(
      agentIntentToDispatch({
        kind: 'interact',
        action: 'type',
        selector: 'input[autocomplete="one-time-code"]',
        value: '123456',
        sensitive: false,
      }),
    ).toEqual({
      ok: true,
      intentName: 'send_keys',
      params: {
        strategy: 'css selector',
        value: 'input[autocomplete="one-time-code"]',
        text: '123456',
        sensitive: true,
      },
    });
    expect(
      agentIntentToDispatch({
        kind: 'interact',
        action: 'type',
        selector: '#display-name',
        value: 'Ada',
        sensitive: false,
      }),
    ).toEqual({
      ok: true,
      intentName: 'send_keys',
      params: {
        strategy: 'css selector',
        value: '#display-name',
        text: 'Ada',
        sensitive: false,
      },
    });
  });

  it('interact:scroll → bare scroll {} (harness applies persona defaults)', () => {
    const r = agentIntentToDispatch({ kind: 'interact', action: 'scroll' });
    expect(r).toEqual({ ok: true, intentName: 'scroll', params: {} });
  });

  it('capture:screenshot → screenshot {}', () => {
    const r = agentIntentToDispatch({ kind: 'capture', capture: 'screenshot' });
    expect(r).toEqual({ ok: true, intentName: 'screenshot', params: {} });
  });

  it('capture:dom_snapshot → get_page_source {}', () => {
    const r = agentIntentToDispatch({ kind: 'capture', capture: 'dom_snapshot' });
    expect(r).toEqual({ ok: true, intentName: 'get_page_source', params: {} });
  });
});

describe('agentIntentToDispatch — wait:selector_visible → wait_for', () => {
  function visiblePredicate(selector = '.ready'): string {
    const result = agentIntentToDispatch({
      kind: 'wait',
      condition: 'selector_visible',
      selector,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('narrow');
    return result.params.predicate as string;
  }

  function evaluatePredicate(
    predicate: string,
    element: Record<string, unknown> | null,
    getComputedStyle: (node: unknown) => Record<string, string> = () => ({
      display: 'block',
      visibility: 'visible',
      contentVisibility: 'visible',
      opacity: '1',
    }),
  ): boolean {
    return runInNewContext(`(function () { ${predicate} })()`, {
      document: { querySelector: () => element },
      getComputedStyle,
    }) as boolean;
  }

  it('builds a rendered-visibility predicate using the fork-native options', () => {
    const checkVisibility = vi.fn(() => true);
    const predicate = visiblePredicate();
    expect(
      evaluatePredicate(predicate, {
        checkVisibility,
        getBoundingClientRect: () => ({ width: 100, height: 40 }),
      }),
    ).toBe(true);
    expect(checkVisibility).toHaveBeenCalledWith({
      checkOpacity: true,
      checkVisibilityCSS: true,
      contentVisibilityAuto: true,
    });
  });

  it('rejects missing, CSS-hidden, and zero-area elements', () => {
    const predicate = visiblePredicate();
    expect(evaluatePredicate(predicate, null)).toBe(false);
    expect(
      evaluatePredicate(predicate, {
        checkVisibility: () => false,
        getBoundingClientRect: () => ({ width: 100, height: 40 }),
      }),
    ).toBe(false);
    expect(
      evaluatePredicate(predicate, {
        checkVisibility: () => true,
        getBoundingClientRect: () => ({ width: 0, height: 40 }),
      }),
    ).toBe(false);
  });

  it('falls back to ancestor style checks when checkVisibility is unavailable', () => {
    const predicate = visiblePredicate();
    const hiddenParent = {
      parentElement: null,
      style: {
        display: 'block',
        visibility: 'visible',
        contentVisibility: 'visible',
        opacity: '0',
      },
    };
    const element = {
      parentElement: hiddenParent,
      getBoundingClientRect: () => ({ width: 100, height: 40 }),
      style: {
        display: 'block',
        visibility: 'visible',
        contentVisibility: 'visible',
        opacity: '1',
      },
    };
    expect(
      evaluatePredicate(
        predicate,
        element,
        (node) => (node as { style: Record<string, string> }).style,
      ),
    ).toBe(false);
    hiddenParent.style.opacity = '1';
    expect(
      evaluatePredicate(
        predicate,
        element,
        (node) => (node as { style: Record<string, string> }).style,
      ),
    ).toBe(true);
  });

  it('keeps selector interpolation inside one JSON string literal', () => {
    const r = agentIntentToDispatch({
      kind: 'wait',
      condition: 'selector_visible',
      selector: '.ready',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('narrow');
    // P-3 (2026-09-06) — the call moved from `document.querySelector` to the
    // shadow-piercing `deepQuery`, which takes the SAME single JSON literal. The
    // property this arm pins is the literal, not the function name.
    expect(r.params.predicate).toContain('deepQuery(".ready")');
  });

  it('converts timeoutMs → ceil seconds when >= 1s', () => {
    const r = agentIntentToDispatch({
      kind: 'wait',
      condition: 'selector_visible',
      selector: '#x',
      timeoutMs: 4200,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('narrow');
    expect(r.params.timeout_seconds).toBe(5);
  });

  it('omits timeout_seconds for sub-second waits (harness default applies)', () => {
    const r = agentIntentToDispatch({
      kind: 'wait',
      condition: 'selector_visible',
      selector: '#x',
      timeoutMs: 0,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('narrow');
    expect(r.params.timeout_seconds).toBeUndefined();
  });

  it('predicate is injection-safe: a selector with quotes/parens is JSON-escaped, not interpolated raw', () => {
    const evil = '")); fetch("/admin"); //';
    const r = agentIntentToDispatch({
      kind: 'wait',
      condition: 'selector_visible',
      selector: evil,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('narrow');
    // The selector must appear ONLY as a JSON string literal argument.
    expect(r.params.predicate).toContain(`deepQuery(${JSON.stringify(evil)})`);
    // No raw break-out: the fetch payload is inside the quoted literal.
    expect(r.params.predicate).not.toMatch(/deepQuery\(""\)\);/);
    // The selector reaches the DOM exactly once, through the one interpolation —
    // `deepQuery` forwards its argument and never rebuilds the string.
    expect(String(r.params.predicate).split(JSON.stringify(evil))).toHaveLength(2);
    const querySelector = vi.fn(() => null);
    expect(
      runInNewContext(`(function () { ${String(r.params.predicate)} })()`, {
        document: { querySelector },
      }),
    ).toBe(false);
    expect(querySelector).toHaveBeenCalledWith(evil);
  });
});

describe('agentIntentToDispatch — typed unsupported', () => {
  it('interact:swipe → unsupported (no harness swipe intent)', () => {
    const r = agentIntentToDispatch({ kind: 'interact', action: 'swipe' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('narrow');
    expect(r.reason).toMatch(/swipe has no harness intent/);
  });

  it('interact:press → press_key { key } (W1221 harness handler live; the DOM KeyboardEvent.key rides in value)', () => {
    const r = agentIntentToDispatch({ kind: 'interact', action: 'press', value: 'Enter' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('narrow');
    expect(r.intentName).toBe('press_key');
    expect(r.params).toEqual({ key: 'Enter' });
  });

  it('interact:press with no value → fail-closed (the key name is required)', () => {
    const r = agentIntentToDispatch({ kind: 'interact', action: 'press' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('narrow');
    expect(r.reason).toMatch(/requires a value/);
  });

  it('#139/R7 wait:idle → wait_for with a STATELESS load/resource/font quiet window', () => {
    // The decomposer inserts an idle-settle after navigate; it must map to a real
    // wait_for predicate, not halt the plan (which lost the following screenshot).
    const r = agentIntentToDispatch({ kind: 'wait', condition: 'idle' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('narrow');
    expect(r.intentName).toBe('wait_for');
    expect(r.params.predicate).toEqual(expect.any(String));
    expect(r.params.predicate).toContain("document.readyState !== 'complete'");
    expect(r.params.predicate).toContain("performance.getEntriesByType('navigation')");
    expect(r.params.predicate).toContain('loadEventEnd');
    expect(r.params.predicate).toContain(`now - loadEnd >= ${String(SETTLE_CEILING_MS)}`);
    expect(r.params.predicate).toContain(`now - latest >= ${String(SETTLE_QUIET_MS)}`);
    expect(r.params.predicate).toContain("document.fonts.status === 'loaded'");
    expect(r.params.predicate).toContain("performance.getEntriesByType('resource')");
  });

  /**
   * R7 — evaluate the SETTLE predicate against a fake page.
   *
   * `navigation` and `resource` come from the same accessor the real one does,
   * so a predicate that stopped asking for either fails here rather than in
   * production.
   */
  function settleContext(opts: {
    readyState: string;
    loadEventEnd: number | null;
    fonts?: { status: string };
    resources: Array<{ responseEnd: number }>;
    nowRef: { value: number };
  }): { evaluate: () => boolean; document: { readyState: string; fonts?: { status: string } } } {
    const r = agentIntentToDispatch({ kind: 'wait', condition: 'idle' });
    if (!r.ok) throw new Error('narrow');
    const predicate = String(r.params.predicate);
    const document: { readyState: string; fonts?: { status: string } } = {
      readyState: opts.readyState,
      ...(opts.fonts !== undefined ? { fonts: opts.fonts } : {}),
    };
    const context = createContext({
      document,
      performance: {
        now: () => opts.nowRef.value,
        getEntriesByType: (type: string) =>
          type === 'navigation'
            ? opts.loadEventEnd === null
              ? []
              : [{ loadEventEnd: opts.loadEventEnd }]
            : opts.resources,
      },
    });
    return {
      evaluate: () => runInContext(`(function () { ${predicate} })()`, context) as boolean,
      document,
    };
  }

  it('R7 wait:idle settles on a quiet window after the load event, and has a 3s ceiling', () => {
    const nowRef = { value: 1_000 };
    const resources: Array<{ responseEnd: number }> = [];
    const fonts = { status: 'loading' };
    const { evaluate, document } = settleContext({
      readyState: 'loading',
      loadEventEnd: 1_000,
      fonts,
      resources,
      nowRef,
    });

    expect(evaluate(), 'a loading document never settles').toBe(false);
    document.readyState = 'complete';
    nowRef.value = 1_400;
    expect(evaluate(), 'fonts still loading').toBe(false);
    fonts.status = 'loaded';
    expect(evaluate(), '400ms is not the 500ms quiet window').toBe(false);
    nowRef.value = 1_500;
    expect(evaluate(), '500ms after the load event with nothing moving').toBe(true);

    // ⛔ STATELESS: asking twice at the same instant gives the same answer. The
    // old predicate DELETED its state on the success return, so a second poll
    // after a success started a fresh window and answered false — which is how
    // a page could hold the wait open by making that state unwritable.
    expect(evaluate()).toBe(true);

    // Resource Timing is START-ordered, so the final entry need not be the last
    // to finish: the bounded max, not `array.at(-1)`.
    resources.push({ responseEnd: 1_900 }, { responseEnd: 1_700 });
    nowRef.value = 2_399;
    expect(evaluate(), 'a resource that completed at 1900 extends the quiet window').toBe(false);
    nowRef.value = 2_400;
    expect(evaluate()).toBe(true);

    // The ceiling wins over a page that never goes quiet.
    fonts.status = 'loading';
    resources.push({ responseEnd: 3_500 });
    nowRef.value = 3_999;
    expect(evaluate(), 'still inside the 3s ceiling, and the page is still moving').toBe(false);
    nowRef.value = 4_000;
    expect(evaluate(), '3s past loadEventEnd is settled whatever the page is doing').toBe(true);
  });

  it('CRITICAL R7 a settle long after the load event is decided by the QUIET WINDOW, not by the ceiling', () => {
    // ⛔ THE REGRESSION THIS ARM EXISTS FOR. The ceiling is "three seconds since
    // this wait began", and a stateless predicate has only `loadEventEnd` to
    // measure from. Compared without a bound, a settle after a tap that changes
    // the view WITHOUT a navigation — a same-document route change, a "load
    // more" — finds a load event minutes old and returns true on its first poll
    // whatever the page is doing. That is not a stricter settle; it is no
    // settle. The corpus cannot see it: the fake device models a settle by the
    // fixture's own `settleMs` and never evaluates this source.
    const nowRef = { value: 60_000 };
    const resources = [{ responseEnd: 59_900 }];
    const { evaluate } = settleContext({
      readyState: 'complete',
      loadEventEnd: 1_000,
      fonts: { status: 'loaded' },
      resources,
      nowRef,
    });
    expect(
      evaluate(),
      'a page that fetched 100ms ago is not settled, however old its load event is',
    ).toBe(false);
    nowRef.value = 60_399;
    expect(evaluate(), 'still inside the quiet window').toBe(false);
    nowRef.value = 60_400;
    expect(evaluate(), 'and it settles on the quiet window, the way it always did').toBe(true);

    // The bound is the span a settle that BEGAN at the load event could still be
    // polling — so the case the ceiling exists for is untouched (asserted in the
    // arm above), and this is where it stops applying.
    expect(SETTLE_CEILING_APPLIES_WITHIN_MS).toBe(
      SETTLE_CEILING_MS + SETTLE_TIMEOUT_SECONDS * 1000,
    );
    const atTheEdge = { value: 1_000 + SETTLE_CEILING_APPLIES_WITHIN_MS };
    const edge = settleContext({
      readyState: 'complete',
      loadEventEnd: 1_000,
      fonts: { status: 'loading' },
      resources: [{ responseEnd: atTheEdge.value - 10 }],
      nowRef: atTheEdge,
    });
    expect(edge.evaluate(), 'past the bound the ceiling no longer answers for the page').toBe(
      false,
    );
    atTheEdge.value -= 1;
    const inside = settleContext({
      readyState: 'complete',
      loadEventEnd: 1_000,
      fonts: { status: 'loading' },
      resources: [{ responseEnd: atTheEdge.value - 10 }],
      nowRef: atTheEdge,
    });
    expect(inside.evaluate(), 'one millisecond inside it, the ceiling still does').toBe(true);
  });

  it('R7 ⛔ WHAT IS LOST, asserted: a DOM-only change with no network does not extend the window', () => {
    // Named honestly rather than left to be discovered. The old MutationObserver
    // extended the quiet window when script mutated the document without
    // fetching anything; a stateless predicate cannot see that, because a
    // mutation leaves no timestamp a later poll can read. The settle can
    // therefore return true while such a page is still moving. Bounded by the
    // same ceiling either way, and the step after it fails on its own selector
    // with a clearer reason than "the page never settled".
    const nowRef = { value: 1_600 };
    const { evaluate } = settleContext({
      readyState: 'complete',
      loadEventEnd: 1_000,
      fonts: { status: 'loaded' },
      resources: [],
      nowRef,
    });
    expect(evaluate()).toBe(true);
  });

  it('R7 a complete document with no navigation entry and no resources settles at once', () => {
    // The chosen degradation on a browsing context without Navigation Timing:
    // there is nothing left to wait for, so the settle is what the plan did
    // before a settle existed. ⛔ Never a silent 30s stall — the timeout is
    // always sent (see below).
    const nowRef = { value: 5_000 };
    const { evaluate } = settleContext({
      readyState: 'complete',
      loadEventEnd: null,
      fonts: { status: 'loaded' },
      resources: [],
      nowRef,
    });
    expect(evaluate()).toBe(true);
  });

  it('R7 with no navigation entry but a live resource, the quiet window still applies', () => {
    const nowRef = { value: 5_000 };
    const { evaluate } = settleContext({
      readyState: 'complete',
      loadEventEnd: null,
      fonts: { status: 'loaded' },
      resources: [{ responseEnd: 4_800 }],
      nowRef,
    });
    expect(evaluate(), '200ms since the last resource is not quiet').toBe(false);
    nowRef.value = 5_300;
    expect(evaluate()).toBe(true);
  });

  it('R7 a page with no `fonts` at all is not held open by the font test', () => {
    const nowRef = { value: 2_000 };
    const { evaluate } = settleContext({
      readyState: 'complete',
      loadEventEnd: 1_000,
      resources: [],
      nowRef,
    });
    expect(evaluate()).toBe(true);
  });

  it('⛔ R7 wait:idle ALWAYS carries its own timeout — the device default never bounds a settle', () => {
    // Omitting the field handed the wait to the device's 30s default: a third
    // of the turn's whole wall clock, and what a page could make the old
    // stateful predicate spend by making its global unwritable.
    const bare = agentIntentToDispatch({ kind: 'wait', condition: 'idle' });
    expect(bare.ok).toBe(true);
    if (!bare.ok) throw new Error('narrow');
    expect(bare.params.timeout_seconds).toBe(SETTLE_TIMEOUT_SECONDS);

    // A sub-second request cannot buy LESS than the ceiling the predicate
    // itself can reach — asking for 1s would guarantee a timeout on any page
    // that needs the ceiling.
    const tiny = agentIntentToDispatch({ kind: 'wait', condition: 'idle', timeoutMs: 100 });
    expect(tiny.ok).toBe(true);
    if (!tiny.ok) throw new Error('narrow');
    expect(tiny.params.timeout_seconds).toBe(SETTLE_TIMEOUT_SECONDS);

    // A longer one is obeyed: the planner is asking about a page, not falling
    // through to a number nobody chose.
    const longer = agentIntentToDispatch({ kind: 'wait', condition: 'idle', timeoutMs: 12_000 });
    expect(longer.ok).toBe(true);
    if (!longer.ok) throw new Error('narrow');
    expect(longer.params.timeout_seconds).toBe(12);
  });

  it('capture:pdf → unsupported (no harness pdf intent)', () => {
    const r = agentIntentToDispatch({ kind: 'capture', capture: 'pdf' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('narrow');
    expect(r.reason).toMatch(/pdf has no harness intent/);
  });

  it('interact:tap without selector → unsupported', () => {
    const r = agentIntentToDispatch({ kind: 'interact', action: 'tap' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('narrow');
    expect(r.reason).toMatch(/tap requires a selector/);
  });

  it('interact:type without value → unsupported', () => {
    const r = agentIntentToDispatch({ kind: 'interact', action: 'type', selector: '#x' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('narrow');
    expect(r.reason).toMatch(/type requires a value/);
  });

  it('wait:selector_visible without selector → unsupported', () => {
    const r = agentIntentToDispatch({ kind: 'wait', condition: 'selector_visible' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('narrow');
    expect(r.reason).toMatch(/selector_visible requires a selector/);
  });
});

describe('agentIntentToDispatch — produced params satisfy the harness contract', () => {
  // Every ok mapping must produce params the canonical harness param schema
  // accepts (closes the loop with harness-control-protocol.ts).
  const oks: AgentIntent[] = [
    { kind: 'navigate', url: 'https://x' },
    { kind: 'interact', action: 'tap', selector: '#a' },
    { kind: 'interact', action: 'type', selector: '#a', value: 'v' },
    { kind: 'interact', action: 'scroll' },
    { kind: 'wait', condition: 'selector_visible', selector: '#a', timeoutMs: 3000 },
    { kind: 'wait', condition: 'idle' },
    { kind: 'capture', capture: 'screenshot' },
    { kind: 'capture', capture: 'dom_snapshot' },
  ];

  for (const intent of oks) {
    it(`${JSON.stringify(intent)} → params pass HARNESS_INTENT_PARAM_SCHEMAS`, () => {
      const r = agentIntentToDispatch(intent);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('narrow');
      expect(HARNESS_INTENT_PARAM_SCHEMAS[r.intentName].safeParse(r.params).success).toBe(true);
    });
  }
});

describe('P-3 — the generated wait predicate names nobody and outlives nothing', () => {
  // Three properties, all server-side only, all found by auditing what this module SHIPS
  // rather than what it returns. The predicate is a source string evaluated on a
  // customer's page, so every character of it is product surface.

  it('CRITICAL no emitted predicate carries a product or company string', () => {
    // A static guard on the OUTPUT, so a future edit cannot reintroduce a brand.
    // The old key was `Symbol.for('driftstack.agent.wait.idle.v1')`, assigned on
    // `globalThis`: one line of page script
    // (`Object.getOwnPropertySymbols(globalThis).map((s) => s.description)`) reads
    // the company name straight out of it.
    const emitted = [
      agentIntentToDispatch({ kind: 'wait', condition: 'idle' }),
      agentIntentToDispatch({ kind: 'wait', condition: 'selector_visible', selector: '.x' }),
    ];
    for (const r of emitted) {
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('narrow');
      const predicate = String(r.params.predicate);
      expect(predicate).not.toMatch(/driftstack/i);
      expect(predicate).not.toMatch(/anthropic|claude/i);
    }
  });

  it('CRITICAL R7 the settle WRITES NOTHING into the page — no global, no symbol, no observer', () => {
    // ⛔ THE THREE THINGS THE OLD STATE GAVE A PAGE, all of them properties of
    // keeping state in the page rather than of the name it was kept under:
    //   1. A constant, product-wide membership test —
    //      `Object.getOwnPropertySymbols(globalThis).some((s) => s.description
    //      === 'idle-settle.v1')` — readable during the wait and after it on
    //      every failure path, and identical in every session of every customer.
    //   2. A denial of service the PAGE chose: making that property getter-only
    //      made the assignment ineffective, so the predicate returned false for
    //      ever and the wait burned its whole timeout.
    //   3. A leaked document-wide MutationObserver per poll, when the getter
    //      returned a fresh object each time.
    // Asserted three ways: on the source, on a frozen global, and on a global
    // whose every write throws.
    const r = agentIntentToDispatch({ kind: 'wait', condition: 'idle' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('narrow');
    const predicate = String(r.params.predicate);
    expect(predicate).not.toContain('Symbol.for');
    expect(predicate).not.toContain('globalThis');
    expect(predicate).not.toContain('MutationObserver');

    // …and the OBSERVABLE half of the same property: the page's global namespace
    // is byte-for-byte what it was, after as many polls as a real wait makes.
    let now = 4_000;
    const context = createContext({
      document: { readyState: 'complete', fonts: { status: 'loaded' } },
      performance: {
        now: () => now,
        getEntriesByType: (type: string) =>
          type === 'navigation' ? [{ loadEventEnd: 1_000 }] : [],
      },
    });
    const globalShape = (): string =>
      String(
        runInContext(
          'Object.getOwnPropertyNames(globalThis).sort().join(",") + "|" + Object.getOwnPropertySymbols(globalThis).map((s) => String(s.description)).sort().join(",")',
          context,
        ),
      );
    const before = globalShape();
    const evaluate = () => runInContext(`(function () { ${predicate} })()`, context) as boolean;
    for (let poll = 0; poll < 20; poll += 1) expect(evaluate()).toBe(true);
    expect(globalShape(), 'the settle left something on the page for a site to read').toBe(before);
    // The symbol half stated on its own, because that is the exact tell: one
    // line of page script used to answer "is this browser one of theirs?".
    expect(before.endsWith('|')).toBe(true);

    // ⛔ NON-VACUITY, and it is the load-bearing half. The same harness DOES see
    // a false when the page is not settled — and it sees it on EVERY poll,
    // which the old stateful predicate could not do once a page made its state
    // unwritable. So the arm above is not passing because the predicate is
    // inert.
    now = 1_100;
    for (let poll = 0; poll < 20; poll += 1) expect(evaluate()).toBe(false);
    expect(globalShape()).toBe(before);
  });

  it('CRITICAL selector_visible reaches into open shadow roots, as the native wait does', () => {
    // The harness supplied the native template when asked whether this predicate could
    // be dropped: it is `!!deepQuerySelector(sel)`, which pierces shadow roots.
    // A plain `document.querySelector` does not, so the two waits disagreed about
    // whether the same selector matched.
    const r = agentIntentToDispatch({
      kind: 'wait',
      condition: 'selector_visible',
      selector: '.inside',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('narrow');

    const target = {
      getBoundingClientRect: () => ({ width: 10, height: 10 }),
      checkVisibility: () => true,
      parentElement: null,
    };
    const shadowRoot = {
      querySelector: (sel: string) => (sel === '.inside' ? target : null),
      querySelectorAll: () => [],
    };
    const host = { shadowRoot };
    const document = {
      querySelector: () => null, // light DOM does NOT have it
      querySelectorAll: () => [host],
    };
    const found = runInNewContext(`(function () { ${String(r.params.predicate)} })()`, {
      document,
      getComputedStyle: () => ({
        display: 'block',
        visibility: 'visible',
        contentVisibility: 'visible',
        opacity: '1',
      }),
    }) as boolean;
    expect(found, 'an element inside an open shadow root must be found').toBe(true);

    // Vacuity control: with no shadow root, the same fake DOM answers false — so
    // the arm above measured the descent and not a predicate that returns true.
    const noShadow = runInNewContext(`(function () { ${String(r.params.predicate)} })()`, {
      document: { querySelector: () => null, querySelectorAll: () => [{ shadowRoot: null }] },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    }) as boolean;
    expect(noShadow).toBe(false);
  });
});
