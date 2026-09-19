// The models the desktop chat offers, and which of them need the customer's own
// Anthropic key.
//
// Its own module, not a member of `use-agent-chat.ts`, on purpose: about twenty
// view tests replace that module wholesale with a hook double, and a list that
// lived there would be `undefined` in every one of them — the picker would throw
// on its first render. Both the hook (for the refusal sentence) and the view (for
// the picker) read the list from here.

import { CLAUDE_MODEL_KEY_POLICY, type AgentModel } from '@driftstack/api-types';
import type { ChatModel } from './use-agent-chat';

/** The picker's options, default first — it is what an untouched picker sends. */
export const CHAT_MODELS: ReadonlyArray<{ id: ChatModel; label: string }> = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

/** What an own-key-only model's option says while the account has no key. */
export const NEEDS_OWN_KEY_SUFFIX = '(needs your own key)';

/** The picker label for a model id, or null for an id this build does not offer
 *  (an older transcript, or a model the server chose). */
export function chatModelLabel(id: string): string | null {
  return CHAT_MODELS.find((m) => m.id === id)?.label ?? null;
}

/**
 * True when the model runs only on the customer's own Anthropic key.
 *
 * ⛔ An own-property lookup: a stored chat's model is read back from local
 * storage by a cast, so the type proves nothing about the value, and a plain
 * index would answer `toString` with something that is not a policy. An id the
 * policy does not name is NOT marked — the server's refusal still covers it.
 */
export function modelNeedsOwnKey(id: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(CLAUDE_MODEL_KEY_POLICY, id) &&
    CLAUDE_MODEL_KEY_POLICY[id as AgentModel] === 'own_key_only'
  );
}
