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
// heartbeat/capabilityReport/errorEvent → their ownership-aware consumers.

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
  type CapabilityReport,
  type HarnessErrorEvent,
} from '../schemas/harness-control-protocol.js';
import { IntentDispatchCorrelator, type DispatchTransport } from './harness-dispatch-correlator.js';
import {
  CookiesRequestCorrelator,
  type CookiesTransport,
  type CookiesOutcome,
} from './cookies-request-correlator.js';
import {
  SetCookiesRequestCorrelator,
  type SetCookiesTransport,
  type SetCookiesOutcome,
} from './set-cookies-request-correlator.js';
import {
  NavigateHistoryRequestCorrelator,
  type NavigateHistoryTransport,
  type NavigateHistoryOutcome,
} from './navigate-history-request-correlator.js';
import {
  UploadRequestCorrelator,
  type UploadTransport,
  type UploadOutcome,
} from './upload-request-correlator.js';
import {
  DownloadRequestCorrelator,
  DOWNLOAD_LIST_REQUEST_TIMEOUT_MS,
  type DownloadTransport,
  type DownloadOutcome,
} from './download-request-correlator.js';
import {
  TrimProfileRequestCorrelator,
  type TrimProfileTransport,
  type TrimProfileOutcome,
} from './trim-profile-request-correlator.js';
import {
  serializeCookiesRequest,
  serializeSetCookies,
  serializeNavigateHistory,
  serializeUploadFile,
  serializeListDownloads,
  serializeFetchDownload,
  serializeTrimProfile,
  serializeSessionEnd,
} from './harness-control-codec.js';
import type { Cookie } from '../schemas/harness-control-protocol.js';
import type { Logger } from '../lib/logger.js';
import {
  FLEET_INBOUND_LARGE_FRAME_THRESHOLD_BYTES,
  FleetInboundFrameBudget,
  readLargeDownloadResultHeader,
} from './fleet-inbound-frame-gate.js';

/** What the WS route hands in: a function that writes a string frame to the
 *  node's socket (the route adapts the real `ws.send`). */
export type FleetNodeSocketSend = (data: string) => void;

export type FleetInboundAdmission =
  'accepted' | 'uncorrelated-large-frame' | 'parse-budget-exhausted';

/**
 * One authenticated fleet-node connection. Owns the node's dispatch correlator
 * (sending serialised IntentDispatch frames out over `send`, JSON-stringified)
 * and routes inbound HarnessOutbound frames to it.
 */
