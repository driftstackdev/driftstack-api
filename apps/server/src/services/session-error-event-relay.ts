// Authenticated harness errorEvent consumer.
//
// The harness emits terminal sessionStatus first and the structured errorEvent
// second, so this relay deliberately accepts a closed session while requiring
// the atomic repository update to match the connection's authenticated node.

import type { Logger } from '../lib/logger.js';
import {
  HARNESS_ERROR_EVENT_DETAIL_MAX_LENGTH,
  HARNESS_ERROR_EVENT_SUMMARY_MAX_LENGTH,
  type HarnessErrorEvent,
} from '../schemas/harness-control-protocol.js';
import type { AgentSessionErrorEvent, AgentSessionsRepo } from './agent-sessions.js';
import {
  BOUNDED_NODE_LATEST_RELAY_MAX_CONCURRENT,
  BOUNDED_NODE_LATEST_RELAY_MAX_SESSIONS,
  makeBoundedNodeLatestRelay,
} from './bounded-node-latest-relay.js';
import type { NotificationEventBus } from './notification-event-bus.js';
import { customerSafeNodeDiagnostic } from './scrub-node-diagnostics.js';

// A real worker cannot own more than the heartbeat protocol's declared 512
// concurrent sessions. Keep the relay's distinct active/queued session budget
// at that same ceiling so an authenticated but compromised node cannot turn
// unique fake session ids into an unbounded promise map and DB work queue.
export const ERROR_EVENT_RELAY_MAX_SESSIONS_PER_NODE = BOUNDED_NODE_LATEST_RELAY_MAX_SESSIONS;
// Ownership checks and persistence are local-DB work. Eight concurrent writes
// per reporting node leave ample headroom for a real terminal-session burst
// without letting one node monopolize the pool.
export const ERROR_EVENT_RELAY_MAX_CONCURRENT_PER_NODE = BOUNDED_NODE_LATEST_RELAY_MAX_CONCURRENT;

type SessionScopedHarnessErrorEvent = HarnessErrorEvent & { sessionId: string };

// ─── A proxy failure on a session that used no proxy of its own ─────────────
//
// A session created with no `proxy_id` is dispatched through the operator-default
// upstream (routes/agent-sessions.ts: `inlineProxyConfig = sessionDispatch.proxy`
// unless the create named a proxy), and its row keeps `proxyId: null`. When that
// upstream fails, the device reports exactly what it reports for a customer's own
// proxy — the same code, often `customerActionable: true`, and a summary about
// "its proxy" — because from the phone the two cases are indistinguishable. The
// customer chose no proxy and cannot fix ours. Only this server knows the default
// was attached, so the report is corrected here, before it is persisted.

/** The code a proxy-family failure on a session with no proxy of its own is
 *  persisted, notified and closed under. */
export const DEFAULT_EGRESS_UNAVAILABLE_CODE = 'default_egress_unavailable';

/**
 * Server-owned customer copy for that code. The desktop app renders it verbatim
 * as a quieter second line under its own explanation, so the app's sentence must
 * not repeat it word for word (pinned in session-error-event-relay.test.ts).
 * "failed", not "is down": the family includes one-off failures of the local
 * half of the path, and every hop of that path is ours either way.
 */
export const DEFAULT_EGRESS_UNAVAILABLE_SUMMARY =
  'This session did not use a proxy of your own, so it used the connection Driftstack provides, and that connection failed. This is on our side. To run now, start a new session with one of your own proxies.';

/**
 * The device codes and close reasons that, on a session with no proxy of its own,
 * describe OUR connection failing while reading as the customer's proxy failing.
 * Whole tokens, never a prefix: `/^(proxy_|egress_)/` would take in the named
 * refusal and the VPN-only code below, and whatever the device adds next.
 *
 * Derived from what the desktop app renders with proxy wording (AgentSessionPanel
 * friendlySessionEndCopy: the `/^(proxy_|egress_)/` branch, `network_shim_boot_failed`
 * and `egress_verification_unavailable`), checked against the device's producers
 * (HarnessCoordinator.errorEventForStatus / sweepEgressReverification):
 *   proxy_connection_failed          the probe through the upstream failed
 *   egress_verification_unavailable  the probe through the upstream could not be verified
 *   egress_unreachable               the upstream's exit could not be placed (geo)
 *   egress_invariant_violation       traffic was not leaving through the upstream
 *   proxy_udp_unsupported            the upstream cannot carry what the session needs
 *   egress_lost                      the path died mid-session (also a close reason)
 *   proxy_boot_failed, network_shim_boot_failed
 *                                    the local half of the same path did not start
 *   proxy_auth_failed                the upstream refused its sign-in (a device code
 *                                    shipping later; on a session with no proxy of its
 *                                    own the credentials refused are ours)
 * plus the device's own end reasons for the probe and invariant refusals
 * (`egress_probe_failed`, `egress_probe_unverifiable`), which the app's prefix
 * branch would also render as a proxy failure if they reach `closed_reason`.
 *
 * EXCLUDED, each for a stated reason:
 *   proxy_required / no_proxy_configured — the named refusal when no default is
 *     configured at all; it is right as it is.
 *   egress_bind_failed and the typed VPN bring-up reasons (remote_unresolved, …,
 *     vpn_bringup_failed) — produced only by an OpenVPN/WireGuard tunnel, and the
 *     default is SOCKS5 only (SessionDispatchConfig.proxy is a SocksProxyConfig),
 *     so they only ever arrive with a customer proxy, i.e. proxyId set.
 *   egress_unresolved — written by the create route for a customer proxy_id that
 *     would not resolve; never a device frame.
 */
