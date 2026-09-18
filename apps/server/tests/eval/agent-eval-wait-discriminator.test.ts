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
import { agentIntentToDispatch } from '../../src/services/agent-intent-to-dispatch.js';
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
    expect(selectorWait).not.toContain("Symbol.for('idle-settle.v1')");
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
    // Neither predicate is ever EXECUTED here. The shadow-DOM-piercing visibility
    // walk and the idle-settle MutationObserver are matched as text and never
    // run, so a green eval is entirely compatible with both being broken on the
    // real fork. This assertion exists so that limitation is written next to the
    // instrument rather than only in a report someone may not read.
    const idle = predicateFor({ kind: 'wait', condition: 'idle' });
    const selectorWait = predicateFor({
      kind: 'wait',
      condition: 'selector_visible',
      selector: '#x',
    });
    expect(idle).toContain('MutationObserver');
    expect(selectorWait).toContain('checkVisibility');
    expect(typeof idle).toBe('string');
    expect(typeof selectorWait).toBe('string');
  });
});
