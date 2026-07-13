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
  } | null>;
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
