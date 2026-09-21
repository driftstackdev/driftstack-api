// THE ONE PLACE THE FAKE DEVICE GUESSES.
//
// A `wait` reaches the device as `wait_for` carrying only a generated JS
// predicate string. The device cannot evaluate JS, so it decides which wait it
// is looking at by matching substrings of that generated source. Any edit to the
// predicate builders in `agent-intent-to-dispatch.ts` therefore silently
// reclassifies every wait in the corpus.
//
// This file is the mitigation, and it is deliberately built the other way round
// from a normal test: the inputs are produced by `agentIntentToDispatch` ITSELF,
// so it pins what the mapper emits TODAY rather than a copy of it someone typed.
//
// ⛔ THE NEGATIVE CONTROL IS THE LOAD-BEARING HALF. A predicate matching neither
// branch must THROW. A fallback to "condition satisfied" would turn every wait
// in the corpus green — the harness would report a higher completion rate for a
// reason that is not a fact about the system, and nothing would fail.

import { describe, expect, it } from 'vitest';
import type { AgentIntent } from '@driftstack/api-types';
import {
  SETTLE_TIMEOUT_SECONDS,
  agentIntentToDispatch,
} from '../../src/services/agent-intent-to-dispatch.js';
import { HARNESS_WAIT_FOR_DEFAULT_TIMEOUT_SECONDS } from '../../src/schemas/harness-control-protocol.js';
import { UnknownWaitPredicateError, classifyWaitPredicate } from './_lib/fake-device.js';

function predicateFor(intent: Extract<AgentIntent, { kind: 'wait' }>): string {
  const mapped = agentIntentToDispatch(intent);
  if (!mapped.ok)
    throw new Error(`the mapper refused a wait the corpus depends on: ${mapped.reason}`);
  expect(mapped.intentName).toBe('wait_for');
  const predicate = mapped.params.predicate;
  if (typeof predicate !== 'string') throw new Error('wait_for carried no predicate string');
  return predicate;
}

describe('agent eval — the wait_for discriminator still matches what the mapper emits', () => {
  it('the idle settle is recognised as idle', () => {
    const predicate = predicateFor({ kind: 'wait', condition: 'idle' });
    expect(classifyWaitPredicate(predicate)).toEqual({ kind: 'idle' });
  });

  it('a selector wait is recognised, and the SELECTOR is recovered exactly', () => {
    const predicate = predicateFor({
      kind: 'wait',
      condition: 'selector_visible',
      selector: '#continue',
    });
    expect(classifyWaitPredicate(predicate)).toEqual({
      kind: 'selector_visible',
      selector: '#continue',
    });
  });

  it('a selector containing quotes round-trips — the recovery reads a JSON literal, not text up to the next quote', () => {
    // `a[href="/t/9182"]` is an ordinary selector and a naive non-greedy match
    // would recover `a[href=\` from it. Getting this wrong would silently make
    // every attribute-selector wait wait for the wrong thing.
    const selector = 'a[href="/t/9182"]';
    const predicate = predicateFor({ kind: 'wait', condition: 'selector_visible', selector });
    expect(classifyWaitPredicate(predicate)).toEqual({ kind: 'selector_visible', selector });
  });

  it('the two forms are mutually exclusive — neither predicate matches the other branch', () => {
    const idle = predicateFor({ kind: 'wait', condition: 'idle' });
    const selectorWait = predicateFor({
      kind: 'wait',
      condition: 'selector_visible',
      selector: '.reply.top',
    });
    expect(idle).not.toContain('const element = deepQuery(');
    // R7 — the settle is told apart by SHAPE now, so exclusivity is the
    // selector wait not carrying that shape. It reads none of the three.
    expect(selectorWait).not.toContain('document.readyState');
    expect(selectorWait).not.toContain('loadEventEnd');
    expect(selectorWait).not.toContain('document.fonts');
  });

  it('⛔ R7: the settle keeps NO page-world state — no global, no symbol, no observer', () => {
    // The whole finding, asserted on the OUTPUT so no future edit can put it
    // back quietly. The old predicate kept its poll-to-poll state on
    // `globalThis[Symbol.for('idle-settle.v1')]`, which gave a page a constant
    // product-wide membership test, a way to stall the wait for its full
    // timeout by making that property getter-only, and a leaked document-wide
    // MutationObserver per poll.
    const idle = predicateFor({ kind: 'wait', condition: 'idle' });
    expect(idle).not.toContain('Symbol.for');
    expect(idle).not.toContain('globalThis');
    expect(idle).not.toContain('MutationObserver');
    // Nothing is written into the page at all, so there is nothing to delete.
    expect(idle).not.toContain('delete ');
    // Non-vacuity: the predicate really is the settle and really does read the
    // three things it is recognised by.
    expect(classifyWaitPredicate(idle)).toEqual({ kind: 'idle' });
  });

  it('⛔ R7: a settle always names its own timeout, so the device default never bounds one', () => {
    // Omitting `timeout_seconds` handed the wait to the device's own 30s
    // default — a third of the turn's whole wall clock, and the thing a page
    // could make it spend by stalling the old stateful predicate.
    const mapped = agentIntentToDispatch({ kind: 'wait', condition: 'idle' });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) throw new Error('narrow');
    expect(mapped.params.timeout_seconds).toBe(SETTLE_TIMEOUT_SECONDS);
    expect(SETTLE_TIMEOUT_SECONDS).toBeLessThan(HARNESS_WAIT_FOR_DEFAULT_TIMEOUT_SECONDS);
    // A planner that names a LONGER one is still obeyed: it is asking about a
    // page, not falling through to a number nobody chose.
    const longer = agentIntentToDispatch({ kind: 'wait', condition: 'idle', timeoutMs: 20_000 });
    expect(longer.ok).toBe(true);
    if (!longer.ok) throw new Error('narrow');
    expect(longer.params.timeout_seconds).toBe(20);
  });

  it('NEGATIVE CONTROL: a predicate matching neither branch throws rather than defaulting to satisfied', () => {
    expect(() => classifyWaitPredicate('return document.readyState === "complete";')).toThrow(
      UnknownWaitPredicateError,
    );
    expect(() => classifyWaitPredicate('')).toThrow(/NEITHER discriminator/);
  });

  it('NEGATIVE CONTROL: a predicate matching BOTH branches throws rather than picking one', () => {
    const ambiguous = `${predicateFor({ kind: 'wait', condition: 'idle' })} ${predicateFor({
      kind: 'wait',
      condition: 'selector_visible',
      selector: '#x',
    })}`;
    expect(() => classifyWaitPredicate(ambiguous)).toThrow(/BOTH discriminators/);
  });

  it('⛔ states plainly what this harness can NOT say about either predicate', () => {
    // Neither predicate is ever EXECUTED here. The shadow-DOM-piercing
    // visibility walk and the settle's timing reads are matched as TEXT and
    // never run, so a green eval is entirely compatible with both being broken
    // on the real fork — and with the settle being observable on it, which it
    // is. This assertion exists so that limitation is written next to the
    // instrument rather than only in a report someone may not read. What DOES
    // execute both predicates is `agent-intent-to-dispatch.test.ts`, against a
    // fake DOM.
    const idle = predicateFor({ kind: 'wait', condition: 'idle' });
    const selectorWait = predicateFor({
      kind: 'wait',
      condition: 'selector_visible',
      selector: '#x',
    });
    expect(idle).toContain('document.fonts');
    expect(selectorWait).toContain('checkVisibility');
    expect(typeof idle).toBe('string');
    expect(typeof selectorWait).toBe('string');
  });
});
