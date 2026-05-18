// Arc 2 sub-slice 8.7 (v2-#8 AI chat + manual side-by-side).
//
// Pure 4-state pair-mode state machine. Lives separate from
// AgentSessionsRepo so transitions can be tested without an actor
// boundary. The route layer (sub-slice 8.9) wraps these helpers with
// a Redis lock (sub-slice 8.8) and persists results via
// AgentSessionsRepo.setPairModeState.
//
// States + transitions (founder verdict 2026-05-18 implicit in the
// queue spec):
//
//   ai-driving         ── takeover-request ─→  takeover-pending
//   takeover-pending   ── takeover-grant   ─→  human-driving
//   human-driving      ── handback-request ─→  handback-pending
//   handback-pending   ── handback-complete ─→ ai-driving
//
// Cancellation paths return to the prior state if the request was
// declined; explicit `cancelTakeover` / `cancelHandback` transitions
// handle the rollback. Any other transition throws
// PairModeStateInvalidTransitionError (sub-slice 8.10 surfaces it
// as a typed SDK error).

export type PairModeState =
  | { kind: 'ai-driving' }
  | { kind: 'takeover-pending'; requestedByClientId: string; requestedAt: string }
  | { kind: 'human-driving'; clientId: string; sinceAt: string }
  | { kind: 'handback-pending'; requestedAt: string };

export type PairModeTransition =
  | { kind: 'takeover-request'; clientId: string; at: string }
  | { kind: 'takeover-grant'; at: string }
  | { kind: 'takeover-decline' }
  | { kind: 'handback-request'; at: string }
  | { kind: 'handback-complete' }
  | { kind: 'handback-cancel' };

export class PairModeStateInvalidTransitionError extends Error {
  constructor(
    public readonly from: PairModeState['kind'],
    public readonly transition: PairModeTransition['kind'],
  ) {
    super(`Invalid pair-mode transition: ${transition} not allowed from ${from}`);
    this.name = 'PairModeStateInvalidTransitionError';
  }
}

export function initialPairModeState(): PairModeState {
  return { kind: 'ai-driving' };
}

/** Pure transition reducer. Throws on invalid transitions; the
 *  caller (route layer) catches + maps to a 409 Conflict via
 *  PairModeStateInvalidTransitionError in the SDK error catalog. */
export function applyPairModeTransition(
  state: PairModeState,
  transition: PairModeTransition,
): PairModeState {
  switch (state.kind) {
    case 'ai-driving':
      if (transition.kind === 'takeover-request') {
        return {
          kind: 'takeover-pending',
          requestedByClientId: transition.clientId,
          requestedAt: transition.at,
        };
      }
      throw new PairModeStateInvalidTransitionError(state.kind, transition.kind);

    case 'takeover-pending':
      if (transition.kind === 'takeover-grant') {
        return {
          kind: 'human-driving',
          clientId: state.requestedByClientId,
          sinceAt: transition.at,
        };
      }
      if (transition.kind === 'takeover-decline') {
        return { kind: 'ai-driving' };
      }
      throw new PairModeStateInvalidTransitionError(state.kind, transition.kind);

    case 'human-driving':
      if (transition.kind === 'handback-request') {
        return { kind: 'handback-pending', requestedAt: transition.at };
      }
      throw new PairModeStateInvalidTransitionError(state.kind, transition.kind);

    case 'handback-pending':
      if (transition.kind === 'handback-complete') {
        return { kind: 'ai-driving' };
      }
      if (transition.kind === 'handback-cancel') {
        // Cancel a pending handback — go back to human-driving. The
        // clientId from the prior human-driving state isn't recoverable
        // from the handback-pending payload, so we mark it 'unknown'.
        // Callers must track the active client separately when they
        // care; the state machine itself is concerned with mode
        // transitions, not session attribution.
        return { kind: 'human-driving', clientId: 'unknown', sinceAt: state.requestedAt };
      }
      throw new PairModeStateInvalidTransitionError(state.kind, transition.kind);
  }
}
