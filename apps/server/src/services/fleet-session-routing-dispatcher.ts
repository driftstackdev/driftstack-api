// #139 go-live — session→node routing dispatcher.
//
// The ControlPlaneAgentExecutor depends on a single `IntentDispatcher` port
// (`dispatch(IntentDispatch) → ParsedIntentResult`). But the fleet control plane
// keys its dispatch correlators PER NODE: each authenticated fleet-node
// connection owns its own IntentDispatchCorrelator (its in-flight dispatches +
// timeouts — see fleet-control-registry.ts). So a plan's intents must be routed
// to the specific node the session was dispatched to; there is no single global
// correlator.
//
// This adapter closes that gap. For each IntentDispatch it:
//   1. resolves the session's owning node (agent_sessions.node_id, persisted at
//      dispatch by dispatchSessionAssignOnCreate → setNodeId);
//   2. looks that node's live connection up in the registry;
//   3. dispatches on THAT connection's correlator.
//
// A session with no assigned node, a control-plane that isn't up, or a node with
// no live connection all resolve to a synthesized `session_error` failure —
// NEVER a throw and NEVER a fake success — matching the IntentDispatcher contract
// (dispatch() must always resolve with a ParsedIntentResult, never reject). This
// is the whole point of the go-live: an honest "no box is connected to run this"
// instead of the StubAgentExecutor's synthetic per-intent successes.
//
// Decoupled from the concrete FleetControlRegistry / AgentSessionsRepo via narrow
// structural ports so it unit-tests against mocks; both real classes satisfy them.

import type { IntentDispatcher } from './agent-executor-control-plane.js';
import type { ParsedIntentResult } from './harness-control-codec.js';
import type { IntentDispatch, HarnessErrorCode } from '../schemas/harness-control-protocol.js';
import type { Logger } from '../lib/logger.js';

/** Narrow read port: resolve a session's owning fleet node. AgentSessionsRepo
 *  satisfies it structurally (its `get` returns a record carrying `nodeId`). */
export interface SessionNodeLookup {
  get(sessionId: string): Promise<{ nodeId: string | null } | null>;
}

/** Narrow port: the per-node correlator is itself an IntentDispatcher. */
export interface NodeDispatchConnection {
  readonly correlator: IntentDispatcher;
}

/** Narrow port over FleetControlRegistry.get(nodeId). */
export interface NodeConnectionRegistry {
  get(nodeId: string): NodeDispatchConnection | undefined;
}

/** Build the synthesized failure the executor consumes (same shape the
 *  correlator's own synthFailure produces). durationMs 0 — nothing ran. */
function routeFailure(
  d: IntentDispatch,
  errorCode: HarnessErrorCode,
  errorMessage: string,
): ParsedIntentResult {
  return {
    sessionId: d.sessionId,
    intentId: d.intentId,
    success: false,
    durationMs: 0,
    errorCode,
    errorMessage,
  };
}

/**
 * Routes each IntentDispatch to the correlator of the node its session was
 * dispatched to. `resolveRegistry` is a thunk (NOT the registry itself) because
 * bootstrap constructs this dispatcher BEFORE the registry exists (the registry
 * lives inside the fleet-control-plane deps built later) — the thunk reads the
 * forward holder lazily at dispatch time, long after construction completes.
 * Returns undefined until/unless the fleet control plane is up.
 */
export class FleetSessionRoutingDispatcher implements IntentDispatcher {
  constructor(
    private readonly resolveRegistry: () => NodeConnectionRegistry | undefined,
    private readonly sessions: SessionNodeLookup,
    private readonly logger?: Logger | null,
  ) {}

  async dispatch(d: IntentDispatch): Promise<ParsedIntentResult> {
    // 1. Which node owns this session?
    let nodeId: string | null;
    try {
      const rec = await this.sessions.get(d.sessionId);
      nodeId = rec?.nodeId ?? null;
    } catch (err) {
      // A transient lookup failure — the intent was never dispatched, so this is
      // side-effect-free (session_error/retryable; an interact stays no-retry by
      // the executor's fail-safe, a read-only kind may retry the read).
      this.logger?.warn(
        { component: 'fleet-session-routing', sessionId: d.sessionId, err: String(err) },
        'session→node lookup failed; failing dispatch (no intent transmitted)',
      );
      return routeFailure(
        d,
        'intent_dispatch_error',
        'could not resolve the session for this action — please retry',
      );
    }

    if (nodeId === null) {
      // Session never dispatched to a node (node_id NULL) — e.g. no live box at
      // create time, or a legacy row. Honest failure, not a fake success.
      //
      // errorCode `intent_dispatch_error`, NOT `intent_session_not_established`:
      // the latter is RESERVED for the box's fork still cold-starting its
      // WebDriver (the correlator synthesizes it from `intent_dispatch_no_session`),
      // and the executor gives THAT a long 12s patient retry to cover the warmup.
      // These three routing failures (no node / CP down / node disconnected) are
      // NOT a warming session — there is no box to reach at all, so they will not
      // recover inside that window; they must fail fast, not hang 12s. Same
      // session_error diagnosis + retryable hint, so the customer story is unchanged.
      return routeFailure(
        d,
        'intent_dispatch_error',
        'no automation device is currently running this session',
      );
    }

    // 2. Is the fleet control plane up, and is that node connected?
    const registry = this.resolveRegistry();
    if (registry === undefined) {
      return routeFailure(
        d,
        'intent_dispatch_error',
        'the automation control plane is not available',
      );
    }
    const conn = registry.get(nodeId);
    if (conn === undefined) {
      this.logger?.warn(
        { component: 'fleet-session-routing', sessionId: d.sessionId, nodeId },
        'owning fleet node has no live control connection; failing dispatch',
      );
      return routeFailure(
        d,
        'intent_dispatch_error',
        'the automation device for this session is not connected',
      );
    }

    // 3. Dispatch on the owning node's correlator (never rejects — synthesizes a
    //    failure on timeout / no-session / drop).
    return conn.correlator.dispatch(d);
  }
}
