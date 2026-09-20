// A finished step says what it DID. A failed one says what went wrong. Neither
// of them says `#place-order`.
//
// Before stage 2 the view rendered `intentLabel(intent)` — the raw action plus
// its CSS selector — as the visible label of every failed and every gated step,
// and as half the text of every approval. "tap #add-to-cart — A newsletter
// pop-up was covering the Add to cart button." is the product telling a
// customer how it is built, in the one moment they are least able to act on it.
//
// Two pure functions replace it, and this file is their guard:
//
//   · `stepFact(result)` — the mono chip beside a finished step: a host, the
//     text that was typed (masked when the server marked it sensitive), or an
//     image count. ⛔ NEVER a selector, and the last describe proves that over a
//     SWEEP rather than over the three cases someone remembered.
//   · `diagnosisCopy(category)` — a plain-language title for a failure. The
//     category set is OPEN (the SDK types it as its literals plus `string`), so
//     the fallback is the load-bearing case, not the edge case.
//
// Mutation-proved, each arm named with what breaks it:
//  • drop the `sensitive` branch in stepFact → the masking arm reds;
//  • return `intent.selector` for a tap → the sweep reds by name;
//  • make diagnosisCopy's lookup a plain object literal → the prototype arm
//    reds (`toString` resolves to a function, not to the fallback);
//  • drop the `?? fallback` → the unknown-category arm reds.

import { describe, expect, it } from 'vitest';
import type { AgentIntent, AgentIntentResult } from '@driftstack/sdk';
import {
  DIAGNOSIS_CATEGORIES,
  DIAGNOSIS_FALLBACK_TITLE,
  diagnosisCopy,
} from '../../src/lib/agent-diagnosis-copy';
import {
  SENSITIVE_MASK,
  answerHost,
  describeResult,
  humanIntentLabel,
  spokenOutcome,
  stepFact,
  technicalStepLine,
} from '../../src/views/agent-chat/PlanTimeline';

function ran(intent: AgentIntent, summary = 'did the thing'): AgentIntentResult {
  return { kind: 'success', intent, summary };
}

/** A step that stopped to ask — the one row whose words come from the pinned
 *  `describeResult` rather than from the server's own caption. */
function gated(intent: AgentIntent): AgentIntentResult {
  return {
    kind: 'confirmation_required',
    intent,
    category: 'purchase',
    matchedText: 'Place order',
  };
}

/** The string that must never reach a customer. Distinctive on purpose: the
 *  sweep below searches every chip for it, so a partial leak still trips. */
const SELECTOR = '#place-order-now';

/** What a CSS selector looks like, for the arms that test the shape rather than
 *  this one string: an id (`#x`), an attribute (`[type=…]`), a combinator
 *  (`>`), or a class (`.x` at a word boundary). A bare `.` is deliberately NOT
 *  in the set — a hostname is full of them, and a host is the one technical
 *  string a customer DOES recognise. */
