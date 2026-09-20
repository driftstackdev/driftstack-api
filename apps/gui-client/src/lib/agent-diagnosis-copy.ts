// What a failed step MEANS, in the customer's language.
//
// The server sends two things about a failure: `reason`, a sentence written for
// a person, and `diagnosis.category`, a machine-readable label. Until now the
// view showed neither well — it printed `intentLabel(intent)` ("tap
// #add-to-cart"), a CSS selector, followed by the reason, and the only thing
// it did with the category was hide it.
//
// This file turns the category into a plain-language TITLE for the diagnosis
// card (spec §3.5) and, where there is an honest one, a SUGGESTION: a sentence
// the customer can send as their next instruction. The suggestion fills the
// composer and sends nothing — there is no step-retry API, so a button that
// promised to "retry this step" would be a lie.
//
// ⛔ THE CATEGORY SET IS OPEN. The SDK types it as the known literals plus
// `(string & {})`, and the server adds new ones over time, so this is a lookup
// with a fallback, never an exhaustive switch: a category from a newer server
// must produce a calm, true card, not a blank one or a crash. The `reason` the
// server wrote is rendered verbatim underneath either way, so the fallback
// loses the headline's precision and nothing else.

export interface DiagnosisCopy {
  /** The card's headline — what went wrong, with no jargon in it. */
  title: string;
  /**
   * An instruction the customer could send next, or undefined when there is
   * nothing honest to suggest. Never sent by itself: it fills the composer.
   */
  suggestion?: string;
}

/** The title a category this build does not know falls back to. Exported so a
 *  test can assert the fallback by identity rather than by retyping it. */
export const DIAGNOSIS_FALLBACK_TITLE = 'This step didn’t work';

/**
 * A `Map`, not an object literal: with a plain object an unknown category such
 * as `'constructor'` or `'toString'` would resolve through the prototype chain
 * and hand a function to the renderer. `Map.get` answers only for keys that
 * were actually put in it.
 */
const COPY: ReadonlyMap<string, DiagnosisCopy> = new Map<string, DiagnosisCopy>([
  [
    'element_covered',
    {
      title: 'Something was covering it',
      suggestion: 'Close what’s covering it, then continue',
    },
  ],
  [
    'element_not_found',
    {
      title: 'It couldn’t find that on the page',
      suggestion: 'Describe the button in my own words, then continue',
    },
  ],
  [
    'page_load_failed',
    {
      title: 'The page didn’t load',
      suggestion: 'Open that page again, then continue',
    },
  ],
  [
    'condition_not_met',
    {
      title: 'The page never got to the expected state',
      suggestion: 'Wait for the page to settle, then continue',
    },
  ],
  [
    'capture_failed',
    {
      title: 'The screenshot couldn’t be taken',
      suggestion: 'Take the screenshot again',
    },
  ],
  [
    'scroll_failed',
    {
      title: 'The page wouldn’t scroll',
      suggestion: 'Scroll down the page, then continue',
    },
  ],
  [
    'target_unverified',
    {
      title: 'It couldn’t be sure that was the right thing to tap',
      suggestion: 'Say which button to use, then continue',
    },
  ],
  ['result_too_large', { title: 'The page sent back more than fits in one step' }],
  ['session_error', { title: 'The browser stopped responding' }],
  ['invalid_request', { title: 'That step couldn’t be carried out as asked' }],
]);

/**
 * Plain-language copy for a failure category. Any value that is not a category
 * this build knows — including undefined, a non-string from a rehydrated chat,
 * and a category a newer server invented — gets the fallback title and no
 * suggestion.
 */
export function diagnosisCopy(category: unknown): DiagnosisCopy {
  if (typeof category !== 'string') return { title: DIAGNOSIS_FALLBACK_TITLE };
  return COPY.get(category) ?? { title: DIAGNOSIS_FALLBACK_TITLE };
}

/** Every category this build has written copy for. Exported so a test can
 *  sweep the whole table instead of naming the rows it happens to remember. */
export const DIAGNOSIS_CATEGORIES: ReadonlyArray<string> = [...COPY.keys()];
