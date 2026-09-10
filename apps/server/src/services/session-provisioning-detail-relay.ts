import type { Logger } from '../lib/logger.js';
import type { SessionStatus } from '../schemas/harness-control-protocol.js';
import type { AgentSessionsRepo } from './agent-sessions.js';

// (c) 2026-09-10 — records the harness's intermediate `provisioning` detail on the
// agent_sessions row so the customer read can say WHY a session is still
// provisioning ("VPN tunnel connected — starting the browser…") instead of a
// bare "connecting…". Today's only token is `vpn_egress_active` (harness
// faa38a82d): the node brought the tunnel up and deliberately does NOT claim
// `active` until a browser exists. An `active` frame clears the detail.
// Ownership-gated like the terminal-close relay: only the node the session is
// bound to may describe its provisioning; an unbound session accepts the first
// reporter. Fire-and-forget off the receive loop — never throws.

export const PROVISIONING_DETAIL_MAX_LENGTH = 200;

export type ProvisioningDetailOutcome = 'set' | 'cleared' | 'ignored';

export interface SessionProvisioningDetailRelayDeps {
  readonly agentSessions: Pick<AgentSessionsRepo, 'get' | 'setProvisioningDetail'>;
  readonly logger?: Logger | null;
}

export async function handleSessionProvisioningDetail(
  deps: SessionProvisioningDetailRelayDeps,
  frame: SessionStatus,
  reportingNodeId: string,
): Promise<ProvisioningDetailOutcome> {
  try {
    const detail =
      frame.status === 'provisioning'
        ? typeof frame.detail === 'string' && frame.detail.length > 0
          ? frame.detail.slice(0, PROVISIONING_DETAIL_MAX_LENGTH)
          : undefined
        : frame.status === 'active'
          ? null
          : undefined;
    if (detail === undefined) return 'ignored';
    const existing = await deps.agentSessions.get(frame.sessionId);
    if (!existing || existing.status === 'closed') return 'ignored';
    if (existing.nodeId !== null && existing.nodeId !== reportingNodeId) {
      deps.logger?.warn(
        { sessionId: frame.sessionId, reportingNodeId, owningNodeId: existing.nodeId },
        'provisioning detail from a non-owning node ignored',
      );
      return 'ignored';
    }
    if (existing.provisioningDetail !== detail) {
      await deps.agentSessions.setProvisioningDetail(frame.sessionId, detail);
    }
    return detail === null ? 'cleared' : 'set';
  } catch (err) {
    deps.logger?.warn({ err, sessionId: frame.sessionId }, 'provisioning detail relay failed');
    return 'ignored';
  }
}

export function makeSessionProvisioningDetailRelay(
  agentSessions: SessionProvisioningDetailRelayDeps['agentSessions'],
  logger?: Logger | null,
): (frame: SessionStatus, reportingNodeId: string) => void {
  return (frame, reportingNodeId) => {
    void handleSessionProvisioningDetail({ agentSessions, logger }, frame, reportingNodeId);
  };
}