const DEFAULT_EGRESS_FAILURE_CODES: ReadonlySet<string> = new Set([
  'proxy_connection_failed',
  'egress_verification_unavailable',
  'egress_unreachable',
  'egress_invariant_violation',
  'proxy_udp_unsupported',
  'egress_lost',
  'proxy_boot_failed',
  'network_shim_boot_failed',
  'egress_probe_failed',
  'egress_probe_unverifiable',
  'proxy_auth_failed',
]);

/** True when a device code or close reason, reported for a session with no proxy
 *  of its own, is a failure of the connection Driftstack provides. */
export function isDefaultEgressFailure(code: string): boolean {
  return DEFAULT_EGRESS_FAILURE_CODES.has(code);
}

// ─── The refusal of a session started with no proxy ─────────────────────────
//
// When no connection of ours is offered (no operator-default upstream), the
// device refuses a session that arrives with no proxy: errorEvent code
// `proxy_required` — `no_proxy_configured` is the same refusal spelled as the
// device's end reason — with the summary "no_proxy_configured: session refused —
// egress requires the customer proxy" (HarnessCoordinator's `.refuseNoProxy`
// branch, summarised by `errorEventForStatus`). The desktop app renders the
// summary VERBATIM as the session-end detail line, so a customer read a device
// token and our internal word. If the default upstream is unset, this is the
// path for EVERY session started with no proxy.
//
// Only the WORDS change: the code, severity, customerActionable and retryable are
// kept as sent, and the session's row is never read (the copy does not depend on
// it — the device refuses this way only when no proxy reached it). It is NOT the
// default-connection remap above: nothing of ours failed, the session was refused
// for having no proxy, so the code stays the refusal's.

const NO_PROXY_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'proxy_required',
  'no_proxy_configured',
]);

/**
 * Server-owned copy for the refusal. The desktop app renders it under its own
 * explanation for the same code, so the two must not repeat each other word for
 * word (pinned in session-error-event-relay.test.ts).
 */
export const NO_PROXY_REFUSAL_SUMMARY =
  'This session was started with no proxy of yours, and sessions here run only through one you have added. Start a new session with one of your saved proxies.';

/** True for the device's refusal of a session that arrived with no proxy. */
export function isNoProxyRefusal(code: string): boolean {
  return NO_PROXY_REFUSAL_CODES.has(code);
}

// ─── A failure on our side, on a session WITH a proxy of its own ────────────
//
// Three codes in the family above are failures of the part of the connection
// WE run, whoever's proxy the session uses — checked against the device source
// (HarnessCoordinator.errorEventForStatus and the producers it names):
//   proxy_boot_failed         our local relay for the session did not boot
//                             ("LOCAL infra, not the customer's upstream proxy")
//   network_shim_boot_failed  our per-session network process did not start
//   egress_lost               our local relay or tunnel PROCESS died mid-session:
//                             sweepEgressReverification decides it with a local
//                             isAlive() (is our process still running?), which by
//                             the device's own note cannot see a dead upstream
//                             proxy — that surfaces separately, as `dead_proxy`.
// The device's summary for each is its internal detail (`egress_lost`,
// `proxy_boot_failed after 3 attempt(s): …`), rendered verbatim by the desktop
// app. On a session with no proxy of its own they are rewritten to
// default_egress_unavailable above; on one WITH a proxy the code is kept, the
// words become ours, and `customerActionable` is false: the device marks
// egress_lost actionable ("they may restore their proxy"), but nothing it
// measured is the customer's to restore.

const OUR_SIDE_CONNECTION_CODES: ReadonlySet<string> = new Set([
  'proxy_boot_failed',
  'network_shim_boot_failed',
  'egress_lost',
]);

/**
 * Server-owned copy for those codes on a session with a proxy of its own. The
 * desktop app renders it under its own explanation for the same codes, so the
 * two must not repeat each other word for word (pinned in
 * session-error-event-relay.test.ts).
 */
export const OUR_SIDE_CONNECTION_SUMMARY =
  'This failed on our side, not at your proxy. Starting another session is usually enough to get going again.';

/** True for a failure of the part of the connection we run (see above). */
export function isOurSideConnectionFailure(code: string): boolean {
  return OUR_SIDE_CONNECTION_CODES.has(code);
}

