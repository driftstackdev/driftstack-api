// Increment-2 — unit tests for FleetControlConnection + FleetControlRegistry:
// the /v1/fleet/events route's connection-mgmt + inbound-frame-routing core.
// Pins: dispatch frames go out as JSON; the flat HarnessOutbound `{type,…}`
// frames route to the correlator (intentResult → resolve; errored sessionStatus
// → fast-fail); junk frames are ignored (no crash); reconnect replaces + fails
// the prior connection.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FleetControlConnection,
  FleetControlRegistry,
} from '../../src/services/fleet-control-registry.js';
import {
  encodeWireData,
  serializeSessionAssign,
  serializeSessionEnd,
  serializePauseSession,
  serializeResumeSession,
} from '../../src/services/harness-control-codec.js';
import type {
  IntentDispatch,
  Heartbeat,
  SessionStatus,
  CapabilityReport,
  HarnessErrorEvent,
} from '../../src/schemas/harness-control-protocol.js';

function dispatch(intentId: string, sessionId = 'ses_x'): IntentDispatch {
  return {
    type: 'intentDispatch',
    sessionId,
    intentId,
    intentName: 'navigate',
    inputParams: encodeWireData({ url: 'https://x' }),
  };
}

function intentResultFrame(intentId: string, sessionId = 'ses_x'): string {
  return JSON.stringify({
    type: 'intentResult',
    sessionId,
    intentId,
    success: true,
    durationMs: 5,
    outputData: encodeWireData({ url: 'https://x' }),
  });
}

