// Increment-2 — fleet control-plane connection registry + inbound-frame router.
//
// The transport-agnostic CORE of the (next) /v1/fleet/events WS route. The route
// itself (accept the WS upgrade → verify the Bearer JWT via fleet-node-auth +
// the Redis nonce cache → read the node id from the X-Driftstack-Mac-Node-Id
// header) is the mechanical @fastify/websocket plumbing on top of this; this
// module owns the logic, so it's unit-testable now against a mock socket.
//
// Routing model (A3 bus W121, control-plane-owns): one connection per fleet
// NODE, keyed by nodeId (== JWT iss=sub). The harness sends NO register frame;
// the control plane routes IntentDispatch to a node via its own session→node
// assignment, looking up the node's connection here. Each connection owns an
// IntentDispatchCorrelator (its in-flight dispatches + timeouts).
//
// Wire envelope (A3 W122): inbound frames are the flat HarnessOutbound
// discriminated union `{type, …}`. We route the two we consume — `intentResult`
// → the correlator's onResultFrame; the errored `sessionStatus`
// (detail "intent_dispatch_no_session: …") → onSessionError (fast-fail) — and
// accept-but-ignore heartbeat / capabilityReport / errorEvent for now.

import {
  HarnessOutboundSchema,
  type SessionAssign,
  type SessionEnd,
  type ProfileSaved,
} from '../schemas/harness-control-protocol.js';
import { IntentDispatchCorrelator, type DispatchTransport } from './harness-dispatch-correlator.js';

/** What the WS route hands in: a function that writes a string frame to the
 *  node's socket (the route adapts the real `ws.send`). */
export type FleetNodeSocketSend = (data: string) => void;

/**
 * One authenticated fleet-node connection. Owns the node's dispatch correlator
 * (sending serialised IntentDispatch frames out over `send`, JSON-stringified)
 * and routes inbound HarnessOutbound frames to it.
 */
export class FleetControlConnection {
  readonly correlator: IntentDispatchCorrelator;
  private readonly send: FleetNodeSocketSend;
  private readonly onProfileSaved?: (frame: ProfileSaved) => void;

  constructor(
    readonly nodeId: string,
    send: FleetNodeSocketSend,
    onProfileSaved?: (frame: ProfileSaved) => void,
  ) {
    this.send = send;
    this.onProfileSaved = onProfileSaved;
    const transport: DispatchTransport = { send: (d) => send(JSON.stringify(d)) };
    this.correlator = new IntentDispatchCorrelator(transport);
  }

  /**
   * Push a serialized `sessionAssign` frame to this node (fleet-CP session
   * dispatch). Unlike IntentDispatch (correlated request→result via the
   * correlator), a sessionAssign is fire-and-forget on this channel: the harness
   * acts on it (spawn + capture + publish) and later reports progress via
   * `sessionStatus` frames up the same socket. JSON-stringified over the node's
   * socket — identical framing to the correlator's transport. Caller builds the
   * envelope with `serializeSessionAssign`.
   */
  sendSessionAssign(assign: SessionAssign): void {
    this.send(JSON.stringify(assign));
  }

  /**
   * Push a serialized `sessionEnd` frame to this node (fire-and-forget) so the
   * harness tears down the session + frees its concurrency slot on close. Same
   * framing as sendSessionAssign; caller builds the envelope with serializeSessionEnd.
   */
  sendSessionEnd(end: SessionEnd): void {
    this.send(JSON.stringify(end));
  }

  /**
   * Route one inbound raw WS message. Malformed JSON or an unknown `type` is
   * ignored (defensive — a junk frame must not crash the receive loop). The two
   * consumed variants drive the correlator; the rest are accepted + ignored.
   */
  handleInbound(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return; // not JSON → ignore
    }
    const parsed = HarnessOutboundSchema.safeParse(json);
    if (!parsed.success) return; // unknown/malformed HarnessOutbound → ignore
    const frame = parsed.data;
    switch (frame.type) {
      case 'intentResult':
        this.correlator.onResultFrame(frame);
        break;
      case 'sessionStatus':
        // Fast-fail the in-flight dispatch when the harness reports the session
        // isn't established (A3 W106). onSessionError itself filters on the
        // intent_dispatch_no_session detail prefix.
        if (frame.status === 'errored' && frame.detail !== undefined) {
          this.correlator.onSessionError(frame.sessionId, frame.detail);
        }
        break;
      case 'profileSaved':
        // Profile-backed session ended (A3 W417): persist the customer's saved
        // sealed store. Fire-and-forget off the receive loop (the handler does
        // the R2 write + error-logs internally); absent handler (no R2 / stateless
        // deploy) → ignored. MUST-DELIVER on the harness side, so a dropped frame
        // is a harness-queue concern, not a server-receive one.
        this.onProfileSaved?.(frame);
        break;
      // heartbeat / capabilityReport / errorEvent: accepted, not yet consumed.
    }
  }

  /** The socket closed/errored: fail every in-flight dispatch on this node. */
  close(reason: string): void {
    this.correlator.failAll(reason);
  }
}

/**
 * nodeId → FleetControlConnection. The route registers a connection on a
 * verified WS upgrade and unregisters on close. A reconnect by the same nodeId
 * replaces the prior connection (failing its in-flight dispatches first) so a
 * stale socket can't linger.
 */
export class FleetControlRegistry {
  private readonly connections = new Map<string, FleetControlConnection>();

  /**
   * @param onProfileSaved optional handler invoked when any node reports a
   *   `profileSaved` frame (profile-backed session ended). Threaded into every
   *   connection this registry creates. Omitted (no R2 configured) → the frame
   *   is accepted + ignored, identical to today's stateless behaviour.
   */
  constructor(private readonly onProfileSaved?: (frame: ProfileSaved) => void) {}

  register(nodeId: string, send: FleetNodeSocketSend): FleetControlConnection {
    const existing = this.connections.get(nodeId);
    if (existing !== undefined) {
      existing.close(`replaced by a new connection for node ${nodeId}`);
    }
    const conn = new FleetControlConnection(nodeId, send, this.onProfileSaved);
    this.connections.set(nodeId, conn);
    return conn;
  }

  get(nodeId: string): FleetControlConnection | undefined {
    return this.connections.get(nodeId);
  }

  /**
   * Remove + fail the node's connection (called on socket close/error).
   * Idempotent AND identity-checked: only removes the entry if `conn` is STILL
   * the mapped connection for `nodeId`. This defends the reconnect/replace race
   * — when a node reconnects, `register` swaps in conn2 (failing conn1) before
   * the OLD socket's lagging `close` event fires; that close calls
   * `unregister(nodeId, conn1, …)`, which must be a no-op so it doesn't tear
   * down the live conn2 and strand a connected-but-unroutable node. Pass the
   * connection returned by `register` (the route closes over it).
   */
  unregister(nodeId: string, conn: FleetControlConnection, reason: string): void {
    const current = this.connections.get(nodeId);
    // A newer connection already replaced this one (and register() already
    // closed it) — leave the live entry alone.
    if (current === undefined || current !== conn) return;
    this.connections.delete(nodeId);
    conn.close(reason);
  }

  /** Number of live node connections (test/inspection helper). */
  size(): number {
    return this.connections.size;
  }
}
