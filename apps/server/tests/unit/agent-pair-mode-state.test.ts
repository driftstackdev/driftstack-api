// Arc 2 sub-slice 8.7 (v2-#8) — pair-mode state-machine tests.

import { describe, expect, it } from 'vitest';
import {
  applyPairModeTransition,
  initialPairModeState,
  PairModeStateInvalidTransitionError,
  type PairModeState,
} from '../../src/services/agent-pair-mode-state.js';

const AT = '2026-05-18T12:00:00Z';
const AT2 = '2026-05-18T12:05:00Z';

describe('Arc 2 v2-#8 sub-slice 8.7 pair-mode state machine', () => {
  it('initial state is ai-driving', () => {
    expect(initialPairModeState()).toEqual({ kind: 'ai-driving' });
  });

  it('happy path: ai-driving → takeover-pending → human-driving → handback-pending → ai-driving', () => {
    let s: PairModeState = initialPairModeState();
    s = applyPairModeTransition(s, { kind: 'takeover-request', clientId: 'cli_a', at: AT });
    expect(s.kind).toBe('takeover-pending');
    if (s.kind === 'takeover-pending') {
      expect(s.requestedByClientId).toBe('cli_a');
    }
    s = applyPairModeTransition(s, { kind: 'takeover-grant', at: AT });
    expect(s.kind).toBe('human-driving');
    if (s.kind === 'human-driving') {
      expect(s.clientId).toBe('cli_a');
      expect(s.sinceAt).toBe(AT);
    }
    s = applyPairModeTransition(s, { kind: 'handback-request', at: AT2 });
    expect(s.kind).toBe('handback-pending');
    if (s.kind === 'handback-pending') {
      expect(s.clientId).toBe('cli_a');
      expect(s.sinceAt).toBe(AT);
    }
    s = applyPairModeTransition(s, { kind: 'handback-complete' });
    expect(s.kind).toBe('ai-driving');
  });

  it('takeover-decline from takeover-pending → ai-driving (rollback)', () => {
    let s: PairModeState = initialPairModeState();
    s = applyPairModeTransition(s, { kind: 'takeover-request', clientId: 'cli_a', at: AT });
    s = applyPairModeTransition(s, { kind: 'takeover-decline' });
    expect(s).toEqual({ kind: 'ai-driving' });
  });

  it('handback-cancel from handback-pending → human-driving (rollback)', () => {
    let s: PairModeState = initialPairModeState();
    s = applyPairModeTransition(s, { kind: 'takeover-request', clientId: 'cli_a', at: AT });
    s = applyPairModeTransition(s, { kind: 'takeover-grant', at: AT });
    s = applyPairModeTransition(s, { kind: 'handback-request', at: AT2 });
    s = applyPairModeTransition(s, { kind: 'handback-cancel' });
    expect(s).toEqual({ kind: 'human-driving', clientId: 'cli_a', sinceAt: AT });
  });

  it('CRITICAL invalid transitions throw PairModeStateInvalidTransitionError with from + transition diagnostics', () => {
    // takeover-grant from ai-driving is invalid (no pending request).
    expect(() =>
      applyPairModeTransition({ kind: 'ai-driving' }, { kind: 'takeover-grant', at: AT }),
    ).toThrow(PairModeStateInvalidTransitionError);

    // handback-request from ai-driving is invalid (no human-driving).
    expect(() =>
      applyPairModeTransition({ kind: 'ai-driving' }, { kind: 'handback-request', at: AT }),
    ).toThrow(PairModeStateInvalidTransitionError);

    // takeover-request while already pending is invalid.
    expect(() =>
      applyPairModeTransition(
        { kind: 'takeover-pending', requestedByClientId: 'cli_a', requestedAt: AT },
        { kind: 'takeover-request', clientId: 'cli_b', at: AT },
      ),
    ).toThrow(PairModeStateInvalidTransitionError);

    // handback-complete from ai-driving is invalid.
    expect(() =>
      applyPairModeTransition({ kind: 'ai-driving' }, { kind: 'handback-complete' }),
    ).toThrow(PairModeStateInvalidTransitionError);
  });

  // Arc 4 Wave 2.A sub-slice 8.11 (v2-#8) — takeover-during-runTurn
  // edge case. The state machine has a new intermediate state
  // 'takeover-queued' that holds a request until decompose settles.
  it('v2-#8 sub-slice 8.11 takeover-request-queued from ai-driving → takeover-queued (carries clientId + queuedAt)', () => {
    const s = applyPairModeTransition(
      { kind: 'ai-driving' },
      { kind: 'takeover-request-queued', clientId: 'cli_a', at: AT },
    );
    expect(s.kind).toBe('takeover-queued');
    if (s.kind === 'takeover-queued') {
      expect(s.requestedByClientId).toBe('cli_a');
      expect(s.queuedAt).toBe(AT);
    }
  });

  it('v2-#8 sub-slice 8.11 takeover-queued → takeover-pending on decompose-settled (preserves clientId, uses settle timestamp as requestedAt)', () => {
    let s: PairModeState = applyPairModeTransition(
      { kind: 'ai-driving' },
      { kind: 'takeover-request-queued', clientId: 'cli_a', at: AT },
    );
    s = applyPairModeTransition(s, { kind: 'decompose-settled', at: AT2 });
    expect(s.kind).toBe('takeover-pending');
    if (s.kind === 'takeover-pending') {
      expect(s.requestedByClientId).toBe('cli_a');
      expect(s.requestedAt).toBe(AT2);
    }
  });

  it('v2-#8 sub-slice 8.11 takeover-queued can be declined back to ai-driving (rollback path)', () => {
    let s: PairModeState = applyPairModeTransition(
      { kind: 'ai-driving' },
      { kind: 'takeover-request-queued', clientId: 'cli_a', at: AT },
    );
    s = applyPairModeTransition(s, { kind: 'takeover-decline' });
    expect(s).toEqual({ kind: 'ai-driving' });
  });

  it('v2-#8 sub-slice 8.11 decompose-settled is a silent no-op from any non-queued state — runtime fires it unconditionally per turn settle', () => {
    expect(
      applyPairModeTransition({ kind: 'ai-driving' }, { kind: 'decompose-settled', at: AT }),
    ).toEqual({ kind: 'ai-driving' });
    expect(
      applyPairModeTransition(
        { kind: 'takeover-pending', requestedByClientId: 'cli_a', requestedAt: AT },
        { kind: 'decompose-settled', at: AT2 },
      ).kind,
    ).toBe('takeover-pending');
    expect(
      applyPairModeTransition(
        { kind: 'human-driving', clientId: 'cli_a', sinceAt: AT },
        { kind: 'decompose-settled', at: AT2 },
      ).kind,
    ).toBe('human-driving');
    expect(
      applyPairModeTransition(
        { kind: 'handback-pending', requestedAt: AT },
        { kind: 'decompose-settled', at: AT2 },
      ).kind,
    ).toBe('handback-pending');
  });

  it('v2-#8 sub-slice 8.11 invalid transitions from takeover-queued still throw with diagnostics', () => {
    // takeover-grant from takeover-queued is invalid (grant only applies
    // to the post-settle 'takeover-pending' state).
    expect(() =>
      applyPairModeTransition(
        { kind: 'takeover-queued', requestedByClientId: 'cli_a', queuedAt: AT },
        { kind: 'takeover-grant', at: AT2 },
      ),
    ).toThrow(PairModeStateInvalidTransitionError);
    // handback-request from takeover-queued is invalid.
    expect(() =>
      applyPairModeTransition(
        { kind: 'takeover-queued', requestedByClientId: 'cli_a', queuedAt: AT },
        { kind: 'handback-request', at: AT2 },
      ),
    ).toThrow(PairModeStateInvalidTransitionError);
  });

  // Arc 4 Wave 2.A sub-slice 8.12 (v2-#8) — symmetric handback queue.
  it('v2-#8 sub-slice 8.12 handback-request-queued from human-driving → handback-queued', () => {
    const s = applyPairModeTransition(
      { kind: 'human-driving', clientId: 'cli_a', sinceAt: AT },
      { kind: 'handback-request-queued', clientId: 'cli_a', at: AT2 },
    );
    expect(s.kind).toBe('handback-queued');
    if (s.kind === 'handback-queued') {
      expect(s.queuedByClientId).toBe('cli_a');
      expect(s.queuedAt).toBe(AT2);
      expect(s.sinceAt).toBe(AT);
    }
  });

  it('v2-#8 sub-slice 8.12 handback-queued → handback-pending on decompose-settled', () => {
    let s: PairModeState = {
      kind: 'handback-queued',
      queuedByClientId: 'cli_a',
      queuedAt: AT,
      sinceAt: '2026-05-18T11:00:00Z',
    };
    s = applyPairModeTransition(s, { kind: 'decompose-settled', at: AT2 });
    expect(s.kind).toBe('handback-pending');
    if (s.kind === 'handback-pending') {
      expect(s.requestedAt).toBe(AT2);
      expect(s.clientId).toBe('cli_a');
      expect(s.sinceAt).toBe('2026-05-18T11:00:00Z');
    }
  });

  it('v2-#8 sub-slice 8.12 handback-queued rollback via handback-cancel → human-driving (preserves clientId from queue)', () => {
    let s: PairModeState = {
      kind: 'handback-queued',
      queuedByClientId: 'cli_a',
      queuedAt: AT,
      sinceAt: '2026-05-18T11:00:00Z',
    };
    s = applyPairModeTransition(s, { kind: 'handback-cancel' });
    expect(s.kind).toBe('human-driving');
    if (s.kind === 'human-driving') {
      expect(s.clientId).toBe('cli_a');
      expect(s.sinceAt).toBe('2026-05-18T11:00:00Z');
    }
  });

  it('v2-#8 sub-slice 8.12 invalid transitions from handback-queued still throw with diagnostics (e.g. takeover-request)', () => {
    expect(() =>
      applyPairModeTransition(
        { kind: 'handback-queued', queuedByClientId: 'cli_a', queuedAt: AT },
        { kind: 'takeover-request', clientId: 'cli_b', at: AT2 },
      ),
    ).toThrow(PairModeStateInvalidTransitionError);
  });

  it('v2-#8 sub-slice 8.12 handback-request-queued is invalid from ai-driving / takeover-pending / handback-pending', () => {
    // Only human-driving accepts the queued handback request.
    expect(() =>
      applyPairModeTransition(
        { kind: 'ai-driving' },
        { kind: 'handback-request-queued', clientId: 'cli_a', at: AT },
      ),
    ).toThrow(PairModeStateInvalidTransitionError);
    expect(() =>
      applyPairModeTransition(
        { kind: 'takeover-pending', requestedByClientId: 'cli_a', requestedAt: AT },
        { kind: 'handback-request-queued', clientId: 'cli_a', at: AT2 },
      ),
    ).toThrow(PairModeStateInvalidTransitionError);
    expect(() =>
      applyPairModeTransition(
        { kind: 'handback-pending', requestedAt: AT },
        { kind: 'handback-request-queued', clientId: 'cli_a', at: AT2 },
      ),
    ).toThrow(PairModeStateInvalidTransitionError);
  });

  // Arc 4 Wave 2.A sub-slice 8.13 (v2-#8) — heartbeat-timeout
  // auto-handback. Pure-state transition; the timer that fires it
  // lives in the route/sweep layer.
  it('v2-#8 sub-slice 8.13 heartbeat-timeout from human-driving / takeover-pending / handback-pending → ai-driving', () => {
    expect(
      applyPairModeTransition(
        { kind: 'human-driving', clientId: 'cli_a', sinceAt: AT },
        { kind: 'heartbeat-timeout', at: AT2 },
      ),
    ).toEqual({ kind: 'ai-driving' });
    expect(
      applyPairModeTransition(
        { kind: 'takeover-pending', requestedByClientId: 'cli_a', requestedAt: AT },
        { kind: 'heartbeat-timeout', at: AT2 },
      ),
    ).toEqual({ kind: 'ai-driving' });
    expect(
      applyPairModeTransition(
        { kind: 'handback-pending', requestedAt: AT },
        { kind: 'heartbeat-timeout', at: AT2 },
      ),
    ).toEqual({ kind: 'ai-driving' });
  });

  it('v2-#8 sub-slice 8.13 heartbeat-timeout from queued states discards the queue → ai-driving', () => {
    expect(
      applyPairModeTransition(
        { kind: 'takeover-queued', requestedByClientId: 'cli_a', queuedAt: AT },
        { kind: 'heartbeat-timeout', at: AT2 },
      ),
    ).toEqual({ kind: 'ai-driving' });
    expect(
      applyPairModeTransition(
        { kind: 'handback-queued', queuedByClientId: 'cli_a', queuedAt: AT },
        { kind: 'heartbeat-timeout', at: AT2 },
      ),
    ).toEqual({ kind: 'ai-driving' });
  });

  it('v2-#8 sub-slice 8.13 heartbeat-timeout from ai-driving is idempotent (self-loop)', () => {
    expect(
      applyPairModeTransition({ kind: 'ai-driving' }, { kind: 'heartbeat-timeout', at: AT }),
    ).toEqual({ kind: 'ai-driving' });
  });

  // Arc 4 Wave 2.A sub-slice 8.15 (v2-#8) — exhaustive invalid-
  // transition coverage. 409-not-silent-noop is binding: every
  // semantically-wrong transition MUST throw so the route surface
  // returns a typed PairModeStateInvalidTransition 409 instead of
  // silently swallowing.
  it('v2-#8 sub-slice 8.15 takeover-request from human-driving is invalid (already human-driven)', () => {
    expect(() =>
      applyPairModeTransition(
        { kind: 'human-driving', clientId: 'cli_a', sinceAt: AT },
        { kind: 'takeover-request', clientId: 'cli_b', at: AT2 },
      ),
    ).toThrow(PairModeStateInvalidTransitionError);
  });

  it('v2-#8 sub-slice 8.15 takeover-grant from ai-driving is invalid (no pending request to grant)', () => {
    expect(() =>
      applyPairModeTransition({ kind: 'ai-driving' }, { kind: 'takeover-grant', at: AT }),
    ).toThrow(PairModeStateInvalidTransitionError);
  });

  it('v2-#8 sub-slice 8.15 handback-request from takeover-pending is invalid (no human-driving yet)', () => {
    expect(() =>
      applyPairModeTransition(
        { kind: 'takeover-pending', requestedByClientId: 'cli_a', requestedAt: AT },
        { kind: 'handback-request', at: AT2 },
      ),
    ).toThrow(PairModeStateInvalidTransitionError);
  });

  it('v2-#8 sub-slice 8.15 handback-cancel from non-handback states is invalid', () => {
    expect(() =>
      applyPairModeTransition({ kind: 'ai-driving' }, { kind: 'handback-cancel' }),
    ).toThrow(PairModeStateInvalidTransitionError);
    expect(() =>
      applyPairModeTransition(
        { kind: 'human-driving', clientId: 'cli_a', sinceAt: AT },
        { kind: 'handback-cancel' },
      ),
    ).toThrow(PairModeStateInvalidTransitionError);
  });

  it('v2-#8 sub-slice 8.15 takeover-decline from non-takeover states is invalid', () => {
    expect(() =>
      applyPairModeTransition({ kind: 'ai-driving' }, { kind: 'takeover-decline' }),
    ).toThrow(PairModeStateInvalidTransitionError);
    expect(() =>
      applyPairModeTransition(
        { kind: 'human-driving', clientId: 'cli_a', sinceAt: AT },
        { kind: 'takeover-decline' },
      ),
    ).toThrow(PairModeStateInvalidTransitionError);
  });

  it('error carries diagnostic fields (from + transition)', () => {
    try {
      applyPairModeTransition({ kind: 'ai-driving' }, { kind: 'takeover-grant', at: AT });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PairModeStateInvalidTransitionError);
      const e = err as PairModeStateInvalidTransitionError;
      expect(e.from).toBe('ai-driving');
      expect(e.transition).toBe('takeover-grant');
    }
  });
});
