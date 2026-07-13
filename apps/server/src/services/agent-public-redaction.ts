// Public-boundary redaction for agent plans, results, and transcript events.
//
// The runtime deliberately keeps exact type-action values in the encrypted
// transcript so a consequential-action confirmation can resume the reviewed
// plan without asking the model to reconstruct it. Public read surfaces do not
// need that replay secret. Keep one shared projection here so recipes, live
// transcript SSE, and turn responses cannot drift into different policies.

import type { AgentIntent, IntentResult } from '@driftstack/api-types';
import type { TranscriptEntry } from './agent-decomposer.js';
import { selectorImpliesSensitiveInput } from './agent-sensitive-input.js';

/** Return a public copy of an intent, omitting only sensitive typed text. */
export function publicAgentIntent(intent: AgentIntent): AgentIntent {
  if (
    intent.kind !== 'interact' ||
    intent.action !== 'type' ||
    (intent.sensitive !== true &&
      (intent.selector === undefined || !selectorImpliesSensitiveInput(intent.selector)))
  ) {
    return intent;
  }

  // `value` is optional on AgentIntent. Work on a copy so the encrypted
  // runtime/repository record retains the exact value needed for replay.
  const redacted = { ...intent, sensitive: true };
  delete redacted.value;
  return redacted;
}

/** Redact the originating intent nested inside a customer-facing result. */
export function publicIntentResult(result: IntentResult): IntentResult {
  const intent = publicAgentIntent(result.intent);
  return intent === result.intent ? result : { ...result, intent };
}

/** Redact structured intents without changing free-text transcript bodies. */
export function publicTranscriptEntry(entry: TranscriptEntry): TranscriptEntry {
  if (entry.intents === undefined) return entry;
  return { ...entry, intents: entry.intents.map(publicAgentIntent) };
}
