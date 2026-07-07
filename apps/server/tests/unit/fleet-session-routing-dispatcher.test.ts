// #139 go-live — unit tests for FleetSessionRoutingDispatcher: the adapter that
// routes each IntentDispatch to the correlator of the NODE the session was
// dispatched to (agent_sessions.node_id → registry.get(nodeId) → correlator).
//
// The critical correctness property is per-session routing: two sessions on two
// different nodes must dispatch to their OWN node's correlator, never crossed.
// Every unroutable path (no node, control plane down, node offline, lookup
// throws) must resolve an honest session_error / dispatch_error failure — NEVER
// reject and NEVER a fake success (that's the whole point of the go-live: replace
// the stub's synthetic successes with the truth).

import { describe, expect, it, vi } from 'vitest';
import {
  FleetSessionRoutingDispatcher,
  type NodeConnectionRegistry,
  type NodeDispatchConnection,
  type SessionNodeLookup,
} from '../../src/services/fleet-session-routing-dispatcher.js';
import type { IntentDispatcher } from '../../src/services/agent-executor-control-plane.js';
import {
  serializeIntentDispatch,
  type ParsedIntentResult,
} from '../../src/services/harness-control-codec.js';
import type { IntentDispatch } from '../../src/schemas/harness-control-protocol.js';

function dispatchFor(sessionId: string, intentId = 'int_1'): IntentDispatch {
  return serializeIntentDispatch({
    sessionId,
    intentId,
    intentName: 'navigate',
    params: { url: 'https://example.com' },
  });
}

/** A correlator stub that records what it dispatched + returns a tagged success. */
function nodeConn(nodeTag: string): NodeDispatchConnection & { got: IntentDispatch[] } {
  const got: IntentDispatch[] = [];
  const correlator: IntentDispatcher = {
    dispatch: (d) => {
      got.push(d);
      return Promise.resolve({
        sessionId: d.sessionId,
        intentId: d.intentId,
        success: true,
        durationMs: 5,
        outputData: { url: `https://example.com#${nodeTag}` },
      } satisfies ParsedIntentResult);
    },
  };
  return { correlator, got };
}

/** Sessions lookup returning a fixed sessionId→nodeId map. */
function sessionsWith(map: Record<string, string | null>): SessionNodeLookup {
  return {
    get: (id) => Promise.resolve(id in map ? { nodeId: map[id] ?? null } : null),
  };
}

