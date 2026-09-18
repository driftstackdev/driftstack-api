// Reading the provider REQUEST the product built, defensively.
//
// Every stand-in provider in this harness inspects the request it is handed —
// that is what makes it a control on the product's own assembly rather than a
// reply machine. The request shape is the product's to change, though: a
// `system` prompt may be a plain string, or a list of text blocks (the form the
// provider's prompt caching needs, because a cache breakpoint is a property of
// a block). Both say the same thing, and a stand-in that understood only one
// would turn a caching change into a red eval for a reason that has nothing to
// do with what the eval measures.

import { __TEST_ONLY__ } from '../../../src/services/agent-decomposer-claude.js';

/** The system prompt as one string, whichever form it was sent in; null when
 *  there is none. Blocks are joined with a newline, the way they read. */
export function systemPromptText(system: unknown): string | null {
  if (typeof system === 'string') return system.trim().length > 0 ? system : null;
  if (!Array.isArray(system)) return null;
  const parts: string[] = [];
  for (const block of system) {
    if (typeof block !== 'object' || block === null) continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === 'string') parts.push(text);
  }
  const joined = parts.join('\n');
  return joined.trim().length > 0 ? joined : null;
}

/** One message's text, whether its content is a string or a list of blocks. */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === 'string') parts.push(text);
  }
  return parts.join('\n');
}

export interface ProviderRequestView {
  model: string;
  system: string | null;
  stream: boolean;
  /**
   * What the product was asking for: a plan, or a read-back answer.
   *
   * ⛔ READ OFF THE SYSTEM PROMPT, NOT OFF `stream`. The two calls used to differ
   * in whether they streamed, and a harness that keyed on that mis-filed every
   * read-back as a planning call the day the read-back started streaming too —
   * and answered it with a plan. What actually distinguishes them is which of
   * the product's prompts they carry, and the planner's is read from the
   * product's own export rather than copied here.
   */
  purpose: 'plan' | 'answer';
  messages: ReadonlyArray<{ role: string; text: string }>;
}

/** The first line of the planner's system prompt, as the product exports it. */
const PLANNER_PROMPT_OPENING = __TEST_ONLY__.SYSTEM_PROMPT.split('\n')[0] ?? '';

/** The parts of a provider request body a stand-in reasons about. */
export function readProviderRequest(bodyText: string): ProviderRequestView {
  const parsed = JSON.parse(bodyText) as {
    model?: unknown;
    system?: unknown;
    stream?: unknown;
    messages?: unknown;
  };
  const messages: Array<{ role: string; text: string }> = [];
  // ⛔ TWO WIRES SPELL THE SYSTEM PROMPT DIFFERENTLY. The Messages API has a
  // top-level `system`; chat completions put it in the conversation as a
  // `system` message. Both are read, and a `system` message is kept OUT of
  // `messages`, so a stand-in's "the last user message" means the same thing on
  // either wire and a meter files the call under the right purpose.
  const systemMessages: string[] = [];
  if (Array.isArray(parsed.messages)) {
    for (const message of parsed.messages) {
      if (typeof message !== 'object' || message === null) continue;
      const m = message as { role?: unknown; content?: unknown };
      if (m.role === 'system') {
        systemMessages.push(messageText(m.content));
        continue;
      }
      messages.push({
        role: typeof m.role === 'string' ? m.role : 'unknown',
        text: messageText(m.content),
      });
    }
  }
  const system = systemPromptText(parsed.system) ?? systemPromptText(systemMessages.join('\n'));
  return {
    model: typeof parsed.model === 'string' ? parsed.model : 'unknown',
    system,
    stream: parsed.stream === true,
    purpose:
      PLANNER_PROMPT_OPENING.length > 0 && system?.includes(PLANNER_PROMPT_OPENING) === true
        ? 'plan'
        : 'answer',
    messages,
  };
}
