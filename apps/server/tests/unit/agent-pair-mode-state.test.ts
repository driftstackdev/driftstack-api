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
    expect(s.kind).toBe('human-driving');
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
