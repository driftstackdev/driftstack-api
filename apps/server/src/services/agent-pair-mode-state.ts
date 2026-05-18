// Arc 2 sub-slice 8.7 (v2-#8 AI chat + manual side-by-side).
//
// Pure pair-mode state machine. Lives separate from AgentSessionsRepo
// so transitions can be tested without an actor boundary. The route
// layer (sub-slice 8.9) wraps these helpers with a Redis lock
// (sub-slice 8.8) and persists results via
// AgentSessionsRepo.setPairModeState.
//
// States + transitions (founder verdict 2026-05-18 implicit in the
// queue spec; Wave 2.A 8.11 adds the mid-runTurn queue path):
//
//   ai-driving         ── takeover-request          ─→  takeover-pending
//   ai-driving         ── takeover-request-queued   ─→  takeover-queued     (Wave 2.A 8.11)
//   takeover-queued    ── decompose-settled         ─→  takeover-pending    (Wave 2.A 8.11)
//   takeover-queued    ── takeover-decline          ─→  ai-driving          (Wave 2.A 8.11)
//   takeover-pending   ── takeover-grant            ─→  human-driving
//   human-driving      ── handback-request          ─→  handback-pending
//   handback-pending   ── handback-complete         ─→  ai-driving
//
// Cancellation paths return to the prior state if the request was
// declined; explicit `takeover-decline` / `handback-cancel` transitions
// handle the rollback. Any other transition throws
// PairModeStateInvalidTransitionError (sub-slice 8.10 surfaces it
// as a typed SDK error).

export type PairModeState =
  | { kind: 'ai-driving' }
  | { kind: 'takeover-pending'; requestedByClientId: string; requestedAt: string }
  | { kind: 'human-driving'; clientId: string; sinceAt: string }
  | { kind: 'handback-pending'; requestedAt: string }
  /**
   * Arc 4 Wave 2.A sub-slice 8.11 (v2-#8) — intermediate state when a
   * takeover request lands while AgentRuntime.runTurn is mid-flight
   * (decompose still resolving). The state machine holds the request
   * here until the runtime fires `decompose-settled`, at which point
   * the queued request flows through to `takeover-pending`. SSE
   * subscribers see this discriminator so the dashboard can render
   * "takeover queued — waiting for the current AI turn to finish".
   * The route layer also emits a synthetic transcript entry with
   * `body: 'takeover queued'` so the dashboard shows context even
   * without subscribing to the state-only event stream.
   */
  | { kind: 'takeover-queued'; requestedByClientId: string; queuedAt: string };

export type PairModeTransition =
  | { kind: 'takeover-request'; clientId: string; at: string }
  | { kind: 'takeover-grant'; at: string }
  | { kind: 'takeover-decline' }
  | { kind: 'handback-request'; at: string }
  | { kind: 'handback-complete' }
  | { kind: 'handback-cancel' }
  /**
   * Arc 4 Wave 2.A sub-slice 8.11 — fired by the route layer when a
   * takeover request arrives while decompose_in_flight=true. The
   * state machine is pure; the runtime separately knows about
   * decompose state and decides which transition to fire.
   */
  | { kind: 'takeover-request-queued'; clientId: string; at: string }
  /**
   * Arc 4 Wave 2.A sub-slice 8.11 — fired by AgentRuntime when the
   * in-flight decompose settles (plan-executed / clarify / refuse /
   * runtime-error / transient-retry-fallback). Promotes a queued
   * takeover to takeover-pending.
   */
  | { kind: 'decompose-settled'; at: string };

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
      if (transition.kind === 'takeover-request-queued') {
        // Arc 4 Wave 2.A sub-slice 8.11 — defer the takeover until
        // decompose settles. The runtime's settle path fires
        // 'decompose-settled' which moves us forward.
        return {
          kind: 'takeover-queued',
          requestedByClientId: transition.clientId,
          queuedAt: transition.at,
        };
      }
      // 'decompose-settled' is a silent no-op from ai-driving — the
      // runtime always fires it on decompose completion regardless of
      // whether a queue exists, so accepting it here keeps the wire
      // contract simple (the route doesn't have to inspect state
      // before firing). Same idempotent posture as queue-decline below.
      if (transition.kind === 'decompose-settled') return state;
      throw new PairModeStateInvalidTransitionError(state.kind, transition.kind);

    case 'takeover-queued':
      // Arc 4 Wave 2.A sub-slice 8.11 — only two transitions out:
      // promote on decompose settle, or rollback on decline.
      if (transition.kind === 'decompose-settled') {
        return {
          kind: 'takeover-pending',
          requestedByClientId: state.requestedByClientId,
          requestedAt: transition.at,
        };
      }
      if (transition.kind === 'takeover-decline') {
        return { kind: 'ai-driving' };
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
      // Arc 4 Wave 2.A 8.11 — silent no-op so the runtime can fire
      // unconditionally without inspecting state.
      if (transition.kind === 'decompose-settled') return state;
      throw new PairModeStateInvalidTransitionError(state.kind, transition.kind);

    case 'human-driving':
      if (transition.kind === 'handback-request') {
        return { kind: 'handback-pending', requestedAt: transition.at };
      }
      if (transition.kind === 'decompose-settled') return state;
      throw new PairModeStateInvalidTransitionError(state.kind, transition.kind);

    case 'handback-pending':
      if (transition.kind === 'handback-complete') {
        return { kind: 'ai-driving' };
      }
      if (transition.kind === 'decompose-settled') return state;
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
