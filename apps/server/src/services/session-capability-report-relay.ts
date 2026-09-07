// Ownership-gated live capabilityReport consumer.
//
// One accepted frame updates the agent-session GUI state and, when the agent is
// linked to a driver session, calls the already-existing atomic raw+derived
// egress persistence/webhook path. Processing is serialized per agent session
// so a slower ownership lookup cannot let an older state overwrite a newer one.

import type { Logger } from '../lib/logger.js';
import type { CapabilityReport } from '../schemas/harness-control-protocol.js';
import { makeBoundedNodeLatestRelay } from './bounded-node-latest-relay.js';
import type { SessionCapabilityReportStore } from './session-capability-report-store.js';

interface CapabilityReportAgentSessions {
  get(id: string): Promise<{
    nodeId: string | null;
    driftstackSessionId: string | null;
    status: string;
    // T-6 — carried so a measured QUIC verdict can be attributed, owner-scoped,
    // to the proxy this session browsed through. accountId scopes the update;
    // proxyId is NULL when the session used an operator-default egress.
    accountId: string;
    proxyId: string | null;
    // T-26 — the stop-on-exit-IP-change policy and the remembered first exit IP.
    // Optional here so older test fakes (and any caller that predates the policy)
    // read as "no policy": undefined stopOnExitIpChange never triggers enforcement.
    stopOnExitIpChange?: boolean;
    firstExitIp?: string | null;
  } | null>;
  // T-26 — record the FIRST exit IP once, close the session on a change, and
  // stamp the customer-visible from/to. The full repo satisfies these.
  setFirstExitIpIfUnset(id: string, exitIp: string): Promise<unknown>;
  closeWithReasonOutcome(
    id: string,
    reason: string,
  ): Promise<{ kind: 'closed' | 'already_closed' }>;
  recordErrorEvent(
    id: string,
    reportingNodeId: string,
    event: {
      timestamp: string;
      code: string;
      severity: 'info' | 'warn' | 'error' | 'fatal';
      summary: string;
      detail: string | null;
      customerActionable: boolean;
      retryable: boolean;
    },
  ): Promise<unknown>;
}

// T-6 — the owner-scoped account_proxies update the back-fill needs. The real
// AccountProxiesRepo.update matches this: a foreign or absent (id, accountId)
// pair updates no row, so a stray proxy_id is a safe no-op.
interface CapabilityReportAccountProxies {
  update(args: {
    id: string;
    accountId: string;
    updates: { quicMeasured: string; quicMeasuredAt: Date };
  }): Promise<unknown>;
}

interface CapabilityReportSessionsService {
  ingestEgressCapabilityReport(args: {
    sessionId: string;
    derived: {
      udp_associate: boolean;
      quic_route: 'proxy' | 'disabled';
      dns_remote_resolve: boolean;
      warnings: string[];
    };
    raw: Record<string, unknown>;
  }): Promise<unknown>;
}

function deriveWarnings(frame: CapabilityReport): string[] {
  const warnings: string[] = [];
  if (frame.transportModeRequested === 'h2-and-h3' && frame.transportModeActive !== 'h2-and-h3') {
    warnings.push('udp_unsupported_by_proxy');
  }
  if (frame.transportModeActive === 'h2-and-h3' && !frame.h3InterposeLoaded) {
    warnings.push('h3_interpose_unavailable');
  }
  // No checks at all is its OWN signal, not silence. Without this the empty
  // case produced zero warnings AND a true `safeguards_passed`, so a session
  // whose safeguards never ran looked exactly like a verified healthy one.
  if (frame.safeguardChecks.length === 0) {
    warnings.push('safeguards_unreported');
  }
  for (const check of frame.safeguardChecks) {
    if (!check.passed) warnings.push(`safeguard_failed:${check.layer}`);
  }
  if (frame.streamingState === 'blank') warnings.push('streaming_blank');
  if (frame.streamingState === 'failed') warnings.push('streaming_failed');
  if (frame.egressState === 'dead_proxy') warnings.push('dead_proxy');
  return warnings;
}