const SELECTOR_SHAPE = /[#[\]>]|(^|\s)\.[a-z_-]/i;

describe('stepFact — the mono chip beside a finished step', () => {
  it('a navigation shows the host it landed on', () => {
    expect(stepFact(ran({ kind: 'navigate', url: 'https://shop.example.com/' }))).toEqual({
      kind: 'host',
      text: 'shop.example.com',
    });
  });

  it('a short path rides along, because "/checkout" is what the customer recognises', () => {
    expect(
      stepFact(ran({ kind: 'navigate', url: 'https://shop.example.com/checkout' }))?.text,
    ).toBe('shop.example.com/checkout');
  });

  it('⛔ a QUERY STRING never does — that is where session ids and search terms live', () => {
    const fact = stepFact(
      ran({ kind: 'navigate', url: 'https://shop.example.com/s?q=shoes&sid=abc123' }),
    );
    expect(fact?.text).toBe('shop.example.com');
    expect(fact?.text).not.toContain('sid');
    expect(fact?.text).not.toContain('?');
  });

  it('a long path is dropped rather than clipped into something unreadable', () => {
    const long = `https://shop.example.com/${'a'.repeat(40)}`;
    expect(stepFact(ran({ kind: 'navigate', url: long }))?.text).toBe('shop.example.com');
  });

  it('a URL this build cannot parse yields NOTHING, never the raw string', () => {
    // The fallback that matters: if an unparseable url fell through as text, a
    // server sending a selector-shaped "url" would print it in the chip.
    expect(stepFact(ran({ kind: 'navigate', url: SELECTOR }))).toBeNull();
    expect(stepFact(ran({ kind: 'navigate', url: '' }))).toBeNull();
  });

  it('a typed step shows the text that was typed, in quotes', () => {
    const fact = stepFact(
      ran({ kind: 'interact', action: 'type', selector: SELECTOR, value: 'trail running shoes' }),
    );
    expect(fact).toEqual({ kind: 'typed', text: '“trail running shoes”' });
  });

  it('⛔ a SENSITIVE typed step is masked — and to a FIXED width, so a PIN and a card number cannot be told apart by it', () => {
    const card = stepFact(
      ran({
        kind: 'interact',
        action: 'type',
        selector: '#card',
        value: '4242424242424242',
        sensitive: true,
      }),
    );
    const pin = stepFact(
      ran({ kind: 'interact', action: 'type', selector: '#pin', value: '0000', sensitive: true }),
    );
    expect(card?.text).toBe(SENSITIVE_MASK);
    expect(pin?.text).toBe(SENSITIVE_MASK);
    expect(card?.text).not.toContain('4242');
  });

  it('a typed step with nothing in it shows nothing — an empty pair of quotes is noise', () => {
    expect(stepFact(ran({ kind: 'interact', action: 'type', value: '   ' }))).toBeNull();
    expect(stepFact(ran({ kind: 'interact', action: 'type' }))).toBeNull();
  });

  it('a very long typed value is clipped, and the chip carries the clip mark', () => {
    const fact = stepFact(ran({ kind: 'interact', action: 'type', value: 'x'.repeat(120) }));
    expect(fact?.text.length).toBeLessThan(50);
    expect(fact?.text).toContain('…');
  });

  it('a screenshot counts itself; another capture kind says nothing', () => {
    expect(stepFact(ran({ kind: 'capture', capture: 'screenshot' }))?.text).toBe('1 image');
    expect(stepFact(ran({ kind: 'capture', capture: 'dom_snapshot' }))).toBeNull();
  });

  it('only a step that SUCCEEDED gets a chip', () => {
    const intent: AgentIntent = { kind: 'navigate', url: 'https://shop.example.com/' };
    expect(stepFact({ kind: 'failure', intent, reason: 'nope' })).toBeNull();
    expect(
      stepFact({ kind: 'confirmation_required', intent, category: 'purchase', matchedText: 'Buy' }),
    ).toBeNull();
  });
});

describe('⛔ the selector SWEEP — no chip, and no customer-facing label, can carry one', () => {
  // Every intent shape the SDK models, each carrying the same distinctive
  // selector. A sweep rather than a list: a new interact action, or a new
  // intent kind, is covered the day it is added.
  const CORPUS: ReadonlyArray<AgentIntent> = [
    { kind: 'navigate', url: 'https://shop.example.com/checkout' },
    { kind: 'interact', action: 'tap', selector: SELECTOR },
    { kind: 'interact', action: 'press', selector: SELECTOR },
    { kind: 'interact', action: 'scroll', selector: SELECTOR },
    { kind: 'interact', action: 'swipe', selector: SELECTOR },
    { kind: 'interact', action: 'type', selector: SELECTOR, value: 'shoes' },
    { kind: 'interact', action: 'type', selector: SELECTOR, value: 'secret', sensitive: true },
    { kind: 'wait', condition: 'selector_visible', selector: SELECTOR },
    { kind: 'capture', capture: 'screenshot' },
    { kind: 'scroll', direction: 'down' },
    { kind: 'behavioral_pause', duration_ms: 900 },
    { kind: 'teleport-to-the-moon' } as unknown as AgentIntent,
  ];

  it('the sweep has a population (a filter that matches nothing proves nothing)', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(10);
    expect(CORPUS.filter((i) => JSON.stringify(i).includes(SELECTOR))).toHaveLength(7);
  });

  it('no fact chip contains the selector', () => {
    for (const intent of CORPUS) {
      const fact = stepFact(ran(intent));
      expect(fact?.text ?? '', `chip for ${intent.kind}`).not.toContain(SELECTOR);
    }
  });

  it('no plain-language label contains the selector — nor any of its punctuation', () => {
    for (const intent of CORPUS) {
      const label = humanIntentLabel(intent);
      expect(label, `label for ${intent.kind}`).not.toContain(SELECTOR);
      expect(label.length, `label for ${intent.kind} is empty`).toBeGreaterThan(0);
      // A selector is recognisable by its SHAPE, not only by this exact
      // string. `.` is not in the set: a hostname has dots in it, and
      // "Open shop.example.com/checkout" is exactly what this label should say.
      expect(label, `label for ${intent.kind} is selector-shaped`).not.toMatch(SELECTOR_SHAPE);
    }
  });

  // ⛔ A VISUALLY-HIDDEN LINE IS STILL COPY. A gated row's words come from the
  // pinned `describeResult`, which leads with `intentLabel(intent)` — the raw
  // action and its selector. `PlanStep` renders that as an `sr-only` span, so
  // it is read aloud to a blind customer while neither the text-quality gate
  // nor the gallery's privacy scan can see it: both read what is PAINTED.
  // `spokenOutcome` keeps the pinned tail and drops that prefix.
  const DECISIONS = [
    { denied: false, approved: false },
    { denied: true, approved: false },
    { denied: false, approved: true },
  ] as const;

  it('no visually-hidden outcome line contains the selector — a screen-reader user is a customer', () => {
    for (const intent of CORPUS) {
      for (const { denied, approved } of DECISIONS) {
        const spoken = spokenOutcome(gated(intent), denied, approved) ?? '';
        expect(spoken, `spoken for ${intent.kind}`).not.toContain(SELECTOR);
        expect(spoken, `spoken for ${intent.kind} is selector-shaped`).not.toMatch(SELECTOR_SHAPE);
      }
    }
  });

  it('…and it still SAYS the pinned outcome, or the arm above passes by saying nothing at all', () => {
    const tap: AgentIntent = { kind: 'interact', action: 'tap', selector: SELECTOR };
    expect(spokenOutcome(gated(tap), false, false)).toBe('confirmation required (“Place order”)');
    expect(spokenOutcome(gated(tap), false, true)).toBe('approved, ran (“Place order”)');
    expect(spokenOutcome(gated(tap), true, false)).toBe('denied, skipped (“Place order”)');
  });

  it('a row that is not a decision speaks nothing extra — its own words already say it', () => {
    expect(spokenOutcome(ran({ kind: 'capture', capture: 'screenshot' }), false, false)).toBeNull();
    expect(
      spokenOutcome(
        { kind: 'failure', intent: CORPUS[1] as AgentIntent, reason: 'it moved' },
        false,
        false,
      ),
    ).toBeNull();
  });

  it('CONTROL — the ONE place it is allowed to appear still shows it, or the sweep above is measuring an empty room', () => {
    const line = technicalStepLine({ kind: 'interact', action: 'tap', selector: SELECTOR });
    expect(line).toContain(SELECTOR);
    expect(line).toBe(`tap · ${SELECTOR}`);
  });

  it('CONTROL — describeResult itself is UNCHANGED and still carries the technical label', () => {
    // The pin `an-approved-step-is-past-tense…` reads this function directly.
    // If it ever stopped leading with `intentLabel`, spokenOutcome would fall
    // silent rather than leak — and this arm is what would tell us.
    const tap: AgentIntent = { kind: 'interact', action: 'tap', selector: SELECTOR };
    expect(describeResult(gated(tap), false, false).text).toBe(
      `tap ${SELECTOR} — confirmation required (“Place order”)`,
    );
  });
});