export class FleetControlConnection {
  readonly correlator: IntentDispatchCorrelator;
  /** Founder #48 — correlates GET /:id/cookies pulls (cookiesRequest → cookiesResult)
   *  over this node's socket, keyed by requestId. Owned here like `correlator`. */
  readonly cookiesCorrelator: CookiesRequestCorrelator;
  /** Cookie-import — correlates POST /:id/cookies/set writes (setCookies →
   *  setCookiesResult) over this node's socket, keyed by requestId. The write-twin
   *  of cookiesCorrelator; owned here like above. */
  readonly setCookiesCorrelator: SetCookiesRequestCorrelator;
  /** Sim back/forward (A3 W2870) — correlates POST /:id/history steps (navigateHistory
   *  → navigateHistoryResult) over this node's socket, keyed by requestId. The sibling
   *  of setCookiesCorrelator; owned here like above. */
  readonly navigateHistoryCorrelator: NavigateHistoryRequestCorrelator;
  /** File-control (A3 W2851) — correlates POST /:id/files uploads (uploadFile →
   *  uploadResult) over this node's socket, keyed by requestId. Owned like above. */
  readonly uploadCorrelator: UploadRequestCorrelator;
  /** File-control (A3 W2856) — correlates GET /:id/downloads list + fetch
   *  (listDownloads→downloadsList, fetchDownload→downloadData) over this node's
   *  socket, keyed by requestId. Owned like above. */
  readonly downloadCorrelator: DownloadRequestCorrelator;
  /** Profile-trim (doc-150 §8.3) — correlates POST /v1/profiles/:id/trim eviction
   *  (trimProfile → trimResult) over this node's socket, keyed by requestId. The
   *  OUT-OF-SESSION sibling of the others; owned here like above. */
  readonly trimProfileCorrelator: TrimProfileRequestCorrelator;
  private readonly send: FleetNodeSocketSend;
  private readonly onProfileSaved?: (frame: ProfileSaved, reportingNodeId: string) => void;
  // audit M1 — the cross-node frames now carry the connection's authenticated
  // reportingNodeId so the consumer can drop a frame spoofed for another node's
  // session (mirrors onSessionStatus, hardened earlier as #5).
  private readonly onChallengeDetected?: (
    frame: ChallengeDetected,
    reportingNodeId: string,
  ) => void;
  private readonly onPageState?: (frame: PageStateFrame, reportingNodeId: string) => void;
  private readonly onProfileSaveFailed?: (
    frame: ProfileSaveFailed,
    reportingNodeId: string,
  ) => void;
  private readonly onHeartbeat?: (frame: Heartbeat) => void;
  private readonly onSessionStatus?: (frame: SessionStatus, reportingNodeId: string) => void;
  private readonly onCapabilityReport?: (frame: CapabilityReport, reportingNodeId: string) => void;
  private readonly onErrorEvent?: (frame: HarnessErrorEvent, reportingNodeId: string) => void;
  private readonly logger: Logger | null;
  private readonly admitInbound?: (byteLength: number, largeFrameCandidate: boolean) => boolean;
  // Actively closes THIS connection's underlying socket. Called from `supersede()`
  // when a newer connection for the node replaces this one, so a half-open box socket
  // can't linger + zombie-heartbeat forever (P0 2026-07-11). Optional (legacy/test
  // callers omit it → supersede degrades to the old close-only behaviour).
  private readonly terminate?: () => void;
  // Reconnect/replace race guard (CONFIRMED audit finding): a physical socket has
  // NO cross-connection ordering guarantee against its successor — a harness
  // crash+fast-respawn can open a brand-new TCP connection (→ a brand-new
  // FleetControlConnection via FleetControlRegistry.register) while the OLD
  // socket's already-in-flight frame is still travelling and lands AFTER the
  // registry has moved on. The WS route (fleet-events.ts) binds
  // `socket.on('message', …)` to the SPECIFIC connection object captured at
  // upgrade time, so that stale frame would otherwise be processed as if it came
  // from the CURRENT connection — e.g. a stale heartbeat/bootId re-triggering a
  // mass session close. `close()` is called exactly once a connection is done
  // (replaced by register(), or torn down by unregister()); flip this so every
  // handleInbound call after that point is a guaranteed no-op, mirroring the
  // identity check unregister() already does for registry *removal* — this is
  // the same guarantee for frame *processing*.
  private stale = false;

