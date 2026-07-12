// Cross-node session-ownership guard (audit M1, mirrors agent-session-terminal-close
// #5). Inbound fleet frames (challengeDetected / profileSaveFailed / pageState)
// resolve their target session purely from the attacker-controllable
// `frame.sessionId`. A compromised or buggy fleet NODE could therefore inject
// events into ANOTHER customer's session (spoof webhooks / fake the live page
// overlay). The fleet-control-registry now threads the connection's
// JWT-authenticated `reportingNodeId` to these consumers; this predicate is the
// shared gate they apply before relaying/storing.

/**
 * True when a frame must be DROPPED because the reporting node is NOT the
 * session's owning node. An authenticated fleet frame requires exact equality:
 * NULL/undefined node ownership proves no connected node owns the session, so a
 * reporting node must not be allowed to target it. An absent reportingNodeId is
 * retained only for legacy callers that do not enter through FleetControlRegistry.
 */
export function isCrossNodeSpoof(
  sessionNodeId: string | null | undefined,
  reportingNodeId: string | undefined,
): boolean {
  return reportingNodeId !== undefined && sessionNodeId !== reportingNodeId;
}
