// A provider reply for the READ-BACK, served to the REAL answer path.
//
// The runtime's read-back runs through the product's own
// `ClaudeAgentDecomposer.answerFromObservation`: the real request assembly, the
// real observation bound, the real `ANSWER_SYSTEM_PROMPT`, the real envelope
// parsing (fence stripping, the `answer` string requirement) and the real usage
// accounting. Only the provider is substituted, and this file is that
// substitution.
//
// ⛔ WHAT THIS IS NOT. It is NOT a recording, and it is never filed under
// `recordings/`. No model produced the text it returns — a page rule did (see
// `answer-rule.ts`). Calling it a recording would be a fabricated record that
// verifies green: internally consistent, externally false. Every artefact this
// harness writes therefore names the answerer as a rule, not as a model.
//
// ⛔ AND IT CANNOT SEE THE CRITERION. It is constructed from an `AnswerRule` and
// the AnswerArgs the runtime passed. A criterion is not reachable from either.
//
// The provider also carries two POSITIVE CONTROLS on the product's own request
// assembly, because "the answer came back" proves nothing about what was asked:
// the body must carry the customer's question AND the observation verbatim, and
// it must carry a non-empty system prompt. A provider that answered a request it
// never checked would make a mangled prompt look healthy.

import { answerFromPage, type AnswerRule } from './answer-rule.js';
import { sha256Hex } from './hash.js';

/** Fixed accounting so token figures stay diffable between runs. */
export const ANSWER_INPUT_TOKENS = 1_140;
export const ANSWER_OUTPUT_TOKENS = 60;
export const ANSWER_TOKENS_TOTAL = ANSWER_INPUT_TOKENS + ANSWER_OUTPUT_TOKENS;

/** What the provider OBSERVED about the request the product actually built. */
export interface StandInAnswerRequest {
  /** sha256 of the system prompt the real answer path sent, read off the wire.
   *  Observed rather than imported: the answer prompt is not exported from the
   *  decomposer, and a copy here would keep pinning a prompt that had moved. */
  systemPromptSha256: string;
  model: string;
  bodyBytes: number;
  observationChars: number;
}

/** The AnswerArgs the runtime handed the decomposer for the call in flight. */
export interface PendingAnswerCall {
  task: string;
  observation: string;
}

export class StandInAnswerProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandInAnswerProviderError';
  }
}

/**
 * Build the fetch the real `ClaudeAgentDecomposer` calls.
 *
 * `pending` is read at request time rather than captured, because the decomposer
 * instance is reused across a turn and the observation belongs to ONE call.
 */
export function standInAnswerProvider(args: {
  rule: AnswerRule;
  pending: () => PendingAnswerCall | null;
  onRequest: (seen: StandInAnswerRequest) => void;
}): typeof globalThis.fetch {
  const impl = (_url: string | URL, init?: RequestInit): Promise<Response> => {
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const parsed = JSON.parse(bodyText) as {
      model?: unknown;
      system?: unknown;
      messages?: unknown;
    };
    if (typeof parsed.system !== 'string' || parsed.system.trim().length === 0) {
      return Promise.reject(
        new StandInAnswerProviderError(
          'the real answer path sent no system prompt — the read-back would be unframed, and the observation is untrusted page text',
        ),
      );
    }
    const call = args.pending();
    if (call === null) {
      return Promise.reject(
        new StandInAnswerProviderError(
          'a provider request arrived with no read-back call in flight — the harness has lost track of which observation is being answered',
        ),
      );
    }
    // POSITIVE CONTROLS on the product's own assembly. Containment, never a
    // re-derivation of the product's framing string: re-deriving it here is how
    // a double drifts into agreeing with itself.
    if (!bodyText.includes(JSON.stringify(call.observation).slice(1, -1))) {
      return Promise.reject(
        new StandInAnswerProviderError(
          'the request the answer path built does not carry the observation it was given — the model would be answering about a different page',
        ),
      );
    }
    if (!bodyText.includes(JSON.stringify(call.task).slice(1, -1))) {
      return Promise.reject(
        new StandInAnswerProviderError(
          'the request the answer path built does not carry the customer question — the answer would be to a question nobody asked',
        ),
      );
    }
    const model = typeof parsed.model === 'string' ? parsed.model : 'unknown';
    args.onRequest({
      systemPromptSha256: sha256Hex(parsed.system),
      model,
      bodyBytes: bodyText.length,
      observationChars: call.observation.length,
    });
    // The answer is derived from the PAGE, by a rule that has never seen the
    // criterion. Everything else on this envelope exists so the product's real
    // parser has something contract-shaped to refuse or accept.
    const answer = answerFromPage(args.rule, call.observation);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'msg_eval_standin',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: JSON.stringify({ answer }) }],
          stop_reason: 'end_turn',
          usage: { input_tokens: ANSWER_INPUT_TOKENS, output_tokens: ANSWER_OUTPUT_TOKENS },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  };
  return impl as unknown as typeof globalThis.fetch;
}