  constructor(
    readonly nodeId: string,
    send: FleetNodeSocketSend,
    onProfileSaved?: (frame: ProfileSaved, reportingNodeId: string) => void,
    onChallengeDetected?: (frame: ChallengeDetected, reportingNodeId: string) => void,
    onPageState?: (frame: PageStateFrame, reportingNodeId: string) => void,
    onProfileSaveFailed?: (frame: ProfileSaveFailed, reportingNodeId: string) => void,
    onHeartbeat?: (frame: Heartbeat) => void,
    onSessionStatus?: (frame: SessionStatus, reportingNodeId: string) => void,
    // Optional — threaded into the request correlators so the cross-session spoof
    // guard (a result frame whose sessionId disagrees with the pending request's)
    // can log one warn. Omitted (legacy callers / tests) → the guard still DROPS
    // the frame; it just logs nothing.
    logger?: Logger | null,
    // Closes this connection's socket — threaded from the WS route so `supersede()` can
    // actively terminate a replaced/half-open socket (P0 2026-07-11).
    terminate?: () => void,
    // Appended (rather than inserted among the historical positional handlers)
    // so legacy direct/test constructors keep their exact argument meaning.
    onCapabilityReport?: (frame: CapabilityReport, reportingNodeId: string) => void,
    onErrorEvent?: (frame: HarnessErrorEvent, reportingNodeId: string) => void,
    // Production registry-owned token bucket. Appended for positional
    // compatibility with direct unit constructors.
    admitInbound?: (byteLength: number, largeFrameCandidate: boolean) => boolean,
  ) {
    this.send = send;
    this.terminate = terminate;
    this.onProfileSaved = onProfileSaved;
    this.onChallengeDetected = onChallengeDetected;
    this.onPageState = onPageState;
    this.onProfileSaveFailed = onProfileSaveFailed;
    this.onHeartbeat = onHeartbeat;
    this.onSessionStatus = onSessionStatus;
    this.onCapabilityReport = onCapabilityReport;
    this.onErrorEvent = onErrorEvent;
    this.admitInbound = admitInbound;
    const log = logger ?? null;
    this.logger = log;
    const transport: DispatchTransport = { send: (d) => send(JSON.stringify(d)) };
    this.correlator = new IntentDispatchCorrelator(transport);
    const cookiesTransport: CookiesTransport = { send: (r) => send(JSON.stringify(r)) };
    this.cookiesCorrelator = new CookiesRequestCorrelator(cookiesTransport, log);
    const setCookiesTransport: SetCookiesTransport = { send: (r) => send(JSON.stringify(r)) };
    this.setCookiesCorrelator = new SetCookiesRequestCorrelator(setCookiesTransport, log);
    const navigateHistoryTransport: NavigateHistoryTransport = {
      send: (r) => send(JSON.stringify(r)),
    };
    this.navigateHistoryCorrelator = new NavigateHistoryRequestCorrelator(
      navigateHistoryTransport,
      log,
    );
    const uploadTransport: UploadTransport = { send: (r) => send(JSON.stringify(r)) };
    this.uploadCorrelator = new UploadRequestCorrelator(uploadTransport, log);
    const downloadTransport: DownloadTransport = {
      sendList: (r) => send(JSON.stringify(r)),
      sendFetch: (r) => send(JSON.stringify(r)),
    };
    this.downloadCorrelator = new DownloadRequestCorrelator(downloadTransport, log);
    const trimProfileTransport: TrimProfileTransport = { send: (r) => send(JSON.stringify(r)) };
    this.trimProfileCorrelator = new TrimProfileRequestCorrelator(trimProfileTransport, log);
  }

  /**
   * Profile-trim (doc-150 §8.3) — relay a profile's JIT crypto envelope (dek +
   * presigned GET/PUT) to a HEALTHY node so it opens the sealed blob, drops the
   * re-fetchable cache subtrees, re-seals under the SAME dek, and PUTs the trimmed
   * blob back. Sends a `trimProfile` (correlated by `requestId`) and awaits the
   * matching `trimResult`; resolves a uniform TrimProfileOutcome (ok / error /
   * timeout) and NEVER rejects, so the route maps each case to a response.
   * OUT-OF-SESSION: keyed by `profileId` (no live session). `requestId` is
   * caller-generated (the route mints a uuid) so the correlation key stays testable.
   * NEVER log `dek`.
   */
  requestTrim(
    args: {
      requestId: string;
      profileId: string;
      dek: string;
      sealedBlob?: string;
      sealedBlobURL?: string;
      sealedBlobPutURL: string;
    },
    timeoutMs?: number,
  ): Promise<TrimProfileOutcome> {
    const req = serializeTrimProfile(args);
    return this.trimProfileCorrelator.request(req, timeoutMs);
  }

  /**
   * File-control (A3 W2856) — LIST the files in this session's download jail over
   * the node's live WSS. Sends a `listDownloads` (correlated by `requestId`) and
   * awaits the matching `downloadsList`; resolves a uniform DownloadOutcome and
   * NEVER rejects. `requestId` is caller-minted (route uuid) so the key stays testable.
   */
  requestDownloadList(
    requestId: string,
    sessionId: string,
    // audit wb1w3015f #5 — the LIST op is metadata-only (never the 64 MiB body) and
    // is what the GUI POLLS every ~2s, so it defaults to the SHORTER list budget
    // rather than the fetch op's 30s. A caller may still override.
    timeoutMs: number = DOWNLOAD_LIST_REQUEST_TIMEOUT_MS,
  ): Promise<DownloadOutcome> {
    const req = serializeListDownloads({ requestId, sessionId });
    return this.downloadCorrelator.requestList(req, timeoutMs);
  }

