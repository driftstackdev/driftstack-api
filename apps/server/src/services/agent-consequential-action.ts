// W443 — threshold_action_detected (v1.0-minimal): consequential-action
// classifier. The #1 autonomous-agent safety guardrail (A3 W785/W797): before
// the executor dispatches a consequential action (purchase / payment / account
// deletion), the run pauses for human confirmation (A3's stop-conditions hook
// `threshold_action_detected` + the challenge pause/resume machinery, W740-743).
//
// This module is the DETECTION half (loop-side, A2). The executor calls
// `classifyConsequentialAction(intent)` before dispatch; a `requiresConfirmation`
// verdict halts the plan and surfaces the action for approval (next slice).
//
// v1.0-MINIMAL: a CONSERVATIVE (high-precision) heuristic on the tap target's
// text, normalized first (W808) to defeat zero-width / bidi / fullwidth evasion.
// False NEGATIVES (a consequential action whose button text doesn't match) are
// acceptable for v1.0 — the full page-rep-element-label semantic classifier is
// v1.1 (needs A3's typed page-rep). False POSITIVES (spurious confirmation
// prompts) erode trust, so the patterns stay tight + clearly consequential.

import type { AgentIntent, ConsequentialActionCategory } from '@driftstack/api-types';

// Re-exported so the executor + tests import the category from one place; the
// canonical enum lives in api-types (IntentResultSchema's confirmation_required).
export type { ConsequentialActionCategory };

export interface ConsequentialActionVerdict {
  requiresConfirmation: boolean;
  /** Matched category — drives the confirmation prompt + the audit record. */
  category?: ConsequentialActionCategory;
  /** The exact matched text — surfaced to the customer for transparency. */
  matchedText?: string;
}

// Matched case-insensitively against a token-normalized `interact:tap` target
// (selector + value). Word-boundaried + specific so e.g. "buy" alone or
// "payment history" don't trip. Token normalization matters because the target
// is commonly a CSS selector (`#buy-now`, `.confirm_payment`, deleteAccount),
// not literal rendered prose.
const PATTERNS: ReadonlyArray<readonly [ConsequentialActionCategory, RegExp]> = [
  ['purchase', /\bbuy now\b/i],
  ['purchase', /\bplace (your )?order\b/i],
  ['purchase', /\bcomplete (purchase|order)\b/i],
  ['purchase', /\bconfirm order\b/i],
  ['purchase', /\bproceed to (checkout|payment)\b/i],
  ['purchase', /\bplace bid\b/i],
  ['payment', /\bconfirm payment\b/i],
  ['payment', /\bpay now\b/i],
  ['payment', /\b(submit|authorize) payment\b/i],
  ['payment', /\badd payment method\b/i],
  ['account_deletion', /\bdelete (my )?account\b/i],
  ['account_deletion', /\bclose (my )?account\b/i],
  ['account_deletion', /\bpermanently delete\b/i],
  ['account_deletion', /\bdeactivate account\b/i],
];

const NO_CONFIRMATION: ConsequentialActionVerdict = { requiresConfirmation: false };

