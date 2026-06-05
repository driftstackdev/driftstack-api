// Increment-2 — ControlPlaneAgentExecutor: the control-plane AgentExecutor.
//
// Chains the pure data-path pieces into a plan runner:
//   for each AgentIntent in the plan:
//     agentIntentToDispatch (verb → intentName+params, or typed-unsupported)
//       → serializeIntentDispatch (base64 wire envelope)
//       → IntentDispatcher.dispatch (the correlator → WSS → IntentResult)
//       → intentResultToCustomer (ParsedIntentResult → customer IntentResult)
//     accumulate; HALT on the first failure (matches the AgentExecutor contract).
//
// This is the CORRECT-LAYER successor to RealAgentExecutor (agent-executor.ts),
// which dispatched to the local driver — the architecture-superseded path
// (agent-session intents dispatch over the control-plane WSS by intentName, not
// the server driver; see docs/internal/cross-agent-control-plane-contract.md).
//
// Depends only on an injected `IntentDispatcher` (IntentDispatchCorrelator
// satisfies it) — so it's unit-testable with a mock dispatcher today, and the
// live wiring is just `new ControlPlaneAgentExecutor(correlator)` once the
// /v1/fleet/events WS transport lands (gated on the fleet_nodes migration +
// per-node key provisioning). NOT yet wired into bootstrap (StubAgentExecutor
// stays) — that swap is a founder/launch call.
//
// Never throws (AgentExecutor contract): a mapping miss, an encode error, and a
// dispatch failure (the dispatcher itself never rejects) all surface as a
// `kind:'failure'` IntentResult.

import { randomUUID } from 'node:crypto';
import type {
  AgentExecutor,
  ExecuteArgs,
  ExecutorRunResult,
  IntentResult,
} from './agent-executor.js';
import { agentIntentToDispatch } from './agent-intent-to-dispatch.js';
import { intentResultToCustomer } from './agent-intent-result.js';
import { serializeIntentDispatch, type ParsedIntentResult } from './harness-control-codec.js';
import type { IntentDispatch } from '../schemas/harness-control-protocol.js';

/** The dispatch port the executor needs — IntentDispatchCorrelator implements
 *  it. dispatch() must never reject (resolve with a failure ParsedIntentResult
 *  on timeout / no-session / drop). */
export interface IntentDispatcher {
  dispatch(dispatch: IntentDispatch): Promise<ParsedIntentResult>;
}

export class ControlPlaneAgentExecutor implements AgentExecutor {
  constructor(
    private readonly dispatcher: IntentDispatcher,
    /** intentId generator — injectable for deterministic tests. */
    private readonly genIntentId: () => string = () => `int_${randomUUID()}`,
  ) {}

  async execute(args: ExecuteArgs): Promise<ExecutorRunResult> {
    const results: IntentResult[] = [];
    for (const intent of args.plan.intents) {
      // 1. Map the customer verb → harness intentName + params (or unsupported).
      const mapped = agentIntentToDispatch(intent);
      if (!mapped.ok) {
        results.push({ kind: 'failure', intent, reason: mapped.reason });
        break;
      }

      // 2. Serialize to the base64 wire envelope. Re-validates params; should
      //    not fail (agentIntentToDispatch already validated), but the executor
      //    must never throw, so a guard converts any encode error to a failure.
      let dispatch: IntentDispatch;
      try {
        dispatch = serializeIntentDispatch({
          sessionId: args.sessionId,
          intentId: this.genIntentId(),
          intentName: mapped.intentName,
          params: mapped.params,
        });
      } catch (err) {
        results.push({
          kind: 'failure',
          intent,
          reason: err instanceof Error ? err.message : 'failed to encode intent dispatch',
        });
        break;
      }

      // 3. Dispatch over the control plane + 4. map the result back. The
      //    dispatcher never rejects (failure → a failure ParsedIntentResult).
      const parsed = await this.dispatcher.dispatch(dispatch);
      const result = intentResultToCustomer(intent, parsed);
      results.push(result);
      if (result.kind === 'failure') break; // halt-on-first-failure
    }

    return { results, ok: results.every((r) => r.kind === 'success') };
  }
}