export function makeSessionCapabilityReportRelay(
  agentSessions: CapabilityReportAgentSessions,
  sessionsService: CapabilityReportSessionsService,
  store: SessionCapabilityReportStore,
  logger: Logger,
  // T-6 — the account_proxies repo the QUIC back-fill writes through, and the
  // clock that stamps quic_measured_at. Optional so an unwired construction
  // keeps today's behaviour (store + egress persistence) with no back-fill.
  accountProxies?: CapabilityReportAccountProxies,
  now: () => Date = () => new Date(),
): (frame: CapabilityReport, reportingNodeId: string) => void {
  const process = async (frame: CapabilityReport, reportingNodeId: string): Promise<void> => {
    const session = await agentSessions.get(frame.sessionId);
    if (session === null || session.nodeId !== reportingNodeId || session.status === 'closed') {
      logger.warn(
        {
          component: 'session-capability-report-relay',
          sessionId: frame.sessionId,
          ownerNodeId: session?.nodeId ?? null,
          reportingNodeId,
          sessionStatus: session?.status ?? null,
        },
        'dropped capabilityReport without an exact live session-owner node match',
      );
      return;
    }

    store.set(frame);

    // T-26 — stop-on-exit-IP-change enforcement, control-plane side only: the
    // harness already emits the exit IP on the capabilityReport it sends, so no
    // harness change is needed. Fires only when the customer PINNED the session
    // AND the frame carries a PARSED exit IP — a malformed one was dropped by the
    // schema (`.catch(undefined)`), so `exitIp` is undefined and enforcement can
    // never act on garbage.
    if (frame.exitIp !== undefined && session.stopOnExitIpChange === true) {
      const firstExitIp = session.firstExitIp ?? null;
      if (firstExitIp === null) {
        // Remember the FIRST observed exit IP on the SESSION ROW — it survives a
        // control-plane restart, which the in-memory capability store above does
        // NOT. Only-if-unset so a race between two reports records one baseline.
        await agentSessions.setFirstExitIpIfUnset(frame.sessionId, frame.exitIp);
      } else if (firstExitIp !== frame.exitIp) {
        // The exit IP moved under a pinned session. END it through the SAME
        // atomic terminal close the DELETE route and worker-terminal-close use —
        // no second teardown invented. The reporting box is still connected, so
        // the next heartbeat's worker-orphan reconcile re-issues sessionEnd for a
        // CP-terminal session the worker still reports active, tearing the box
        // session down through the existing path too.
        const outcome = await agentSessions.closeWithReasonOutcome(
          frame.sessionId,
          'exit_ip_changed',
        );
        if (outcome.kind === 'closed') {
          // Customer-visible from/to on the durable errorEvent the GET response
          // already surfaces (the existing terminal-reason mechanism), so the GUI
          // can render "Stopped: exit IP changed from A to B". Owner-matched (we
          // verified session.nodeId === reportingNodeId above) and deliberately
          // NOT run through the node-diagnostic scrubber: these are the customer's
          // OWN egress IPs, not fleet-node IPs.
          await agentSessions.recordErrorEvent(frame.sessionId, reportingNodeId, {
            timestamp: frame.observedAt ?? frame.timestamp,
            code: 'exit_ip_changed',
            severity: 'warn',
            summary: `Session stopped: exit IP changed from ${firstExitIp} to ${frame.exitIp}.`,
            detail: null,
            customerActionable: true,
            retryable: false,
          });
        }
        // Evict the live capability state for a now-terminal session (mirrors the
        // DELETE route). The session is ending — skip the QUIC back-fill and
        // egress-persistence below.
        store.delete(frame.sessionId);
        return;
      }
    }

    // T-6 — the MEASURED signal: present-and-true only once a real QUIC handshake
    // completed this session (fork marker). Absent on any harness that has not
    // observed one, so absence writes nothing and only a real observation ever
    // stamps a green verdict onto the proxy.
    const quicReallyObserved = frame.h3ConnectionObserved === true;
    // T-6 — back-fill the REAL, MEASURED QUIC verdict onto the proxy this session
    // browsed through, so the proxy test/chip shows a confirmed result instead of
    // a guess. We write ONLY on a real observation: `quicReallyObserved` is
    // present-and-true only after a QUIC handshake actually completed this
    // session, so we write 'h3'. We DELIBERATELY write NOTHING otherwise — the
    // absence of an observed handshake is "not measured yet", NOT "this proxy
    // can't do QUIC", so recording 'h2-only' from it would be a measured-absence
    // claim we cannot back (the config echo in the other direction). A proxy
    // stays null (chip: inferred) until a session genuinely carries h3 through
    // it. Only when a proxy is actually attributed (proxyId non-null) — an
    // operator-default egress has no owned proxy to mark. Owner-scoped (id +
    // accountId), so a foreign or deleted proxy_id updates no row. Best-effort: a
    // failure is logged but never fails consuming the report.
    if (accountProxies !== undefined && session.proxyId !== null && quicReallyObserved) {
      try {
        await accountProxies.update({
          id: session.proxyId,
          accountId: session.accountId,
          updates: {
            quicMeasured: 'h3',
            quicMeasuredAt: now(),
          },
        });
      } catch (error) {
        logger.error(
          {
            component: 'session-capability-report-relay',
            sessionId: frame.sessionId,
            proxyId: session.proxyId,
            err: error,
          },
          'failed to back-fill measured QUIC verdict onto the proxy',
        );
      }
    }

    // ⛔ THE BACK-FILL ABOVE RUNS FIRST, DELIBERATELY. This guard belongs to the
    // egress ingest below, which passes `session.driftstackSessionId` as its
    // subject and genuinely cannot run without one. The back-fill needs only
    // accountId + proxyId and had inherited this return BY POSITION — so every
    // session created without a customer-supplied driver-session link (the normal
    // shape, including every session the desktop app creates) could never record
    // a measured QUIC verdict, however real the observation was.
    if (session.driftstackSessionId === null) return;

    // The CONFIGURED routing state: an h2-and-h3 transport whose interpose flag
    // is set. h3InterposeLoaded is a restatement of the requested mode, not an
    // observation, so this describes what egress was CONFIGURED, never that QUIC
    // was measured — it feeds quic_route (a routing flag), never the customer's
    // "measured QUIC" verdict.
    const quicViaProxy = frame.transportModeActive === 'h2-and-h3' && frame.h3InterposeLoaded;
    const { type: _type, ...raw } = frame;
    await sessionsService.ingestEgressCapabilityReport({
      sessionId: session.driftstackSessionId,
      derived: {
        udp_associate: frame.proxyUdpSupported,
        quic_route: quicViaProxy ? 'proxy' : 'disabled',
        // The harness proxy chain never installs a local resolver; it forwards
        // hostnames to the upstream proxy (ProxyChain.swift H3.exec.116).
        dns_remote_resolve: true,
        warnings: deriveWarnings(frame),
      },
      raw,
    });
  };

  return makeBoundedNodeLatestRelay({
    getSessionId: (frame) => frame.sessionId,
    process,
    onError: ({ error, sessionId }) => {
      logger.error(
        { component: 'session-capability-report-relay', sessionId, err: error },
        'failed to consume capabilityReport',
      );
    },
    onOverflow: ({ reportingNodeId, sessionBudget, sessionId }) => {
      logger.warn(
        {
          component: 'session-capability-report-relay',
          reportingNodeId,
          sessionBudget,
          sessionId,
        },
        'dropped capabilityReport because the reporting node exceeded its relay session budget',
      );
    },
  });
}
