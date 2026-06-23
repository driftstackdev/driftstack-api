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
 * session's owning node. Drop ONLY on a CONFIRMED mismatch (the row's node_id is
 * set AND differs); a NULL node_id (legacy / never-dispatched / manual session)
 * is ALLOWED, and an absent reportingNodeId (legacy caller / no gate wired) is
 * ALLOWED — so neither path regresses a legitimate relay. Identical predicate to
 * the terminal-close guard so the whole fleet-inbound boundary is consistent.
 */
export function isCrossNodeSpoof(
  sessionNodeId: string | null | undefined,
  reportingNodeId: string | undefined,
): boolean {
  return (
    reportingNodeId !== undefined &&
    sessionNodeId !== null &&
    sessionNodeId !== undefined &&
    sessionNodeId !== reportingNodeId
  );
}
