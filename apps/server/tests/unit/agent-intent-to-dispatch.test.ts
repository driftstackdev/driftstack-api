// Increment-2 (b) — unit tests for agentIntentToDispatch(): the pure map
// from customer AgentIntent → harness { intentName, params }. Covers every
// clean 1:1 mapping, every typed-unsupported verb, the missing-required-
// field cases, the wait_for predicate construction (+ injection safety),
// and that produced params pass the canonical harness param-schema.

import { describe, expect, it } from 'vitest';
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
  it('builds a querySelector truthy predicate', () => {
    const r = agentIntentToDispatch({
      kind: 'wait',
      condition: 'selector_visible',
      selector: '.ready',
    });
    expect(r).toEqual({
      ok: true,
      intentName: 'wait_for',
      params: { predicate: '!!document.querySelector(".ready")' },
    });
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
    expect(r.params.predicate).toBe(`!!document.querySelector(${JSON.stringify(evil)})`);
    // No raw break-out: the fetch payload is inside the quoted literal.
    expect(r.params.predicate).not.toMatch(/querySelector\(""\)\);/);
  });
});

describe('agentIntentToDispatch — typed unsupported', () => {
  it('interact:swipe → unsupported (no harness swipe intent)', () => {
    const r = agentIntentToDispatch({ kind: 'interact', action: 'swipe' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('narrow');
    expect(r.reason).toMatch(/swipe has no harness intent/);
  });

  it('wait:idle → unsupported (no harness predicate)', () => {
    const r = agentIntentToDispatch({ kind: 'wait', condition: 'idle' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('narrow');
    expect(r.reason).toMatch(/idle has no harness predicate/);
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