// W808 (A3) — normalize the target text before the keyword match so invisible /
// compatibility-form evasion can't slip a consequential action past the guard:
//   - NFKC folds fullwidth + compatibility forms ("Ｄｅｌｅｔｅ" → "Delete") and
//     no-break / exotic spaces → regular spaces.
//   - then strip the full Unicode Default_Ignorable_Code_Point class so ANY
//     invisible / non-rendering char spliced into a keyword collapses out. This
//     SUBSUMES the original zero-width + bidi set (U+200B-200D, U+2060 word-
//     joiner, U+FEFF ZWNBSP, U+202A-202E bidi embed/override, U+2066-2069 bidi
//     isolates — kept explicit in the class for documentation) PLUS the chars the
//     hand-rolled set MISSED: U+00AD soft hyphen, U+034F combining grapheme
//     joiner, U+115F/U+1160/U+3164 Hangul fillers, U+180B-180E Mongolian
//     selectors, U+2061-2064 invisible math operators, U+FE00-FE0F variation
//     selectors, U+E0000-E0FFF tags/supplementary VS, etc. Those survive NFKC and
//     break the \b word boundary in the keyword regexes (e.g. "Buy<U+2062> Now" →
//     no match) — an invisible-char bypass of this guard (empirically verified).
//     Default_Ignorable EXCLUDES ordinary combining accents (U+0301 etc.), so
//     visible text like "café"/"naïve" is preserved unchanged.
//   * CROSS-SCRIPT CONFUSABLES, folded below. NFKC does not touch these and is
//     right not to: Cyrillic "\u0443" is a distinct letter, not a compatibility
//     variant of Latin "y". But this matcher's input is a selector or label read
//     off the page the agent is browsing, i.e. ATTACKER-CONTROLLED text, and
//     `B\u0443y Now` differs from `Buy Now` by one character while reading
//     identically to a human. Measured: the ASCII forms halt, the substituted
//     forms did not.
//
//     ⛔ The fold is deliberately ASYMMETRIC in cost. Over-matching costs one
//     extra confirmation prompt on a page whose genuine Cyrillic or Greek text
//     happens to skeletonise onto a keyword. Under-matching dispatches an
//     unconfirmed purchase, payment or account deletion. Only the second is a
//     security failure, so this errs toward halting.
//
//     Scope is narrow on purpose: single characters whose Latin skeleton is
//     unambiguous, not a general Unicode confusables table. A wider table folds
//     more strings onto keywords and the extra halts stop being cheap.
// Cross-script single-character confusables -> Latin skeleton. Cyrillic and Greek
// only; these are the scripts whose lowercase letterforms overlap ASCII closely
// enough to be indistinguishable in a rendered label.
const CONFUSABLES = new Map<string, string>(
  Object.entries({
    // Cyrillic lower
    '\u0430': 'a',
    '\u0435': 'e',
    '\u043E': 'o',
    '\u0440': 'p',
    '\u0441': 'c',
    '\u0445': 'x',
    '\u0456': 'i',
    '\u0455': 's',
    '\u0458': 'j',
    '\u04CF': 'l',
    '\u0261': 'g',
    // Cyrillic upper
    '\u0410': 'A',
    '\u0412': 'B',
    '\u0415': 'E',
    '\u041A': 'K',
    '\u041C': 'M',
    '\u041D': 'H',
    '\u041E': 'O',
    '\u0420': 'P',
    '\u0421': 'C',
    '\u0422': 'T',
    '\u0423': 'Y',
    '\u0425': 'X',
    '\u0405': 'S',
    '\u0406': 'I',
    '\u0408': 'J',
    // Greek lower
    '\u03B1': 'a',
    '\u03BF': 'o',
    '\u03C1': 'p',
    '\u03BD': 'v',
    '\u03C5': 'u',
    // Greek upper
    '\u0391': 'A',
    '\u0392': 'B',
    '\u0395': 'E',
    '\u0396': 'Z',
    '\u0397': 'H',
    '\u0399': 'I',
    '\u039A': 'K',
    '\u039C': 'M',
    '\u039D': 'N',
    '\u039F': 'O',
    '\u03A1': 'P',
    '\u03A4': 'T',
    '\u03A5': 'Y',
    '\u03A7': 'X',
  }),
);
// ⛔ AMBIGUOUS confusables: one glyph that plausibly substitutes for MORE THAN ONE
// Latin letter. Cyrillic "\u0443" is the case that motivated this -- Unicode's
// skeleton for it is "y", but the measured attack used it in the "u" slot of
// `B\u0443y Now`, and folding to a single letter closes one and leaves the other.
//
// The threat here is not fooling a human eye: the agent matches TEXT and acts
// without anyone looking. So any substitution that breaks the keyword match is an
// attack whether or not it is visually convincing, and picking one skeleton would
// have left the other half open while looking fixed.
//
// Resolved by generating every skeleton and halting if ANY matches. That is only
// affordable because the ambiguous set is tiny and the cost of a false halt is one
// confirmation prompt.
const AMBIGUOUS = new Map<string, readonly string[]>([['\u0443', ['u', 'y']]]);