  /**
   * File-control (A3 W2856) — FETCH one jailed file's bytes (base64) by basename over
   * the node's live WSS. Sends a `fetchDownload` (correlated by `requestId`) and
   * awaits the matching `downloadData`; resolves a uniform DownloadOutcome and NEVER
   * rejects. The harness re-sanitizes `name` to a basename + jail-confines it.
   */
  requestDownloadFetch(
    requestId: string,
    sessionId: string,
    name: string,
    timeoutMs?: number,
  ): Promise<DownloadOutcome> {
    const req = serializeFetchDownload({ requestId, sessionId, name });
    return this.downloadCorrelator.requestFetch(req, timeoutMs);
  }

  /**
   * File-control (A3 W2851) — relay a customer's file bytes (base64) into the
   * session's isolated upload jail over the node's live WSS. Sends an `uploadFile`
   * (correlated by `requestId`) and awaits the matching `uploadResult`; resolves a
   * uniform UploadOutcome (ok / error / timeout) and NEVER rejects. `requestId` is
   * caller-generated (the route mints a uuid) so the key stays testable. The 64 MiB
   * cap is enforced route-side before this is called.
   */
  requestUpload(
    requestId: string,
    sessionId: string,
    name: string,
    mime: string,
    dataB64: string,
    timeoutMs?: number,
  ): Promise<UploadOutcome> {
    const req = serializeUploadFile({ requestId, sessionId, name, mime, dataB64 });
    return this.uploadCorrelator.request(req, timeoutMs);
  }

  /**
   * Founder #48 — PULL this session's full cookie jar over the node's live WSS.
   * Sends a `cookiesRequest` (correlated by `requestId`) and awaits the matching
   * `cookiesResult`; resolves a uniform CookiesOutcome (ok / error / timeout) and
   * NEVER rejects, so the route maps each case to a response. `requestId` is
   * caller-generated (the route mints a uuid) so the correlation key stays
   * testable + injectable.
   */
  requestCookies(
    requestId: string,
    sessionId: string,
    timeoutMs?: number,
  ): Promise<CookiesOutcome> {
    const req = serializeCookiesRequest({ requestId, sessionId });
    return this.cookiesCorrelator.request(req, timeoutMs);
  }

  /**
   * Cookie-import — WRITE a customer's exported jar into this session's cookie
   * store over the node's live WSS. The write-twin of requestCookies: sends a
   * `setCookies` (correlated by `requestId`) and awaits the matching
   * `setCookiesResult`; resolves a uniform SetCookiesOutcome (ok / error / timeout)
   * and NEVER rejects, so the route maps each case to a response. `requestId` is
   * caller-generated (the route mints a uuid) so the key stays testable. `cookies`
   * is the EXACT CookieSchema jar shape the read/Export emits (round-trips 1:1).
   */
  setCookies(
    requestId: string,
    sessionId: string,
    cookies: Cookie[],
    timeoutMs?: number,
  ): Promise<SetCookiesOutcome> {
    const req = serializeSetCookies({ requestId, sessionId, cookies });
    return this.setCookiesCorrelator.request(req, timeoutMs);
  }

