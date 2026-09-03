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
  } | null>;
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
    if (session.driftstackSessionId === null) return;

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

    // T-6 — back-fill the REAL, measured QUIC verdict onto the proxy this
    // session browsed through, so the proxy test/chip can show a confirmed
    // result instead of a guess inferred from UDP association. `quicViaProxy` is
    // the same signal reported as quic_route above: an active h2-and-h3
    // transport WITH the HTTP/3 interpose loaded means QUIC really carried, so
    // we write 'h3'; a session that ran without it writes 'h2-only' (a measured
    // absence, still not the same as never-measured/null). Only when a proxy is
    // actually attributed (proxyId non-null) — an operator-default egress has no
    // owned proxy to mark. The update is owner-scoped (id + accountId), so a
    // foreign or deleted proxy_id updates no row. Best-effort: a back-fill
    // failure is logged but never fails consuming the report (the egress
    // persistence above already succeeded).
    if (accountProxies !== undefined && session.proxyId !== null) {
      try {
        await accountProxies.update({
          id: session.proxyId,
          accountId: session.accountId,
          updates: {
            quicMeasured: quicViaProxy ? 'h3' : 'h2-only',
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