describe('FleetSessionRoutingDispatcher', () => {
  it('routes an intent to the correlator of the session’s owning node', async () => {
    const nodeA = nodeConn('A');
    const registry: NodeConnectionRegistry = {
      get: (nodeId) => (nodeId === 'node-A' ? nodeA : undefined),
    };
    const disp = new FleetSessionRoutingDispatcher(
      () => registry,
      sessionsWith({ ses_1: 'node-A' }),
    );

    const result = await disp.dispatch(dispatchFor('ses_1'));

    expect(result.success).toBe(true);
    expect(nodeA.got).toHaveLength(1);
    expect(nodeA.got[0]!.sessionId).toBe('ses_1');
    expect((result.outputData as { url: string }).url).toContain('#A'); // came from node A
  });

  it('PER-SESSION routing — two sessions dispatch to their OWN nodes, never crossed', async () => {
    const nodeA = nodeConn('A');
    const nodeB = nodeConn('B');
    const registry: NodeConnectionRegistry = {
      get: (nodeId) => (nodeId === 'node-A' ? nodeA : nodeId === 'node-B' ? nodeB : undefined),
    };
    const disp = new FleetSessionRoutingDispatcher(
      () => registry,
      sessionsWith({ ses_A: 'node-A', ses_B: 'node-B' }),
    );

    const [rA, rB] = await Promise.all([
      disp.dispatch(dispatchFor('ses_A', 'int_A')),
      disp.dispatch(dispatchFor('ses_B', 'int_B')),
    ]);

    // Each node saw ONLY its own session.
    expect(nodeA.got.map((d) => d.sessionId)).toEqual(['ses_A']);
    expect(nodeB.got.map((d) => d.sessionId)).toEqual(['ses_B']);
    expect((rA.outputData as { url: string }).url).toContain('#A');
    expect((rB.outputData as { url: string }).url).toContain('#B');
  });

  it('no assigned node (node_id NULL) → dispatch_error (fast-fail, NOT the warming session_not_established), never dispatched', async () => {
    const nodeA = nodeConn('A');
    const registry: NodeConnectionRegistry = { get: () => nodeA };
    const disp = new FleetSessionRoutingDispatcher(() => registry, sessionsWith({ ses_1: null }));

    const result = await disp.dispatch(dispatchFor('ses_1'));

    expect(result.success).toBe(false);
    // NOT `intent_session_not_established`: that code is reserved for the box fork's
    // cold-starting WebDriver (correlator), which the executor patiently retries for
    // ~12s. A routing failure has no box to warm up — it must fail fast, so it uses
    // `intent_dispatch_error` (same session_error diagnosis, no patient retry).
    expect(result.errorCode).toBe('intent_dispatch_error');
    expect(nodeA.got).toHaveLength(0); // never reached any correlator
  });

  it('unknown session (row absent) → session_error failure', async () => {
    const registry: NodeConnectionRegistry = { get: () => nodeConn('A') };
    const disp = new FleetSessionRoutingDispatcher(() => registry, sessionsWith({}));

    const result = await disp.dispatch(dispatchFor('ses_missing'));

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('intent_dispatch_error');
  });

  it('fleet control plane not up (registry resolver returns undefined) → session_error', async () => {
    const disp = new FleetSessionRoutingDispatcher(
      () => undefined, // registry not constructed yet / flag off
      sessionsWith({ ses_1: 'node-A' }),
    );

    const result = await disp.dispatch(dispatchFor('ses_1'));

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('intent_dispatch_error');
  });

  it('owning node has no live connection (offline box) → session_error', async () => {
    const registry: NodeConnectionRegistry = { get: () => undefined }; // node not connected
    const disp = new FleetSessionRoutingDispatcher(
      () => registry,
      sessionsWith({ ses_1: 'node-A' }),
    );

    const result = await disp.dispatch(dispatchFor('ses_1'));

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('intent_dispatch_error');
  });

  it('sessions lookup THROWS → dispatch_error failure (retryable, side-effect-free), never rejects', async () => {
    const throwingSessions: SessionNodeLookup = {
      get: () => Promise.reject(new Error('db down')),
    };
    const registry: NodeConnectionRegistry = { get: () => nodeConn('A') };
    const disp = new FleetSessionRoutingDispatcher(() => registry, throwingSessions);

    const result = await disp.dispatch(dispatchFor('ses_1'));

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('intent_dispatch_error');
    expect(result.sessionId).toBe('ses_1'); // failure is attributed to the right session
  });

  it('reads the registry LAZILY per dispatch (boot-order: registry appears after construction)', async () => {
    const holder: { current?: NodeConnectionRegistry } = {};
    const nodeA = nodeConn('A');
    const disp = new FleetSessionRoutingDispatcher(
      () => holder.current,
      sessionsWith({ ses_1: 'node-A' }),
    );

    // Before the registry exists → honest failure.
    const before = await disp.dispatch(dispatchFor('ses_1', 'int_before'));
    expect(before.success).toBe(false);

    // Registry constructed later (mirrors bootstrap wiring the deps after the executor).
    holder.current = { get: (n) => (n === 'node-A' ? nodeA : undefined) };

    const after = await disp.dispatch(dispatchFor('ses_1', 'int_after'));
    expect(after.success).toBe(true);
    expect(nodeA.got.map((d) => d.intentId)).toEqual(['int_after']);
  });

  it('surfaces a warn log when the owning node is offline (best-effort, never throws)', async () => {
    const warn = vi.fn();
    const logger = {
      warn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
    };
    const registry: NodeConnectionRegistry = { get: () => undefined };
    const disp = new FleetSessionRoutingDispatcher(
      () => registry,
      sessionsWith({ ses_1: 'node-A' }),
      logger as unknown as ConstructorParameters<typeof FleetSessionRoutingDispatcher>[2],
    );

    const result = await disp.dispatch(dispatchFor('ses_1'));
    expect(result.success).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });
});