  /**
   * Sim back/forward (A3 W2870) — step the running session's WebKit back-forward
   * list one entry in `direction` over the node's live WSS. The sibling of
   * setCookies: sends a `navigateHistory` (correlated by `requestId`) and awaits the
   * matching `navigateHistoryResult`; resolves a uniform NavigateHistoryOutcome (ok /
   * error / timeout) and NEVER rejects, so the route maps each case to a response.
   * `requestId` is caller-generated (the route mints a uuid) so the key stays testable.
   * `tabId` (optional, after `timeoutMs` to avoid shifting existing positional
   * callers) forwards which tab's back-forward list to step — gated-inert until
   * A3's harness reads it, same as navigateHistory itself already is.
   */
  navigateHistory(
    requestId: string,
    sessionId: string,
    direction: 'back' | 'forward',
    timeoutMs?: number,
    tabId?: string,
  ): Promise<NavigateHistoryOutcome> {
    const req = serializeNavigateHistory({ requestId, sessionId, direction, tabId });
    return this.navigateHistoryCorrelator.request(req, timeoutMs);
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
   * Production receive entrypoint. Admission happens on raw bytes so rejected
   * frames never allocate a same-sized UTF-8 string or parsed object graph.
   * Oversized payloads consume an exact one-shot pending download fetch before
   * parsing; all other traffic consumes the registry's per-node token buckets.
   */
  handleInboundBytes(raw: Buffer): FleetInboundAdmission {
    if (this.stale) {
      this.logger?.warn(
        { component: 'fleet-control-registry', nodeId: this.nodeId },
        'dropping inbound bytes on a stale/superseded FleetControlConnection',
      );
      return 'accepted';
    }

    const isLarge = raw.byteLength > FLEET_INBOUND_LARGE_FRAME_THRESHOLD_BYTES;
    // Charge the raw-byte admission before the potentially near-96 MiB lexical
    // scan. Large candidates have a separate tight bucket, so reconnecting
    // cannot turn even the non-allocating scan itself into unbounded CPU work.
    if (this.admitInbound?.(raw.byteLength, isLarge) === false) {
      return 'parse-budget-exhausted';
    }
    if (isLarge) {
      const header = readLargeDownloadResultHeader(raw);
      if (
        header === null ||
        !this.downloadCorrelator.claimLargeFetchResult(header.requestId, header.sessionId)
      ) {
        return 'uncorrelated-large-frame';
      }
    }
    this.handleInbound(raw.toString('utf8'));
    return 'accepted';
  }

  /**
   * Route one inbound raw WS message. Malformed JSON or an unknown `type` is
   * ignored (defensive — a junk frame must not crash the receive loop). The two
   * consumed variants drive the correlator; the rest are accepted + ignored.
   */
  handleInbound(raw: string): void {
    // Reconnect/replace race guard — see the `stale` field's doc comment above.
    // A frame delivered by a physical socket AFTER this connection object has
    // been superseded/closed must NEVER be dispatched: it could be an old
    // bootId re-triggering a mass session-close, a stale heartbeat, etc. No-op
    // it before even parsing — this connection is no longer "current" for its
    // nodeId regardless of what the frame contains.
    if (this.stale) {
      this.logger?.warn(
        { component: 'fleet-control-registry', nodeId: this.nodeId },
        'dropping inbound frame on a stale/superseded FleetControlConnection (reconnect race)',
      );
      return;
    }
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
          this.onProfileSaved?.(frame, this.nodeId);
          break;
        case 'challengeDetected':
          // Challenge-handling (W393): the harness ChallengeDetector flagged a
          // bot-check + auto-paused the session. Relay to the customer via the
          // injected consumer (→ session.challenge_detected SSE + webhook). Absent
          // consumer (not yet wired / stateless deploy) → ignored, like profileSaved.
          // audit M1 — pass the authenticated nodeId so the relay drops a frame
          // spoofed for another node's session (cross-node spoof guard).
          this.onChallengeDetected?.(frame, this.nodeId);
          break;
        case 'pageState':
          // Page lifecycle on an agent-initiated navigate (A3 W1240/W1254):
          // loading → loaded | errored, keyed by the AGENT session id. The
          // consumer stores the latest per session so GET /v1/agent-sessions/
          // :id/page-state serves the GUI loading-bar/error-overlay. Absent
          // consumer (stateless deploy) → ignored, like the others.
          // audit M1 — pass the authenticated nodeId so the store-writer drops a
          // pageState spoofed for another node's session (cross-node spoof guard).
          this.onPageState?.(frame, this.nodeId);
          break;
        case 'profileSaveFailed':
          // Profile save-back failed at session teardown (A3 W1364): relay to
          // the customer as session.profile_save_failed so persisted-state
          // reliance is informed (terminal — no retry path; session itself
          // stays SUCCEEDED). Absent consumer (stateless deploy) → ignored,
          // like the others.
          // audit M1 — pass the authenticated nodeId so the relay drops a frame
          // spoofed for another node's session (cross-node spoof guard).
          this.onProfileSaveFailed?.(frame, this.nodeId);
          break;
        case 'cookiesResult':
          // Founder #48 — settles the pending GET /:id/cookies request keyed by
          // requestId (the harness echoes it). Self-contained request/reply: no
          // injected consumer (unlike the fire-and-forget frames above) — the
          // awaiting route holds the promise via the connection's cookies
          // correlator. An unknown/stale requestId is a no-op (already settled).
          this.cookiesCorrelator.onResultFrame(frame);
          break;
        case 'setCookiesResult':
          // Cookie-import — settles the pending POST /:id/cookies/set request keyed
          // by requestId (the harness echoes it). Self-contained request/reply like
          // cookiesResult/uploadResult: no injected consumer; the awaiting route
          // holds the promise via the connection's set-cookies correlator. An
          // unknown/stale requestId is a no-op (already settled).
          this.setCookiesCorrelator.onResultFrame(frame);
          break;
        case 'navigateHistoryResult':
          // Sim back/forward (A3 W2870) — settles the pending POST /:id/history request
          // keyed by requestId (the harness echoes it). Self-contained request/reply
          // like setCookiesResult/uploadResult: no injected consumer; the awaiting route
          // holds the promise via the connection's navigate-history correlator. An
          // unknown/stale requestId is a no-op (already settled).
          this.navigateHistoryCorrelator.onResultFrame(frame);
          break;
        case 'uploadResult':
          // File-control (A3 W2851) — settles the pending POST /:id/files request
          // keyed by requestId (the harness echoes it). Self-contained request/reply
          // like cookiesResult: no injected consumer; the awaiting route holds the
          // promise via the connection's upload correlator. Unknown id → no-op.
          this.uploadCorrelator.onResultFrame(frame);
          break;
        case 'downloadsList':
        case 'downloadData':
          // File-control (A3 W2856) — settles the pending GET /:id/downloads list
          // OR fetch request keyed by requestId (the harness echoes it). One
          // correlator handles both: the frame `type` discriminates the outcome.
          // Self-contained request/reply like cookiesResult/uploadResult; unknown
          // id → no-op (already settled).
          this.downloadCorrelator.onResultFrame(frame);
          break;
        case 'trimResult':
          // Profile-trim (doc-150 §8.3) — settles the pending POST /v1/profiles/:id/trim
          // eviction keyed by requestId (the harness echoes it). Self-contained
          // request/reply like cookiesResult: no injected consumer; the awaiting route
          // holds the promise via the connection's trim correlator. The correlator's
          // own cross-account guard checks profileId before settling. Unknown id → no-op.
          this.trimProfileCorrelator.onResultFrame(frame);
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
        case 'capabilityReport':
          // Live session capability/health changes (manual-input availability,
          // streaming blank/failed recovery, dead/recovered upstream proxy).
          // The ownership-gated consumer updates GUI state and the linked
          // driver-session egress persistence/webhook path.
          this.onCapabilityReport?.(frame, this.nodeId);
          break;
        case 'errorEvent':
          // Structured launch/runtime failure emitted after terminal
          // sessionStatus. The consumer atomically verifies this authenticated
          // node is still the persisted session owner before exposing it.
          this.onErrorEvent?.(frame, this.nodeId);
          break;
        //
        // FORWARD-GUARD (A3 bus W1859): an `errorEvent` (summary/detail) and an
        // errored `sessionStatus.detail` can carry the Mac fleet NODE's real IP on
        // an egress-leak diagnostic — detail like "proxied=<customer-proxy-exit>
        // direct=<node-ip>", where `direct=` is the node's own IP (the value the
        // proxy exists to hide; surfacing it to a customer is infra deanonymisation).
        // The errorEvent relay now enforces this boundary server-side: it removes
        // node IPs and credential-shaped text before durable/customer state. The
        // consumed errored `sessionStatus` remains prefix-filtered to
        // `intent_dispatch_no_session` in onSessionError, so no other diagnostic
        // route can bypass that scrub.
      }
    } catch {
      // A handler threw on a valid frame — swallow so the node's receive loop (and
      // the process) survives. Handlers are independently tested; this is the
      // last-resort backstop for the documented no-crash guarantee.
    }
  }

  /** The socket closed/errored: fail every in-flight dispatch + cookies pull +
   *  cookie-import + history-step + upload + download + profile-trim on this node
   *  (so an awaiting request resolves immediately, not at timeout). */
  close(reason: string): void {
    // Flip FIRST: once a connection is closing (replaced by a reconnect, or torn
    // down on socket close/error), it must never process another inbound frame —
    // see handleInbound's stale-guard + the field's doc comment above.
    this.stale = true;
    this.correlator.failAll(reason);
    this.cookiesCorrelator.failAll(reason);
    this.setCookiesCorrelator.failAll(reason);
    this.navigateHistoryCorrelator.failAll(reason);
    this.uploadCorrelator.failAll(reason);
    this.downloadCorrelator.failAll(reason);
    this.trimProfileCorrelator.failAll(reason);
  }

  /** Superseded by a newer connection for this node (a reconnect): fail in-flight
   *  requests (via close()) AND actively close the OLD socket. Without the socket close,
   *  a half-open box socket lingers — the box keeps heartbeating on it (~11s) while the
   *  CP drops every frame via the stale-guard, and it never reconnects cleanly. This was
   *  the 2026-07-11 P0 ("browser instantly crashes" — dispatch couldn't reach the box).
   *  A GRACEFUL close (code 1012, not terminate()/socket.destroy()) so the box sees a
   *  clean WS close and reconnects, not an abrupt RST (ENOTCONN). The old socket's own
   *  'close' handler then no-ops through unregister()'s identity guard, and stops its
   *  keepalive interval — so this also plugs a per-supersede keepalive leak. */
  supersede(reason: string): void {
    this.close(reason);
    this.terminate?.();
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
  /** Shared by node id across reconnects; a reconnect cannot reset parse tokens. */
  private readonly inboundFrameBudget = new FleetInboundFrameBudget();
  /**
   * Pending-teardown queue (founder bug, A3 W2859) — sessions whose close couldn't
   * reach the box because its control-WSS was down/flapping. `dispatchSessionEndOnClose`
   * records them here when the node has no live connection; `register()` drains +
   * re-dispatches `sessionEnd` on the node's next (re)connect, so a WSS blip can't
   * leave an orphaned browser. nodeId → set of sessionIds, bounded per node (a node
   * that never returns can't leak); a stale re-dispatch (session already gone) is a
   * harmless box-side no-op.
   */
  private readonly pendingTeardowns = new Map<string, Set<string>>();
  private static readonly MAX_PENDING_TEARDOWNS_PER_NODE = 256;

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
    private readonly onProfileSaved?: (frame: ProfileSaved, reportingNodeId: string) => void,
    // audit M1 — these three carry the reporting node's authenticated id so the
    // consumer can drop a cross-node-spoofed frame (see fleet-session-ownership).
    private readonly onChallengeDetected?: (
      frame: ChallengeDetected,
      reportingNodeId: string,
    ) => void,
    private readonly onPageState?: (frame: PageStateFrame, reportingNodeId: string) => void,
    private readonly onProfileSaveFailed?: (
      frame: ProfileSaveFailed,
      reportingNodeId: string,
    ) => void,
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
    /**
     * Optional server logger, threaded into every connection's request
     * correlators so the cross-session spoof guard can log one warn on a
     * confirmed sessionId mismatch (a misrouted/echoed result frame). Omitted
     * (stateless deploy / tests) → the guard still DROPS the frame silently.
     */
    private readonly logger?: Logger | null,
    // Appended for positional back-compat; threaded into every new connection.
    private readonly onCapabilityReport?: (
      frame: CapabilityReport,
      reportingNodeId: string,
    ) => void,
    // Appended for positional back-compat; durable customer/SDK error relay.
    private readonly onErrorEvent?: (frame: HarnessErrorEvent, reportingNodeId: string) => void,
  ) {}

  register(
    nodeId: string,
    send: FleetNodeSocketSend,
    // Closes the NEW socket — threaded into the connection so a later reconnect can
    // actively terminate THIS one on supersede (P0 2026-07-11). Optional: legacy/test
    // callers omit it and supersede degrades to close-only (the prior behaviour).
    terminate?: () => void,
  ): FleetControlConnection {
    const existing = this.connections.get(nodeId);
    if (existing !== undefined) {
      // supersede (not just close): actively close the OLD socket so a half-open box
      // socket can't linger + zombie-heartbeat into the stale-guard forever. (P0.)
      existing.supersede(`replaced by a new connection for node ${nodeId}`);
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
      this.logger,
      terminate,
      this.onCapabilityReport,
      this.onErrorEvent,
      (byteLength, largeFrameCandidate) =>
        this.inboundFrameBudget.admit(nodeId, byteLength, largeFrameCandidate),
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
    // Pending-teardown drain (founder bug, A3 W2859): re-dispatch sessionEnd for any
    // session whose close couldn't reach the box while this node's WSS was down. The
    // node is connected again now, so the teardown lands + the box frees the slot /
    // kills the orphaned browser. Remove each id only AFTER its send returns. A send
    // exception is ambiguous and remains for the next reconnect; it must not abort
    // later ids or registration. A stale/repeated id is a box-side no-op.
    const pending = this.pendingTeardowns.get(nodeId);
    if (pending !== undefined) {
      // Snapshot so a send callback that synchronously records another teardown
      // cannot extend this drain without bound. The newly-added id stays queued.
      for (const sessionId of [...pending]) {
        try {
          conn.sendSessionEnd(serializeSessionEnd(sessionId));
          pending.delete(sessionId);
        } catch {
          /* retain — one failed re-dispatch must not abort later ids or registration */
        }
      }
      if (pending.size === 0 && this.pendingTeardowns.get(nodeId) === pending) {
        this.pendingTeardowns.delete(nodeId);
      }
    }
    return conn;
  }

  /**
   * Queue a `sessionEnd` to re-dispatch when `nodeId` next (re)connects — for a
   * session whose close couldn't reach the box because the node had no live
   * connection (WSS down/flapping). `dispatchSessionEndOnClose` calls this on the
   * `conn === undefined` path; `register()` drains it. Bounded per node so a node
   * that never returns can't leak (drops the oldest at the cap).
   */
  recordPendingTeardown(nodeId: string, sessionId: string): void {
    let set = this.pendingTeardowns.get(nodeId);
    if (set === undefined) {
      set = new Set<string>();
      this.pendingTeardowns.set(nodeId, set);
    }
    if (set.size >= FleetControlRegistry.MAX_PENDING_TEARDOWNS_PER_NODE && !set.has(sessionId)) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
    set.add(sessionId);
  }

  /** In-flight pending teardowns for a node (test/inspection helper). */
  pendingTeardownCount(nodeId: string): number {
    return this.pendingTeardowns.get(nodeId)?.size ?? 0;
  }

  get(nodeId: string): FleetControlConnection | undefined {
    return this.connections.get(nodeId);
  }

  /**
   * Profile-trim (doc-150 §8.3) — pick ANY connected node. Trim is OUT-OF-SESSION:
   * a profile at rest in R2 has no assigned node, and the work (open → drop caches →
   * re-seal → PUT) is a self-contained blob→blob transform that any healthy node can
   * run (it needs only the JIT crypto envelope, no session state). A live WS in the
   * registry means the node authenticated + is reachable on the control plane, which
   * is the liveness bar this picker needs; the FIRST connection is returned (the Map
   * preserves insertion order — deterministic for tests). Returns undefined when no
   * node is connected (the route maps that to a graceful `unavailable`). A finer
   * health/least-loaded policy is a future refinement (out of v1 scope).
   */
  pickAnyConnected(): FleetControlConnection | undefined {
    const first = this.connections.values().next();
    return first.done ? undefined : first.value;
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
