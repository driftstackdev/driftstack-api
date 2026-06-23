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
  TERMINAL_SESSION_STATUSES,
  type SessionAssign,
  type SessionEnd,
  type PauseSession,
  type ResumeSession,
  type ControlCommand,
  type ProfileSaved,
  type ProfileSaveFailed,
  type ChallengeDetected,
  type PageStateFrame,
  type Heartbeat,
  type SessionStatus,
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
  private readonly onChallengeDetected?: (frame: ChallengeDetected) => void;
  private readonly onPageState?: (frame: PageStateFrame) => void;
  private readonly onProfileSaveFailed?: (frame: ProfileSaveFailed) => void;
  private readonly onHeartbeat?: (frame: Heartbeat) => void;
  private readonly onSessionStatus?: (frame: SessionStatus, reportingNodeId: string) => void;

  constructor(
    readonly nodeId: string,
    send: FleetNodeSocketSend,
    onProfileSaved?: (frame: ProfileSaved) => void,
    onChallengeDetected?: (frame: ChallengeDetected) => void,
    onPageState?: (frame: PageStateFrame) => void,
    onProfileSaveFailed?: (frame: ProfileSaveFailed) => void,
    onHeartbeat?: (frame: Heartbeat) => void,
    onSessionStatus?: (frame: SessionStatus, reportingNodeId: string) => void,
  ) {
    this.send = send;
    this.onProfileSaved = onProfileSaved;
    this.onChallengeDetected = onChallengeDetected;
    this.onPageState = onPageState;
    this.onProfileSaveFailed = onProfileSaveFailed;
    this.onHeartbeat = onHeartbeat;
    this.onSessionStatus = onSessionStatus;
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
   * W393 challenge-handling — push a `pauseSession` / `resumeSession` frame to
   * this node (fire-and-forget, same framing as sendSessionEnd). The harness
   * pauses/resumes action-intent execution; build the envelope with
   * serializePauseSession / serializeResumeSession.
   */
  sendPauseSession(pause: PauseSession): void {
    this.send(JSON.stringify(pause));
  }

  sendResumeSession(resume: ResumeSession): void {
    this.send(JSON.stringify(resume));
  }

  /**
   * Fleet-admin (§A5) — push a node-level `controlCommand` (cordon / uncordon /
   * drain / restart) to THIS node (fire-and-forget, same framing as the others).
   * The connection IS the node, so the command needs no node id. Build the
   * envelope with serializeControlCommand; the harness routes it to
   * beginDrain/cordon/restart (A2-A3-BUS W2203; harness receiver per W2197).
   */
  sendControlCommand(command: ControlCommand): void {
    this.send(JSON.stringify(command));
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
    // Enforce the documented contract (above) at the DISPATCH layer too, not just
    // the parse layer: a handler throwing on an otherwise-valid frame must NOT
    // escape into the route's `socket.on('message')` listener — an uncaught throw
    // there surfaces as an uncaughtException (process-level), so one frame could
    // take down far more than this node's receive loop. The handlers are each
    // individually guarded today; this is defence-in-depth so a future handler
    // change can't silently regress the "a junk frame must not crash the receive
    // loop" guarantee. Silent-swallow matches the parse guards' style above.
    try {
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
          // Worker-CONNECTED orphan auto-close (A3 W2682): a TERMINAL frame
          // (status ∈ {ended, errored}) means the worker tore the session down —
          // close the matching agent_sessions row so the slot frees in seconds
          // instead of lingering until the worker-disconnect reaper / 12h
          // backstop. Independent of (and additive to) the errored fast-fail
          // above: an `errored` frame can both fast-fail an in-flight dispatch
          // AND close its row. Absent consumer (stateless deploy) → ignored.
          if (TERMINAL_SESSION_STATUSES.has(frame.status)) {
            // #5 — pass the connection's authenticated nodeId so the consumer can
            // verify the session belongs to THIS node before closing it (a rogue node
            // must not be able to close/error another node's session).
            this.onSessionStatus?.(frame, this.nodeId);
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
        case 'challengeDetected':
          // Challenge-handling (W393): the harness ChallengeDetector flagged a
          // bot-check + auto-paused the session. Relay to the customer via the
          // injected consumer (→ session.challenge_detected SSE + webhook). Absent
          // consumer (not yet wired / stateless deploy) → ignored, like profileSaved.
          this.onChallengeDetected?.(frame);
          break;
        case 'pageState':
          // Page lifecycle on an agent-initiated navigate (A3 W1240/W1254):
          // loading → loaded | errored, keyed by the AGENT session id. The
          // consumer stores the latest per session so GET /v1/agent-sessions/
          // :id/page-state serves the GUI loading-bar/error-overlay. Absent
          // consumer (stateless deploy) → ignored, like the others.
          this.onPageState?.(frame);
          break;
        case 'profileSaveFailed':
          // Profile save-back failed at session teardown (A3 W1364): relay to
          // the customer as session.profile_save_failed so persisted-state
          // reliance is informed (terminal — no retry path; session itself
          // stays SUCCEEDED). Absent consumer (stateless deploy) → ignored,
          // like the others.
          this.onProfileSaveFailed?.(frame);
          break;
        case 'heartbeat':
          // Liveness + fleet telemetry (file-48 §A5, fleet-admin-panel-design
          // Phase 0). SECURITY: cross-check the frame's self-reported macNodeId
          // against this connection's JWT-authenticated nodeId — a mismatch (bug
          // or spoof) must NOT touch another node's liveness/telemetry, so drop
          // it. On match, hand the validated frame to the consumer (wired in
          // bootstrap → repo.touchLastSeen + telemetry upsert). Absent consumer
          // (stateless deploy) → accepted + ignored, like the frames above.
          if (frame.macNodeId === this.nodeId) {
            this.onHeartbeat?.(frame);
          }
          break;
        // capabilityReport / errorEvent: accepted, not yet consumed.
        //
        // FORWARD-GUARD (A3 bus W1859): an `errorEvent` (summary/detail) and an
        // errored `sessionStatus.detail` can carry the Mac fleet NODE's real IP on
        // an egress-leak diagnostic — detail like "proxied=<customer-proxy-exit>
        // direct=<node-ip>", where `direct=` is the node's own IP (the value the
        // proxy exists to hide; surfacing it to a customer is infra deanonymisation).
        // These are node-local OPS diagnostics ONLY. Today no node IP reaches a
        // customer: errorEvent is ignored here, and the consumed errored
        // `sessionStatus` is prefix-filtered to `intent_dispatch_no_session` in
        // onSessionError (so the egress-leak detail never matches). If a future
        // consumer is wired here (or in onSessionError) that relays any of these to
        // a CUSTOMER surface (webhook / SDK error / dashboard), it MUST scrub the
        // `direct=` node IP from the detail/summary first. Do not widen this without
        // that scrub. (A3 already scrubs the customer-facing ErrorEvent.summary
        // harness-side; this guard keeps the CP-side relay boundary honest too.)
      }
    } catch {
      // A handler threw on a valid frame — swallow so the node's receive loop (and
      // the process) survives. Handlers are independently tested; this is the
      // last-resort backstop for the documented no-crash guarantee.
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
   * @param onChallengeDetected optional handler invoked when any node reports a
   *   `challengeDetected` frame (W393 — harness flagged a bot-check). Threaded
   *   into every connection. Omitted → accepted + ignored (stateless). Wired in
   *   bootstrap to relay → the customer-facing `session.challenge_detected`
   *   webhook (see makeChallengeRelay).
   */
  constructor(
    private readonly onProfileSaved?: (frame: ProfileSaved) => void,
    private readonly onChallengeDetected?: (frame: ChallengeDetected) => void,
    private readonly onPageState?: (frame: PageStateFrame) => void,
    private readonly onProfileSaveFailed?: (frame: ProfileSaveFailed) => void,
    private readonly onHeartbeat?: (frame: Heartbeat) => void,
    /**
     * Worker-disconnect fix (2026-06-19) — liveness hooks for the
     * WorkerDisconnectReaper. `onNodeRegistered` fires whenever a node
     * (re)connects (CANCELS any pending grace timer for it); `onNodeDisconnected`
     * fires when the node's connection is unregistered (ARMS the grace timer).
     * Both omitted (no reaper wired / stateless deploy) → no-op, identical to
     * today's behaviour. Best-effort: a throwing hook must not break
     * register/unregister, so each call is guarded.
     */
    private readonly onNodeRegistered?: (nodeId: string) => void,
    private readonly onNodeDisconnected?: (nodeId: string) => void,
    /**
     * Worker-CONNECTED orphan auto-close (A3 W2682) — invoked when any node
     * reports a TERMINAL `sessionStatus` frame (status ∈ {ended, errored}).
     * Threaded into every connection this registry creates; the connection only
     * calls it for terminal frames. Omitted (no consumer wired / stateless
     * deploy) → the terminal frame is accepted + ignored, identical to today's
     * behaviour. Wired in bootstrap to close the matching agent_sessions row
     * (see closeAgentSessionOnTerminalStatus).
     */
    private readonly onSessionStatus?: (frame: SessionStatus, reportingNodeId: string) => void,
  ) {}

  register(nodeId: string, send: FleetNodeSocketSend): FleetControlConnection {
    const existing = this.connections.get(nodeId);
    if (existing !== undefined) {
      existing.close(`replaced by a new connection for node ${nodeId}`);
    }
    const conn = new FleetControlConnection(
      nodeId,
      send,
      this.onProfileSaved,
      this.onChallengeDetected,
      this.onPageState,
      this.onProfileSaveFailed,
      this.onHeartbeat,
      this.onSessionStatus,
    );
    this.connections.set(nodeId, conn);
    // Worker-disconnect fix — a (re)connect CANCELS any pending grace timer for
    // this node, so a transient WS blip never false-closes a live session.
    // Best-effort: a throwing hook must not break the connection registration.
    try {
      this.onNodeRegistered?.(nodeId);
    } catch {
      /* swallow — registration must not fail on a reaper-hook error */
    }
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
    // closed it) — leave the live entry alone. Returning here ALSO means a
    // lagging old-socket close after a reconnect does NOT arm the grace timer
    // (the live conn already fired onNodeRegistered, which cancels it anyway).
    if (current === undefined || current !== conn) return;
    this.connections.delete(nodeId);
    conn.close(reason);
    // Worker-disconnect fix — the node's live connection just dropped: ARM the
    // grace timer. If it reconnects within the window, register() cancels it.
    // Best-effort: a throwing hook must not break the unregister teardown.
    try {
      this.onNodeDisconnected?.(nodeId);
    } catch {
      /* swallow — teardown must not fail on a reaper-hook error */
    }
  }

  /** Number of live node connections (test/inspection helper). */
  size(): number {
    return this.connections.size;
  }
}