describe('answerHost — where an answer was read from', () => {
  it('is the LAST page the turn navigated to', () => {
    expect(
      answerHost([
        ran({ kind: 'navigate', url: 'https://start.example.com/' }),
        ran({ kind: 'interact', action: 'tap', selector: SELECTOR }),
        ran({ kind: 'navigate', url: 'https://shop.example.com/p/1' }),
      ]),
    ).toBe('shop.example.com');
  });

  it('is undefined when the turn navigated nowhere — the card then omits the whole line rather than guessing', () => {
    expect(answerHost([ran({ kind: 'capture', capture: 'screenshot' })])).toBeUndefined();
    expect(answerHost([])).toBeUndefined();
    expect(answerHost([ran({ kind: 'navigate', url: 'not a url' })])).toBeUndefined();
  });
});

describe('diagnosisCopy — a failure category read as English', () => {
  it('every category this build knows has a title, and none of them is the fallback', () => {
    expect(DIAGNOSIS_CATEGORIES.length).toBeGreaterThanOrEqual(5);
    for (const category of DIAGNOSIS_CATEGORIES) {
      const copy = diagnosisCopy(category);
      expect(copy.title.length, category).toBeGreaterThan(4);
      expect(copy.title, category).not.toBe(DIAGNOSIS_FALLBACK_TITLE);
    }
  });

  it('a suggestion, where there is one, reads as an instruction the customer could send', () => {
    for (const category of DIAGNOSIS_CATEGORIES) {
      const { suggestion } = diagnosisCopy(category);
      if (suggestion === undefined) continue;
      // It goes in the composer and it goes on a button beside another one, so
      // it has to be short enough to sit there without wrapping the row.
      expect(suggestion.length, category).toBeLessThanOrEqual(56);
      expect(suggestion, category).not.toMatch(SELECTOR_SHAPE);
    }
  });

  it('⛔ a category from a NEWER SERVER gets the fallback, not a blank card', () => {
    const copy = diagnosisCopy('a_category_invented_next_quarter');
    expect(copy.title).toBe(DIAGNOSIS_FALLBACK_TITLE);
    expect(copy.suggestion).toBeUndefined();
  });

  it('an absent or non-string category gets the same fallback', () => {
    for (const bad of [undefined, null, 42, {}, [], true]) {
      expect(diagnosisCopy(bad).title).toBe(DIAGNOSIS_FALLBACK_TITLE);
    }
  });

  it('⛔ a PROTOTYPE key is not a category — `toString` must not resolve to a function', () => {
    // The reason the table is a Map. With a plain object literal, these three
    // would each return something truthy from Object.prototype and the card
    // would try to render it as a title.
    for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(diagnosisCopy(key).title, key).toBe(DIAGNOSIS_FALLBACK_TITLE);
    }
  });
});
