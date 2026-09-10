import type { Logger } from '../lib/logger.js';
import type { SessionStatus } from '../schemas/harness-control-protocol.js';
import type { AgentSessionsRepo } from './agent-sessions.js';
import { isCrossNodeSpoof } from './fleet-session-ownership.js';

// (c) 2026-09-10 — records the harness's intermediate `provisioning` detail on the
// agent_sessions row so the customer read can say WHY a session is still
// provisioning ("VPN tunnel connected — starting the browser…") instead of a
// bare "connecting…". The harness (faa38a82d) brings a VPN tunnel up, reports
// `provisioning` + `vpn_egress_active`, and deliberately does NOT claim `active`
// until a browser exists. An `active` (or terminal) frame clears the detail.
//
// Three properties, each the answer to a review finding on the first version:
//   • TOKENS ONLY. The detail is customer-visible on the public read, and the
//     harness also emits provisioning frames whose detail is diagnostic PROSE
//     ("duplicate session assign ignored (idempotent)"). Only a snake_case token
//     is persisted; prose is ignored, so it can neither leak nor overwrite the
//     token the GUI keys on.
//   • FAIL-CLOSED OWNERSHIP, like every sibling relay: a NULL owner proves no
//     connected node owns the session, so no reporting node may describe it.
//   • ORDERED, UNCONDITIONAL CLEARS. The registry fires this fire-and-forget, so
//     `provisioning` and `active` replayed back-to-back (the harness reconnect
//     queue does exactly that) ran concurrently and raced on a read-compare-
//     write, leaving a stale token on a live session. Frames are serialised per
//     session, an `active`/terminal frame always writes null, and a token never
//     lands on a row that is already active or closed.

export const PROVISIONING_DETAIL_MAX_LENGTH = 64;

/** A provisioning detail is a snake_case step TOKEN — `vpn_egress_bringing_up`,
 *  `vpn_egress_active`, `egress_geo_resolving` — never diagnostic prose. */
export const PROVISIONING_DETAIL_TOKEN_RE = /^[a-z][a-z0-9_]{0,63}$/;

export type ProvisioningDetailOutcome = 'set' | 'cleared' | 'ignored';

export interface SessionProvisioningDetailRelayDeps {
  readonly agentSessions: Pick<AgentSessionsRepo, 'get' | 'setProvisioningDetail'>;
  readonly logger?: Logger | null;
}

const CLEARING_STATUSES = new Set(['active', 'ended', 'errored', 'closed']);

export async function handleSessionProvisioningDetail(
  deps: SessionProvisioningDetailRelayDeps,
  frame: SessionStatus,
  reportingNodeId: string,
): Promise<ProvisioningDetailOutcome> {
  try {
    let detail: string | null;
    if (frame.status === 'provisioning') {
      if (typeof frame.detail !== 'string' || !PROVISIONING_DETAIL_TOKEN_RE.test(frame.detail)) {
        return 'ignored';
      }
      detail = frame.detail;
    } else if (CLEARING_STATUSES.has(frame.status)) {
      detail = null;
    } else {
      return 'ignored';
    }
    const existing = await deps.agentSessions.get(frame.sessionId);
    if (!existing) return 'ignored';
    if (isCrossNodeSpoof(existing.nodeId, reportingNodeId)) {
      deps.logger?.warn(
        { sessionId: frame.sessionId, reportingNodeId, owningNodeId: existing.nodeId },
        'provisioning detail from a non-owning node ignored',
      );
      return 'ignored';
    }
    if (detail !== null) {
      // The step is over once the session is active or closed: a late token
      // (an out-of-order replay) must not resurrect "still provisioning".
      if (existing.status === 'active' || existing.status === 'closed') return 'ignored';
      if (existing.provisioningDetail !== detail) {
        await deps.agentSessions.setProvisioningDetail(frame.sessionId, detail);
      }
      return 'set';
    }
    // Unconditional: a clear gated on a pre-read snapshot is exactly the race.
    await deps.agentSessions.setProvisioningDetail(frame.sessionId, null);
    return 'cleared';
  } catch (err) {
    deps.logger?.warn({ err, sessionId: frame.sessionId }, 'provisioning detail relay failed');
    return 'ignored';
  }
}

export function makeSessionProvisioningDetailRelay(
  agentSessions: SessionProvisioningDetailRelayDeps['agentSessions'],
  logger?: Logger | null,
): (frame: SessionStatus, reportingNodeId: string) => void {
  // Per-session serialisation: frames for one session apply in arrival order.
  const chains = new Map<string, Promise<unknown>>();
  return (frame, reportingNodeId) => {
    const prev = chains.get(frame.sessionId) ?? Promise.resolve();
    const next: Promise<unknown> = prev
      .then(() =>
        handleSessionProvisioningDetail({ agentSessions, logger }, frame, reportingNodeId),
      )
      .catch(() => undefined)
      .then(() => {
        if (chains.get(frame.sessionId) === next) chains.delete(frame.sessionId);
      });
    chains.set(frame.sessionId, next);
  };
}
