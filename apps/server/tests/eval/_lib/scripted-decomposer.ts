// The SCRIPTED planner tier: a hand-written plan per task, and a read-back that
// runs through the PRODUCT'S OWN answer path.
//
// WHAT THIS TIER PROVES: that a plan of this exact shape, executed against a
// device with these exact properties, completes or dies at step k for reason r —
// and that the executor, the verb mapper, the result mapper, the read-back gate
// and the product's answer request/parse path handle it the way we believe.
//
// ⛔ WHAT IT PROVES ABOUT THE PLANNER: NOTHING. We wrote the plans. A completion
// rate from this tier is a statement about the harness and the execution layers,
// not about the model's judgment. The tier that would say something about the
// planner is `recorded` — see `recorded-decomposer.ts` for why this repository
// carries no recordings.
//
// ⛔ AND WHAT THE ANSWER HALF PROVES. `answerFromObservation` is NOT
// reimplemented here any more. It delegates to the real
// `ClaudeAgentDecomposer`, wired to a stand-in provider whose reply text comes
// from a page rule that has never seen the criterion (`answer-rule.ts`). So the
// real request assembly, the real answer prompt, the real envelope parsing and
// the real usage accounting all run — while the JUDGMENT in the reply is ours
// and is labelled as ours everywhere the number is reported.

import type { AgentIntent } from '@driftstack/api-types';
import {
  type AgentDecomposer,
  type AnswerArgs,
  type AnswerResult,
  type DecomposeArgs,
  type DecomposeResult,
} from '../../../src/services/agent-decomposer.js';
import { ClaudeAgentDecomposer } from '../../../src/services/agent-decomposer-claude.js';
import type { AnswerRule } from './answer-rule.js';
import {
  standInAnswerProvider,
  type PendingAnswerCall,
  type StandInAnswerRequest,
} from './stand-in-answer-provider.js';

/** Fixed per-call accounting so token figures are diffable between runs. */
export const SCRIPTED_DECOMPOSE_TOKENS = 900;

export interface ModelCallCounts {
  decompose: number;
  answer: number;
  decomposeTokens: number;
  answerTokens: number;
}

/** Everything OBSERVED about the read-back, as opposed to predicted about it. */
export interface ObservedAnswerPath {
  /** The runtime actually invoked `answerFromObservation`. */
  called: boolean;
  /** The page text the answer pass was handed, exactly. */
  lastObservation: string | null;
  /** What the product's parser returned, exactly. */
  lastAnswer: string | null;
  /** What the product's own request carried, read off the wire. */
  lastRequest: StandInAnswerRequest | null;
  /** A provider-side contract violation, if the answer path built a bad request. */
  providerError: string | null;
}

/** The scripted planner's constructor input — a plan and an answer rule, never
 *  a criterion. Keeping this narrower than `EvalTask` is what makes the
 *  criterion structurally unreachable from the answer path. */
export interface ScriptedPlannerScript {
  plan: ReadonlyArray<AgentIntent>;
  answerRule: AnswerRule;
}

/** Which planner tier an eval decomposer IS. Reported by the object itself so a
 *  report can relate the tier that ran to the tier its banner claims. */
export type EvalPlannerTier = 'scripted' | 'recorded' | 'live';

export class ScriptedAgentDecomposer implements AgentDecomposer {
  /**
   * ⛔ THE TIER, REPORTED BY THE THING THAT IS THE TIER. The provenance block in
   * the suite is a hand-written literal, and an arm that compares it to itself
   * would keep certifying "no decompose request is built" after `runEvalTask`
   * swapped tiers. The runner copies this onto every task report and the suite
   * asserts the two agree — two independent facts rather than one literal.
   */
  readonly tier: EvalPlannerTier = 'scripted';

  readonly calls: ModelCallCounts = {
    decompose: 0,
    answer: 0,
    decomposeTokens: 0,
    answerTokens: 0,
  };

  readonly observed: ObservedAnswerPath = {
    called: false,
    lastObservation: null,
    lastAnswer: null,
    lastRequest: null,
    providerError: null,
  };

  /** The call in flight, so the provider answers about the right observation. */
  private pending: PendingAnswerCall | null = null;
  private readonly answerPath: ClaudeAgentDecomposer;

  constructor(private readonly script: ScriptedPlannerScript) {
    this.answerPath = new ClaudeAgentDecomposer({
      // ⛔ Only the RULE crosses this boundary. The criterion is not in scope
      // here and cannot be reached from the provider closure.
      fetch: standInAnswerProvider({
        rule: script.answerRule,
        pending: () => this.pending,
        onRequest: (seen) => {
          this.observed.lastRequest = seen;
        },
      }),
      // No real network, so a backoff would only lengthen the run.
      retryBackoffMs: 0,
    });
  }

  decompose(_args: DecomposeArgs): Promise<DecomposeResult> {
    this.calls.decompose += 1;
    this.calls.decomposeTokens += SCRIPTED_DECOMPOSE_TOKENS;
    return Promise.resolve({
      kind: 'plan',
      intents: this.script.plan,
      tokensConsumed: SCRIPTED_DECOMPOSE_TOKENS,
    });
  }

  async answerFromObservation(args: AnswerArgs): Promise<AnswerResult> {
    // Recorded BEFORE the call, so a throwing answer path still shows up as
    // "the runtime reached the read-back" rather than as "a gate blocked it".
    // Those are different findings and the report must not merge them.
    this.calls.answer += 1;
    this.observed.called = true;
    this.observed.lastObservation = args.observation;
    this.pending = { task: args.task, observation: args.observation };
    try {
      const result = await this.answerPath.answerFromObservation(args);
      this.calls.answerTokens += result.tokensConsumed;
      this.observed.lastAnswer = result.answer;
      return result;
    } catch (err) {
      // The runtime swallows a read-back failure by design (the plan already
      // succeeded). That is correct for a customer and wrong for an instrument,
      // so the failure is kept here and the suite asserts it stayed null.
      this.observed.providerError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.pending = null;
    }
  }
}