const CONFUSABLE_RE = new RegExp(
  `[${[...CONFUSABLES.keys(), ...AMBIGUOUS.keys()].join('')}]`,
  'gu',
);

const EVASION_CHARS =
  /[\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069\p{Default_Ignorable_Code_Point}]/gu;

function normalizeOne(text: string, pick: (ch: string) => string): string {
  return (
    text
      .normalize('NFKC')
      .replace(EVASION_CHARS, '')
      // After NFKC (so fullwidth forms are already ASCII) and after invisible
      // stripping (so a joiner cannot split a substituted word).
      .replace(CONFUSABLE_RE, pick)
      // CSS/DOM identifiers frequently encode visible words as camelCase. Split
      // only a lower-case letter/digit followed by upper-case so acronyms remain
      // intact while buyNow/deleteAccount become two matchable tokens.
      .replace(/([\p{Ll}\p{Nd}])(\p{Lu})/gu, '$1 $2')
      // Treat selector syntax and identifier separators as word boundaries:
      // `#buy-now`, `.confirm_payment`, `[data-action="pay-now"]`, etc. Unicode
      // punctuation/symbol coverage also prevents a non-ASCII dash from becoming
      // an accidental safety bypass. Collapse runs for stable matchedText/signing.
      .replace(/[\p{P}\p{S}\s]+/gu, ' ')
      .trim()
  );
}

/**
 * Every skeleton the input could be standing in for.
 *
 * Unambiguous confusables fold to one letter. The ambiguous ones (see AMBIGUOUS)
 * fan out, so `B\u0443y Now` yields both "Buy Now" and "Byy Now" and the first
 * matches. Cardinality is 2^(ambiguous chars present), which is 1 for ordinary
 * text and bounded below by capping the fan-out — a crafted string full of
 * ambiguous characters must not turn a matcher into an exponential one.
 */
const MAX_SKELETONS = 8;

function normalizedCandidates(text: string): string[] {
  const present = [...AMBIGUOUS.keys()].filter((ch) => text.includes(ch));
  const base = normalizeOne(text, (ch) => CONFUSABLES.get(ch) ?? AMBIGUOUS.get(ch)?.[0] ?? ch);
  if (present.length === 0) return [base];
  const out = new Set<string>([base]);
  for (const ch of present) {
    for (const alt of AMBIGUOUS.get(ch) ?? []) {
      if (out.size >= MAX_SKELETONS) return [...out];
      out.add(
        normalizeOne(text, (c) =>
          c === ch ? alt : (CONFUSABLES.get(c) ?? AMBIGUOUS.get(c)?.[0] ?? c),
        ),
      );
    }
  }
  return [...out];
}

/**
 * Classify whether an intent is a consequential action that requires human
 * confirmation before the executor dispatches it. Pure + deterministic.
 *
 * Only `interact:tap` can trigger a consequential operation; navigate / wait /
 * capture / scroll / behavioral_pause / type are observational, navigational,
 * or input-staging (the SUBMIT tap is the consequential moment, not the typing).
 */
export function classifyConsequentialAction(intent: AgentIntent): ConsequentialActionVerdict {
  if (intent.kind !== 'interact' || intent.action !== 'tap') return NO_CONFIRMATION;
  const raw = `${intent.selector ?? ''} ${intent.value ?? ''}`;
  // Halt if ANY skeleton matches. Over-matching costs a confirmation prompt;
  // under-matching dispatches an unconfirmed purchase.
  for (const haystack of normalizedCandidates(raw)) {
    for (const [category, re] of PATTERNS) {
      const m = haystack.match(re);
      if (m) return { requiresConfirmation: true, category, matchedText: m[0] };
    }
  }
  return NO_CONFIRMATION;
}