export function makeSessionErrorEventRelay(
  // `get` reads the session's proxyId before the write, and only for a code in
  // the family above. proxyId is written by `setNodeId`, in the SAME UPDATE that
  // claims node_id (agent-sessions-repo.ts), and dispatch persists that claim
  // before it sends the assignment — so any frame able to pass the
  // node-ownership WHERE in `recordErrorEvent` was sent by a node assigned after
  // proxyId was set. The one other writer is the mid-session egress swap (off by
  // default), which rewrites it on the owning node's row the moment the device
  // accepts a swap (setProxyIdForOwnedActiveSession) — so the read follows the
  // proxy the session is on, and ownership stays exactly where it was: in that
  // WHERE.
  agentSessions: Pick<AgentSessionsRepo, 'recordErrorEvent' | 'get'>,
  notifications: NotificationEventBus,
  logger: Logger,
): (frame: HarnessErrorEvent, reportingNodeId: string) => void {
  const receiveSessionScoped = makeBoundedNodeLatestRelay<SessionScopedHarnessErrorEvent>({
    getSessionId: (frame) => frame.sessionId,
    process: async (frame, reportingNodeId) => {
      const sent: AgentSessionErrorEvent = {
        timestamp: frame.timestamp,
        code: frame.code,
        severity: frame.severity,
        summary: customerSafeNodeDiagnostic(frame.summary, HARNESS_ERROR_EVENT_SUMMARY_MAX_LENGTH),
        detail:
          frame.detail !== undefined
            ? customerSafeNodeDiagnostic(frame.detail, HARNESS_ERROR_EVENT_DETAIL_MAX_LENGTH)
            : null,
        customerActionable: frame.customerActionable,
        retryable: frame.retryable,
      };
      // An unknown session reads null and falls through unchanged, so it drops
      // at `recordErrorEvent` below exactly as it always has.
      const onDefaultConnection =
        isDefaultEgressFailure(frame.code) &&
        (await agentSessions.get(frame.sessionId))?.proxyId === null;
      const event: AgentSessionErrorEvent = onDefaultConnection
        ? {
            ...sent,
            code: DEFAULT_EGRESS_UNAVAILABLE_CODE,
            summary: DEFAULT_EGRESS_UNAVAILABLE_SUMMARY,
            // The device's detail can describe the upstream itself.
            detail: null,
            customerActionable: false,
          }
        : isNoProxyRefusal(frame.code)
          ? // Server words, the device's code and flags. See NO_PROXY_REFUSAL_SUMMARY.
            { ...sent, summary: NO_PROXY_REFUSAL_SUMMARY, detail: null }
          : isOurSideConnectionFailure(frame.code)
            ? // Ours, on a session with a proxy of its own. See OUR_SIDE_CONNECTION_SUMMARY.
              {
                ...sent,
                summary: OUR_SIDE_CONNECTION_SUMMARY,
                detail: null,
                customerActionable: false,
              }
            : sent;
      const session = await agentSessions.recordErrorEvent(frame.sessionId, reportingNodeId, event);
      if (session === null) {
        logger.warn(
          {
            component: 'session-error-event-relay',
            sessionId: frame.sessionId,
            reportingNodeId,
            code: frame.code,
          },
          'dropped errorEvent without an exact session-owner node match',
        );
        return;
      }

      notifications.publish({
        kind: 'session.errored',
        accountId: session.accountId,
        sessionId: session.id,
        errorClass: event.code,
        at: event.timestamp,
      });

      if (onDefaultConnection) {
        // Only after the owner-matched write: a frame that was refused reports
        // nothing. The ORIGINAL code, never summary/detail (they can carry an
        // address) — this is how operators learn the default connection failed.
        logger.error(
          {
            component: 'session-error-event-relay',
            sessionId: frame.sessionId,
            reportingNodeId,
            code: frame.code,
            persistedCode: DEFAULT_EGRESS_UNAVAILABLE_CODE,
          },
          'the operator-default connection failed for a session with no proxy of its own; persisted as default_egress_unavailable',
        );
      }
    },
    onError: ({ error, sessionId }) => {
      logger.error(
        { component: 'session-error-event-relay', sessionId, err: error },
        'failed to consume errorEvent',
      );
    },
    onOverflow: ({ reportingNodeId, sessionBudget, sessionId }) => {
      logger.warn(
        {
          component: 'session-error-event-relay',
          sessionId,
          reportingNodeId,
          sessionBudget,
        },
        'dropped errorEvent because the reporting node exceeded its relay session budget',
      );
    },
  });

  return (frame: HarnessErrorEvent, reportingNodeId: string): void => {
    if (frame.sessionId === undefined) {
      // A node-scoped failure has no session to persist on and no customer to
      // notify — but dropping it SILENTLY left the server log empty exactly when
      // an operator asks "the load just stopped, what happened?" (V-2155). Log
      // the code, never summary/detail: those can carry the node's own IP.
      logger.warn(
        {
          component: 'session-error-event-relay',
          reportingNodeId,
          code: frame.code,
          severity: frame.severity,
          customerActionable: frame.customerActionable,
          retryable: frame.retryable,
        },
        'node-scoped errorEvent (no sessionId) — not persisted, not notified; correlate by node + time',
      );
      return;
    }
    receiveSessionScoped(frame as SessionScopedHarnessErrorEvent, reportingNodeId);
  };
}
