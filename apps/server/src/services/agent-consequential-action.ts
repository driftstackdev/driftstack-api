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

// Matched case-insensitively against a normalized `interact:tap` target
// (selector + value). Word-boundaried + specific so e.g. "buy" alone or
// "payment history" don't trip.
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
//   - then strip zero-width + bidi controls (U+200B-200D ZW space/non-joiner/
//     joiner, U+2060 word-joiner, U+FEFF ZWNBSP, U+202A-202E bidi embed/
//     override, U+2066-2069 bidi isolates) so "Delete" / RLO-wrapped text
//     collapses to the bare keyword.
// RESIDUAL: cross-script homoglyph substitution (Cyrillic "е" for Latin "e") is
// NOT folded by NFKC — caught by the v1.1 LLM-semantic classifier, out of scope
// for this conservative v1.0 keyword matcher.
const EVASION_CHARS = /[\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/g;

function normalizeForMatch(text: string): string {
  return text.normalize('NFKC').replace(EVASION_CHARS, '');
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
  const haystack = normalizeForMatch(`${intent.selector ?? ''} ${intent.value ?? ''}`);
  for (const [category, re] of PATTERNS) {
    const m = haystack.match(re);
    if (m) return { requiresConfirmation: true, category, matchedText: m[0] };
  }
  return NO_CONFIRMATION;
}
