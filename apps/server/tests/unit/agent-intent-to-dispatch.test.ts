// Increment-2 (b) — unit tests for agentIntentToDispatch(): the pure map
// from customer AgentIntent → harness { intentName, params }. Covers every
// clean 1:1 mapping, every typed-unsupported verb, the missing-required-
// field cases, the wait_for predicate construction (+ injection safety),
// and that produced params pass the canonical harness param-schema.

import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { AgentIntent } from '@driftstack/api-types';
import { agentIntentToDispatch } from '../../src/services/agent-intent-to-dispatch.js';
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
    expect(r.params.predicate).toContain('document.querySelector(".ready")');
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
    expect(r.params.predicate).toContain(`document.querySelector(${JSON.stringify(evil)})`);
    // No raw break-out: the fetch payload is inside the quoted literal.
    expect(r.params.predicate).not.toMatch(/querySelector\(""\)\);/);
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

  it('interact:press → press_key { key } (A3-W1221 harness handler live; the DOM KeyboardEvent.key rides in value)', () => {
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

  it("#139 wait:idle → wait_for with the page-settled predicate (document.readyState === 'complete')", () => {
    // The decomposer inserts an idle-settle after navigate; it must map to a real
    // wait_for predicate, not halt the plan (which lost the following screenshot).
    const r = agentIntentToDispatch({ kind: 'wait', condition: 'idle' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('narrow');
    expect(r.intentName).toBe('wait_for');
    expect(r.params).toEqual({ predicate: "return document.readyState === 'complete';" });
  });

  it('#139 wait:idle carries timeout_seconds when timeoutMs ≥ 1s', () => {
    const r = agentIntentToDispatch({ kind: 'wait', condition: 'idle', timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('narrow');
    expect(r.params).toEqual({
      predicate: "return document.readyState === 'complete';",
      timeout_seconds: 5,
    });
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