describe('FleetControlConnection', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('serialises outbound dispatches to JSON via the socket send', async () => {
    const sent: string[] = [];
    const conn = new FleetControlConnection('node-1', (d) => sent.push(d));
    const p = conn.correlator.dispatch(dispatch('int_1'));
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toMatchObject({ type: 'intentDispatch', intentId: 'int_1' });
    // resolve so no timer lingers
    conn.handleInbound(intentResultFrame('int_1'));
    expect((await p).success).toBe(true);
  });

  it('sends a serialized sessionAssign frame to the node socket (fire-and-forget)', () => {
    const sent: string[] = [];
    const conn = new FleetControlConnection('node-1', (d) => sent.push(d));
    const assign = serializeSessionAssign({
      sessionId: 'ses_assign',
      archetype: 'iphone16pro_ios18_6_safari18_6',
      behaviorProfile: 'default',
      initialUrl: 'https://example.com',
      inlineProxyConfig: {
        host: '127.0.0.1',
        port: 1080,
        udp_associate: true,
        require_remote_dns: false,
      },
    });
    conn.sendSessionAssign(assign);
    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame).toMatchObject({
      type: 'sessionAssign',
      sessionId: 'ses_assign',
      archetype: 'iphone16pro_ios18_6_safari18_6',
    });
    // inlineProxyConfig rides as the base64 wire string (not the raw object)
    expect(typeof frame.inlineProxyConfig).toBe('string');
  });

  it('reserves readiness before sessionAssign send and accepts an immediate active reply on this socket', async () => {
    let acknowledge = () => {};
    const conn = new FleetControlConnection('node-1', () => acknowledge());
    acknowledge = () => {
      // Model a transport/test double that produces the acknowledgement before
      // sendSessionAssign returns. The waiter must already be installed.
      expect(conn.sessionReadinessCorrelator.inFlight()).toBe(1);
      conn.handleInbound(
        JSON.stringify({
          type: 'sessionStatus',
          sessionId: 'ses_assign',
          status: 'active',
          timestamp: 't',
        }),
      );
    };
    const readiness = conn.waitForSessionActive('ses_assign', 5_000);
    conn.sendSessionAssign(
      serializeSessionAssign({
        sessionId: 'ses_assign',
        archetype: 'iphone16pro_ios18_6_safari18_6',
        behaviorProfile: 'default',
        initialUrl: 'https://example.com',
      }),
    );
    expect(await readiness).toEqual({ status: 'active' });
    expect(conn.sessionReadinessCorrelator.inFlight()).toBe(0);
  });

  it('sends a serialized sessionEnd frame to the node socket (fire-and-forget teardown)', () => {
    const sent: string[] = [];
    const conn = new FleetControlConnection('node-1', (d) => sent.push(d));
    conn.sendSessionEnd(serializeSessionEnd('agt_end'));
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({ type: 'sessionEnd', sessionId: 'agt_end' });
  });

  it('sends serialized pauseSession + resumeSession frames to the node socket (W393)', () => {
    const sent: string[] = [];
    const conn = new FleetControlConnection('node-1', (d) => sent.push(d));
    conn.sendPauseSession(serializePauseSession('agt_p'));
    conn.sendResumeSession(serializeResumeSession({ sessionId: 'agt_r', challengeId: 'chl_1' }));
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[0]!)).toEqual({ type: 'pauseSession', sessionId: 'agt_p' });
    expect(JSON.parse(sent[1]!)).toEqual({
      type: 'resumeSession',
      sessionId: 'agt_r',
      challengeId: 'chl_1',
    });
  });

  it('routes an inbound intentResult frame → resolves the matching dispatch', async () => {
    const conn = new FleetControlConnection('node-1', () => {});
    const p = conn.correlator.dispatch(dispatch('int_1'));
    conn.handleInbound(intentResultFrame('int_1'));
    const r = await p;
    expect(r.success).toBe(true);
    expect(r.outputData).toEqual({ url: 'https://x' });
  });

  it('routes an errored sessionStatus (intent_dispatch_no_session) → fast-fails the in-flight dispatch', async () => {
    const conn = new FleetControlConnection('node-1', () => {});
    const p = conn.correlator.dispatch(dispatch('int_1', 'ses_x'));
    conn.handleInbound(
      JSON.stringify({
        type: 'sessionStatus',
        sessionId: 'ses_x',
        status: 'errored',
        timestamp: '2026-06-05T00:00:00Z',
        detail: 'intent_dispatch_no_session: navigate',
      }),
    );
    const r = await p;
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('intent_session_not_established');
  });

  it('ignores malformed JSON / unknown type / non-errored sessionStatus / heartbeat (no crash, dispatch stays pending)', async () => {
    const conn = new FleetControlConnection('node-1', () => {});
    const p = conn.correlator.dispatch(dispatch('int_1'));
    expect(() => conn.handleInbound('{not json')).not.toThrow();
    expect(() => conn.handleInbound(JSON.stringify({ type: 'teleport', foo: 1 }))).not.toThrow();
    expect(() => conn.handleInbound(JSON.stringify({ type: 'heartbeat', ts: 1 }))).not.toThrow();
    conn.handleInbound(
      JSON.stringify({
        type: 'sessionStatus',
        sessionId: 'ses_x',
        status: 'running',
        timestamp: 't',
      }),
    );
    expect(conn.correlator.inFlight()).toBe(1); // still pending — none of the above settled it
    conn.handleInbound(intentResultFrame('int_1')); // now resolve
    expect((await p).success).toBe(true);
  });

  it('routes profileSaved with the authenticated reporting node (inline + large shapes)', () => {
    const seen: unknown[][] = [];
    const conn = new FleetControlConnection(
      'node-1',
      () => {},
      (...args) => seen.push(args),
    );
    // inline (small) shape
    conn.handleInbound(
      JSON.stringify({
        type: 'profileSaved',
        sessionId: 'ses_x',
        profile_id: 'p1',
        sealed_blob: 'YmxvYg==',
      }),
    );
    // large (presigned-PUT ack) shape
    conn.handleInbound(
      JSON.stringify({ type: 'profileSaved', sessionId: 'ses_y', profile_id: 'p2', stored: true }),
    );
    expect(seen).toEqual([
      [
        { type: 'profileSaved', sessionId: 'ses_x', profile_id: 'p1', sealed_blob: 'YmxvYg==' },
        'node-1',
      ],
      [{ type: 'profileSaved', sessionId: 'ses_y', profile_id: 'p2', stored: true }, 'node-1'],
    ]);
  });

  it('routes a heartbeat → onHeartbeat ONLY when macNodeId matches the JWT nodeId (spoof/mismatch dropped)', () => {
    const seen: Heartbeat[] = [];
    const conn = new FleetControlConnection(
      'node-1',
      () => {},
      undefined, // onProfileSaved
      undefined, // onChallengeDetected
      undefined, // onPageState
      undefined, // onProfileSaveFailed
      (f) => seen.push(f), // onHeartbeat
    );
    const beat = (macNodeId: string): string =>
      JSON.stringify({
        type: 'heartbeat',
        macNodeId,
        timestamp: 't',
        cpuPercent: 10,
        memoryPercent: 20,
        activeSessionCount: 1,
        maxConcurrent: 8,
      });
    // matching id → consumed
    conn.handleInbound(beat('node-1'));
    // mismatched id (another node / spoof) → dropped, never touches node-1's liveness
    conn.handleInbound(beat('node-2'));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.macNodeId).toBe('node-1');
    expect(seen[0]!.maxConcurrent).toBe(8);
  });

  it('a heartbeat with no handler wired is accepted + ignored (no crash — stateless deploy)', () => {
    const conn = new FleetControlConnection('node-1', () => {});
    expect(() =>
      conn.handleInbound(
        JSON.stringify({
          type: 'heartbeat',
          macNodeId: 'node-1',
          timestamp: 't',
          cpuPercent: 1,
          memoryPercent: 1,
          activeSessionCount: 0,
        }),
      ),
    ).not.toThrow();
  });

  it('a profileSaved frame with no handler wired is accepted + ignored (no crash — stateless deploy)', () => {
    const conn = new FleetControlConnection('node-1', () => {});
    expect(() =>
      conn.handleInbound(
        JSON.stringify({ type: 'profileSaved', sessionId: 's', profile_id: 'p', stored: true }),
      ),
    ).not.toThrow();
  });

  it('routes an inbound challengeDetected frame → invokes the onChallengeDetected handler (W393)', () => {
    const seen: unknown[] = [];
    const conn = new FleetControlConnection(
      'node-1',
      () => {},
      undefined, // onProfileSaved
      (f) => seen.push(f),
    );
    conn.handleInbound(
      JSON.stringify({
        type: 'challengeDetected',
        sessionId: 'ses_x',
        challengeId: 'chl_1',
        challenge: { type: 'datadome', confidence: 0.9, detail: 'captcha' },
      }),
    );
    expect(seen).toEqual([
      {
        type: 'challengeDetected',
        sessionId: 'ses_x',
        challengeId: 'chl_1',
        challenge: { type: 'datadome', confidence: 0.9, detail: 'captcha' },
      },
    ]);
  });

  it('a challengeDetected frame with no handler wired is accepted + ignored (no crash)', () => {
    const conn = new FleetControlConnection('node-1', () => {});
    expect(() =>
      conn.handleInbound(
        JSON.stringify({
          type: 'challengeDetected',
          sessionId: 's',
          challengeId: 'c',
          challenge: { type: 'arkose', confidence: 0.5 },
        }),
      ),
    ).not.toThrow();
  });

  it('routes an inbound profileSaveFailed frame \u2192 invokes the onProfileSaveFailed handler (A3 W1364)', () => {
    const seen: unknown[] = [];
    const conn = new FleetControlConnection(
      'node-1',
      () => {},
      undefined, // onProfileSaved
      undefined, // onChallengeDetected
      undefined, // onPageState
      (f) => seen.push(f),
    );
    conn.handleInbound(
      JSON.stringify({
        type: 'profileSaveFailed',
        sessionId: 'agt_x',
        profile_id: 'prof_1',
        reason: 'upload_failed',
        detail: 'presigned PUT returned 503',
      }),
    );
    // detail optional \u2014 the minimal shape routes too.
    conn.handleInbound(
      JSON.stringify({
        type: 'profileSaveFailed',
        sessionId: 'agt_x',
        profile_id: 'prof_1',
        reason: 'too_large',
      }),
    );
    expect(seen).toHaveLength(2);
    expect((seen[0] as { reason: string }).reason).toBe('upload_failed');
    expect((seen[1] as { detail?: string }).detail).toBeUndefined();
    // degenerate_dump (A3 W2977/W2979) is now an accepted reason — it routes and
    // keeps its value (the data-loss guard skipped a save-back to preserve a prior).
    conn.handleInbound(
      JSON.stringify({
        type: 'profileSaveFailed',
        sessionId: 'agt_x',
        profile_id: 'prof_1',
        reason: 'degenerate_dump',
      }),
    );
    expect(seen).toHaveLength(3);
    expect((seen[2] as { reason: string }).reason).toBe('degenerate_dump');
    // A conditional write rejected because a newer profile save won is benign:
    // preserve `superseded` so the webhook cannot misreport it as upload failure.
    conn.handleInbound(
      JSON.stringify({
        type: 'profileSaveFailed',
        sessionId: 'agt_x',
        profile_id: 'prof_1',
        reason: 'superseded',
      }),
    );
    expect(seen).toHaveLength(4);
    expect((seen[3] as { reason: string }).reason).toBe('superseded');
    // An unknown FUTURE reason no longer DROPS the frame (forward-compat .catch):
    // it routes with the reason coerced to the generic 'upload_failed' bucket, so
    // the CP never silently loses a save-failure signal on an enum it predates.
    conn.handleInbound(
      JSON.stringify({
        type: 'profileSaveFailed',
        sessionId: 'agt_x',
        profile_id: 'prof_1',
        reason: 'gremlins',
      }),
    );
    expect(seen).toHaveLength(5);
    expect((seen[4] as { reason: string }).reason).toBe('upload_failed');
  });

  it('a profileSaveFailed frame with no handler wired is accepted + ignored (no crash \u2014 stateless deploy)', () => {
    const conn = new FleetControlConnection('node-1', () => {});
    expect(() =>
      conn.handleInbound(
        JSON.stringify({
          type: 'profileSaveFailed',
          sessionId: 'agt_x',
          profile_id: 'prof_1',
          reason: 'seal_failed',
        }),
      ),
    ).not.toThrow();
  });

  it('routes an inbound pageState frame → invokes the onPageState handler (W650/A3-W1254)', () => {
    const seen: unknown[] = [];
    const conn = new FleetControlConnection(
      'node-1',
      () => {},
      undefined, // onProfileSaved
      undefined, // onChallengeDetected
      (f) => seen.push(f),
    );
    conn.handleInbound(
      JSON.stringify({
        type: 'pageState',
        sessionId: 'agt_x',
        state: 'loaded',
        url: 'https://example.com',
        error: null,
      }),
    );
    conn.handleInbound(
      JSON.stringify({
        type: 'pageState',
        sessionId: 'agt_x',
        state: 'errored',
        url: null,
        error: { kind: 'timeout', http_status: null, message: 'nav timed out' },
      }),
    );
    expect(seen).toEqual([
      {
        type: 'pageState',
        sessionId: 'agt_x',
        state: 'loaded',
        url: 'https://example.com',
        error: null,
      },
      {
        type: 'pageState',
        sessionId: 'agt_x',
        state: 'errored',
        url: null,
        error: { kind: 'timeout', http_status: null, message: 'nav timed out' },
      },
    ]);
  });

  it('a pageState frame with no handler wired is accepted + ignored (no crash — stateless deploy)', () => {
    const conn = new FleetControlConnection('node-1', () => {});
    expect(() =>
      conn.handleInbound(
        JSON.stringify({
          type: 'pageState',
          sessionId: 'agt_x',
          state: 'loading',
          url: null,
          error: null,
        }),
      ),
    ).not.toThrow();
  });

  // audit M1 — every session-addressed one-way hook must receive
  // the CONNECTION's JWT-authenticated nodeId as the 2nd arg so the consumer can
  // drop a frame spoofed for another node's session. Verify the threading here
  // (the gate logic itself is unit-tested per-relay).
  it('M1 — threads nodeId to profileSaved / challenge / pageState / profileSaveFailed', () => {
    const profileSavedArgs: unknown[][] = [];
    const challengeArgs: unknown[][] = [];
    const pageStateArgs: unknown[][] = [];
    const profileFailArgs: unknown[][] = [];
    const conn = new FleetControlConnection(
      'node-77',
      () => {},
      (...a) => profileSavedArgs.push(a), // onProfileSaved
      (...a) => challengeArgs.push(a), // onChallengeDetected
      (...a) => pageStateArgs.push(a), // onPageState
      (...a) => profileFailArgs.push(a), // onProfileSaveFailed
    );
    conn.handleInbound(
      JSON.stringify({
        type: 'profileSaved',
        sessionId: 'agt_x',
        profile_id: 'p',
        stored: true,
      }),
    );
    conn.handleInbound(
      JSON.stringify({
        type: 'challengeDetected',
        sessionId: 's',
        challengeId: 'c',
        challenge: { type: 'datadome', confidence: 0.9 },
      }),
    );
    conn.handleInbound(
      JSON.stringify({
        type: 'pageState',
        sessionId: 'agt_x',
        state: 'loaded',
        url: 'u',
        error: null,
      }),
    );
    conn.handleInbound(
      JSON.stringify({
        type: 'profileSaveFailed',
        sessionId: 'agt_x',
        profile_id: 'p',
        reason: 'upload_failed',
      }),
    );
    expect(profileSavedArgs[0]?.[1]).toBe('node-77');
    expect(challengeArgs[0]?.[1]).toBe('node-77');
    expect(pageStateArgs[0]?.[1]).toBe('node-77');
    expect(profileFailArgs[0]?.[1]).toBe('node-77');
  });

  it('a throwing handler on a VALID frame does NOT escape handleInbound (receive-loop + process survive — defence-in-depth)', () => {
    // The route feeds handleInbound from a `socket.on('message')` listener, where
    // an uncaught synchronous throw surfaces as a process-level uncaughtException.
    // A handler blowing up on an otherwise-valid frame must be swallowed so one
    // frame can't take down the node's receive loop (let alone the process).
    const conn = new FleetControlConnection(
      'node-1',
      () => {},
      () => {
        throw new Error('handler blew up');
      },
    );
    expect(() =>
      conn.handleInbound(
        JSON.stringify({ type: 'profileSaved', sessionId: 's', profile_id: 'p', stored: true }),
      ),
    ).not.toThrow();
  });

  it('routes a TERMINAL sessionStatus (ended | errored) → invokes onSessionStatus (A3 W2682 worker-connected auto-close)', () => {
    const seen: SessionStatus[] = [];
    const conn = new FleetControlConnection(
      'node-1',
      () => {},
      undefined, // onProfileSaved
      undefined, // onChallengeDetected
      undefined, // onPageState
      undefined, // onProfileSaveFailed
      undefined, // onHeartbeat
      (f) => seen.push(f), // onSessionStatus
    );
    conn.handleInbound(
      JSON.stringify({
        type: 'sessionStatus',
        sessionId: 'agt_a',
        status: 'ended',
        timestamp: 't',
        reason: 'idle_timeout',
      }),
    );
    conn.handleInbound(
      JSON.stringify({
        type: 'sessionStatus',
        sessionId: 'agt_b',
        status: 'errored',
        timestamp: 't',
        reason: 'browser_crashed',
      }),
    );
    expect(seen).toEqual([
      {
        type: 'sessionStatus',
        sessionId: 'agt_a',
        status: 'ended',
        timestamp: 't',
        reason: 'idle_timeout',
      },
      {
        type: 'sessionStatus',
        sessionId: 'agt_b',
        status: 'errored',
        timestamp: 't',
        reason: 'browser_crashed',
      },
    ]);
  });

  it('does NOT invoke onSessionStatus for a NON-terminal status (active / idle / provisioning / paused)', () => {
    const seen: SessionStatus[] = [];
    const conn = new FleetControlConnection(
      'node-1',
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (f) => seen.push(f),
    );
    for (const status of ['active', 'idle', 'provisioning', 'paused', 'running']) {
      conn.handleInbound(
        JSON.stringify({ type: 'sessionStatus', sessionId: 'agt_x', status, timestamp: 't' }),
      );
    }
    expect(seen).toHaveLength(0);
  });

  it('an errored sessionStatus drives readiness, intent fast-fail, and the terminal consumer exactly once', async () => {
    const seen: SessionStatus[] = [];
    const conn = new FleetControlConnection(
      'node-1',
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (f) => seen.push(f),
    );
    const readiness = conn.waitForSessionActive('agt_a', 5_000);
    const p = conn.correlator.dispatch(dispatch('int_1', 'agt_a'));
    conn.handleInbound(
      JSON.stringify({
        type: 'sessionStatus',
        sessionId: 'agt_a',
        status: 'errored',
        timestamp: 't',
        detail: 'intent_dispatch_no_session: navigate',
        reason: 'browser_crashed',
      }),
    );
    // The errored fast-fail settled the dispatch…
    const r = await p;
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('intent_session_not_established');
    // …the strict readiness owner receives the bounded terminal outcome…
    expect(await readiness).toEqual({
      status: 'terminal',
      terminalStatus: 'errored',
      reason: 'browser_crashed',
    });
    // …AND the terminal-close consumer fired exactly once (row close remains independent).
    expect(seen).toEqual([
      {
        type: 'sessionStatus',
        sessionId: 'agt_a',
        status: 'errored',
        timestamp: 't',
        detail: 'intent_dispatch_no_session: navigate',
        reason: 'browser_crashed',
      },
    ]);
  });

  it('a terminal sessionStatus with no onSessionStatus handler wired is accepted + ignored (no crash — stateless deploy)', () => {
    const conn = new FleetControlConnection('node-1', () => {});
    expect(() =>
      conn.handleInbound(
        JSON.stringify({
          type: 'sessionStatus',
          sessionId: 'agt_a',
          status: 'ended',
          timestamp: 't',
          reason: 'idle_timeout',
        }),
      ),
    ).not.toThrow();
  });

  it('close() fails every in-flight dispatch and readiness owner without leaving timers', async () => {
    const conn = new FleetControlConnection('node-1', () => {});
    const readiness = conn.waitForSessionActive('agt_ready', 5_000);
    const p = conn.correlator.dispatch(dispatch('int_1'));
    conn.close('socket closed');
    const r = await p;
    expect(r.success).toBe(false);
    expect(r.errorMessage).toBe('socket closed');
    expect(await readiness).toEqual({ status: 'connection_closed' });
    expect(conn.sessionReadinessCorrelator.inFlight()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('close() marks the connection stale — handleInbound no-ops any frame delivered afterward (reconnect-race guard)', () => {
    const seen: unknown[] = [];
    const conn = new FleetControlConnection(
      'node-1',
      () => {},
      (f) => seen.push(f), // onProfileSaved
    );
    conn.close('socket closed');
    expect(() =>
      conn.handleInbound(
        JSON.stringify({ type: 'profileSaved', sessionId: 's', profile_id: 'p', stored: true }),
      ),
    ).not.toThrow();
    // The frame would normally route straight to onProfileSaved — it must NOT
    // once this connection object has been closed (superseded or torn down).
    expect(seen).toHaveLength(0);
  });
});

describe('FleetControlRegistry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('register / get / unregister by nodeId', () => {
    const reg = new FleetControlRegistry();
    const conn = reg.register('node-1', () => {});
    expect(reg.get('node-1')).toBe(conn);
    expect(reg.size()).toBe(1);
    reg.unregister('node-1', conn, 'closed');
    expect(reg.get('node-1')).toBeUndefined();
    expect(reg.size()).toBe(0);
  });

  it('reconnect by the same nodeId replaces the prior connection + fails its in-flight dispatches', async () => {
    const reg = new FleetControlRegistry();
    const first = reg.register('node-1', () => {});
    const p = first.correlator.dispatch(dispatch('int_1'));
    const second = reg.register('node-1', () => {}); // reconnect
    expect(reg.size()).toBe(1);
    expect(reg.get('node-1')).toBe(second);
    const r = await p; // the prior connection's dispatch was failed by the replace
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/replaced by a new connection/);
  });

  it('same-node reconnect is a hard readiness boundary in both directions', async () => {
    const reg = new FleetControlRegistry();
    const first = reg.register('node-1', () => {});
    const predecessor = first.waitForSessionActive('agt_same', 5_000);

    const second = reg.register('node-1', () => {});
    expect(await predecessor).toEqual({ status: 'connection_closed' });
    expect(first.sessionReadinessCorrelator.inFlight()).toBe(0);

    const successor = second.waitForSessionActive('agt_same', 5_000);
    // A lagging frame on the superseded physical socket cannot settle the new
    // connection's owner, even with the same node id and session id.
    first.handleInbound(
      JSON.stringify({
        type: 'sessionStatus',
        sessionId: 'agt_same',
        status: 'active',
        timestamp: 'old',
      }),
    );
    expect(second.sessionReadinessCorrelator.inFlight()).toBe(1);

    second.handleInbound(
      JSON.stringify({
        type: 'sessionStatus',
        sessionId: 'agt_same',
        status: 'active',
        timestamp: 'new',
      }),
    );
    expect(await successor).toEqual({ status: 'active' });
    expect(second.sessionReadinessCorrelator.inFlight()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reconnect SUPERSEDES the prior connection — actively CLOSES its old socket (P0 2026-07-11 zombie-conn fix)', () => {
    const reg = new FleetControlRegistry();
    let firstClosed = 0;
    // First connection with a socket-terminate cb (as the WS route threads).
    reg.register(
      'node-1',
      () => {},
      () => {
        firstClosed += 1;
      },
    );
    expect(firstClosed).toBe(0);
    // Reconnect for the SAME node → supersede must actively close the OLD socket exactly
    // once, so a half-open box socket can't linger + zombie-heartbeat into the stale-guard.
    const second = reg.register(
      'node-1',
      () => {},
      () => {},
    );
    expect(firstClosed).toBe(1);
    expect(reg.get('node-1')).toBe(second);
    // A later unregister of the LIVE conn does NOT re-close the old socket (identity guard).
    reg.unregister('node-1', second, 'closed');
    expect(firstClosed).toBe(1);
  });

  it('queues a teardown when a node is offline + re-dispatches sessionEnd on reconnect (A3 W2859)', () => {
    const reg = new FleetControlRegistry();
    // No connection for node-1 yet → a session close couldn't reach the box; queue it.
    reg.recordPendingTeardown('node-1', 'ses_orphan');
    expect(reg.pendingTeardownCount('node-1')).toBe(1);
    // The node (re)connects → register() drains the queue + sends the sessionEnd.
    const sent: string[] = [];
    reg.register('node-1', (d) => sent.push(d));
    expect(reg.pendingTeardownCount('node-1')).toBe(0);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toMatchObject({ type: 'sessionEnd', sessionId: 'ses_orphan' });
  });

  it('retains a failed reconnect teardown while continuing later ids, then drains it on a later reconnect', () => {
    const reg = new FleetControlRegistry();
    reg.recordPendingTeardown('node-1', 'ses_retry');
    reg.recordPendingTeardown('node-1', 'ses_later');

    const firstReconnectSent: string[] = [];
    expect(() =>
      reg.register('node-1', (data) => {
        const frame = JSON.parse(data) as { sessionId: string };
        if (frame.sessionId === 'ses_retry') throw new Error('socket still unavailable');
        firstReconnectSent.push(frame.sessionId);
      }),
    ).not.toThrow();
    expect(firstReconnectSent).toEqual(['ses_later']);
    expect(reg.pendingTeardownCount('node-1')).toBe(1);

    const secondReconnectSent: string[] = [];
    reg.register('node-1', (data) => {
      secondReconnectSent.push((JSON.parse(data) as { sessionId: string }).sessionId);
    });
    expect(secondReconnectSent).toEqual(['ses_retry']);
    expect(reg.pendingTeardownCount('node-1')).toBe(0);
  });

  it('bounds the pending-teardown queue per node (drops oldest at the 256 cap)', () => {
    const reg = new FleetControlRegistry();
    for (let i = 0; i < 300; i += 1) reg.recordPendingTeardown('node-1', `ses_${i}`);
    expect(reg.pendingTeardownCount('node-1')).toBe(256);
  });

  it('threads the onProfileSaved handler into the connections it creates', () => {
    const seen: unknown[] = [];
    const reg = new FleetControlRegistry((f) => seen.push(f));
    const conn = reg.register('node-1', () => {});
    conn.handleInbound(
      JSON.stringify({ type: 'profileSaved', sessionId: 's', profile_id: 'p', stored: true }),
    );
    expect(seen).toEqual([{ type: 'profileSaved', sessionId: 's', profile_id: 'p', stored: true }]);
  });

  it('threads the onChallengeDetected handler into the connections it creates (W393)', () => {
    const seen: unknown[] = [];
    const reg = new FleetControlRegistry(undefined, (f) => seen.push(f));
    const conn = reg.register('node-1', () => {});
    conn.handleInbound(
      JSON.stringify({
        type: 'challengeDetected',
        sessionId: 's',
        challengeId: 'c',
        challenge: { type: 'datadome', confidence: 0.8 },
      }),
    );
    expect(seen).toEqual([
      {
        type: 'challengeDetected',
        sessionId: 's',
        challengeId: 'c',
        challenge: { type: 'datadome', confidence: 0.8 },
      },
    ]);
  });

  it('threads the onSessionStatus handler (positional arg 8) into the connections it creates — fires on a terminal frame only (A3 W2682)', () => {
    const seen: SessionStatus[] = [];
    const reg = new FleetControlRegistry(
      undefined, // onProfileSaved
      undefined, // onChallengeDetected
      undefined, // onPageState
      undefined, // onProfileSaveFailed
      undefined, // onHeartbeat
      undefined, // onNodeRegistered
      undefined, // onNodeDisconnected
      (f) => seen.push(f), // onSessionStatus
    );
    const conn = reg.register('node-1', () => {});
    // terminal → fires
    conn.handleInbound(
      JSON.stringify({
        type: 'sessionStatus',
        sessionId: 'agt_a',
        status: 'ended',
        timestamp: 't',
        reason: 'customer_closed',
      }),
    );
    // non-terminal → does NOT fire
    conn.handleInbound(
      JSON.stringify({
        type: 'sessionStatus',
        sessionId: 'agt_a',
        status: 'active',
        timestamp: 't',
      }),
    );
    expect(seen).toEqual([
      {
        type: 'sessionStatus',
        sessionId: 'agt_a',
        status: 'ended',
        timestamp: 't',
        reason: 'customer_closed',
      },
    ]);
  });

  it('routes a validated capabilityReport with the authenticated reporting node id', () => {
    const seen: Array<{ frame: CapabilityReport; nodeId: string }> = [];
    const reg = new FleetControlRegistry(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (frame, nodeId) => seen.push({ frame, nodeId }),
    );
    const conn = reg.register('node-1', () => {});
    conn.handleInbound(
      JSON.stringify({
        type: 'capabilityReport',
        sessionId: 'agt_1',
        timestamp: '2026-07-13T06:00:00.000Z',
        egressPhase: 'phase_1_socks5',
        proxyKind: 'socks5',
        proxyUdpSupported: true,
        proxyIpv4Supported: true,
        proxyIpv6Supported: false,
        transportModeRequested: 'h2-and-h3',
        transportModeActive: 'h2-and-h3',
        h3InterposeLoaded: true,
        httpsSkipActive: true,
        safeguardChecks: [{ layer: 'dns', passed: true, timestamp: 't' }],
        archetypeId: 'iphone16pro_ios18_6_safari18_6',
        manualInputAvailable: false,
        streamingState: 'blank',
        egressState: 'dead_proxy',
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      nodeId: 'node-1',
      frame: {
        sessionId: 'agt_1',
        manualInputAvailable: false,
        streamingState: 'blank',
        egressState: 'dead_proxy',
      },
    });
  });

  it('routes a bounded errorEvent with the authenticated reporting node id', () => {
    const seen: Array<{ frame: HarnessErrorEvent; nodeId: string }> = [];
    const reg = new FleetControlRegistry(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (frame, nodeId) => seen.push({ frame, nodeId }),
    );
    reg
      .register('node-1', () => {})
      .handleInbound(
        JSON.stringify({
          type: 'errorEvent',
          sessionId: 'agt_1',
          timestamp: '2026-07-13T06:00:00.000Z',
          code: 'launch_timeout',
          severity: 'error',
          summary: 'Launch timed out.',
          customerActionable: false,
          retryable: true,
        }),
      );
    expect(seen).toEqual([
      {
        nodeId: 'node-1',
        frame: expect.objectContaining({ sessionId: 'agt_1', code: 'launch_timeout' }),
      },
    ]);
  });

  it('unregister is idempotent (double-close is a no-op)', () => {
    const reg = new FleetControlRegistry();
    const conn = reg.register('node-1', () => {});
    reg.unregister('node-1', conn, 'closed');
    expect(() => reg.unregister('node-1', conn, 'closed again')).not.toThrow();
    expect(reg.size()).toBe(0);
  });

  it('worker-disconnect hooks: register fires onNodeRegistered; unregister of the LIVE conn fires onNodeDisconnected (migration 0086)', () => {
    const registered: string[] = [];
    const disconnected: string[] = [];
    const reg = new FleetControlRegistry(
      undefined, // onProfileSaved
      undefined, // onChallengeDetected
      undefined, // onPageState
      undefined, // onProfileSaveFailed
      undefined, // onHeartbeat
      (nodeId) => registered.push(nodeId),
      (nodeId) => disconnected.push(nodeId),
    );
    const conn = reg.register('node-1', () => {});
    expect(registered).toEqual(['node-1']);
    expect(disconnected).toEqual([]);
    reg.unregister('node-1', conn, 'closed');
    expect(disconnected).toEqual(['node-1']);
  });

  it('worker-disconnect hooks: a lagging OLD-socket close after a reconnect does NOT fire onNodeDisconnected (identity-checked — the live conn already re-armed register)', () => {
    const registered: string[] = [];
    const disconnected: string[] = [];
    const reg = new FleetControlRegistry(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (nodeId) => registered.push(nodeId),
      (nodeId) => disconnected.push(nodeId),
    );
    const first = reg.register('node-1', () => {});
    const second = reg.register('node-1', () => {}); // reconnect → fires register again
    // The OLD socket's lagging close unregisters with the OLD conn — must be a
    // no-op (identity check), so NO onNodeDisconnected fires for the live node.
    reg.unregister('node-1', first, 'old socket closed');
    expect(registered).toEqual(['node-1', 'node-1']); // each (re)connect fired register
    expect(disconnected).toEqual([]); // the live conn was never torn down
    // Cleanly unregister the live conn → NOW it fires disconnect.
    reg.unregister('node-1', second, 'closed');
    expect(disconnected).toEqual(['node-1']);
  });

  it('worker-disconnect hooks: a throwing hook does NOT break register/unregister (best-effort)', () => {
    const reg = new FleetControlRegistry(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        throw new Error('register hook blew up');
      },
      () => {
        throw new Error('disconnect hook blew up');
      },
    );
    let conn!: FleetControlConnection;
    expect(() => {
      conn = reg.register('node-1', () => {});
    }).not.toThrow();
    expect(reg.get('node-1')).toBe(conn);
    expect(() => reg.unregister('node-1', conn, 'closed')).not.toThrow();
    expect(reg.size()).toBe(0);
  });

  it('identity-checked unregister: the OLD connection closing AFTER a reconnect does NOT tear down the live new connection (reconnect/replace race)', async () => {
    const reg = new FleetControlRegistry();
    const first = reg.register('node-1', () => {});
    const p = first.correlator.dispatch(dispatch('int_1')); // first has an in-flight
    const second = reg.register('node-1', () => {}); // reconnect → replaces first
    // The OLD socket's lagging close fires now and unregisters with the OLD conn.
    reg.unregister('node-1', first, 'old fleet node socket closed');
    // The live (new) connection must still be registered + routable.
    expect(reg.get('node-1')).toBe(second);
    expect(reg.size()).toBe(1);
    // (the replace already failed first's in-flight dispatch — drain it)
    const r = await p;
    expect(r.success).toBe(false);
    // And unregistering the CURRENT connection still works.
    reg.unregister('node-1', second, 'closed');
    expect(reg.get('node-1')).toBeUndefined();
    expect(reg.size()).toBe(0);
  });

  it('reconnect race: a frame delivered on the STALE (superseded) connection is a no-op, not processed as if it came from the current connection', () => {
    // CONFIRMED audit finding: two independent TCP connections give no
    // cross-connection ordering guarantee, so a harness crash+fast-respawn can
    // land one more frame on the OLD physical socket AFTER register() has
    // already installed a NEW FleetControlConnection for the same nodeId. The
    // WS route binds `socket.on('message', …)` to the specific connection
    // object captured at upgrade time, so without an "am I still current"
    // check, handleInbound would process it as if it came from the CURRENT
    // connection — e.g. a stale heartbeat, or (concretely) a stale terminal
    // sessionStatus mass-closing sessions that are actually healthy under the
    // new connection. Assert BOTH consumer callbacks are no-ops on the first
    // (now-superseded) connection.
    const heartbeats: Heartbeat[] = [];
    const statuses: SessionStatus[] = [];
    const reg = new FleetControlRegistry(
      undefined, // onProfileSaved
      undefined, // onChallengeDetected
      undefined, // onPageState
      undefined, // onProfileSaveFailed
      (f) => heartbeats.push(f), // onHeartbeat
      undefined, // onNodeRegistered
      undefined, // onNodeDisconnected
      (f) => statuses.push(f), // onSessionStatus
    );
    const first = reg.register('node-1', () => {});
    // Simulated harness crash+fast-respawn: a second physical connection opens
    // for the SAME nodeId — register() replaces + closes `first`.
    const second = reg.register('node-1', () => {});
    expect(reg.get('node-1')).toBe(second);
    // The OLD (now-superseded) connection object receives one more frame — the
    // reconnect race. Call handleInbound DIRECTLY on `first`, exactly as the WS
    // route would if the dying socket's lagging message event fired.
    first.handleInbound(
      JSON.stringify({
        type: 'heartbeat',
        macNodeId: 'node-1',
        timestamp: 't',
        cpuPercent: 1,
        memoryPercent: 1,
        activeSessionCount: 0,
      }),
    );
    first.handleInbound(
      JSON.stringify({
        type: 'sessionStatus',
        sessionId: 'agt_a',
        status: 'ended',
        timestamp: 't',
        reason: 'worker-restarted',
      }),
    );
    expect(heartbeats).toHaveLength(0);
    expect(statuses).toHaveLength(0);
    // The CURRENT connection is unaffected and still routes normally.
    second.handleInbound(
      JSON.stringify({
        type: 'heartbeat',
        macNodeId: 'node-1',
        timestamp: 't',
        cpuPercent: 2,
        memoryPercent: 2,
        activeSessionCount: 1,
      }),
    );
    expect(heartbeats).toHaveLength(1);
  });
});
