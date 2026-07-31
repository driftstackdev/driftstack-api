// Every intent kind is explicitly classified as replay-safe or not.
//
// `intentReplayMayDuplicateEffect` decides whether the executor may auto-retry
// an intent after a coarse WebDriver or dispatch failure — the failure class
// that, by the harness's own design, cannot distinguish "never applied" from
// "applied, result lost". Say an intent is replay-safe when it is not and the
// retry drives a real browser into repeating the action: a second form
// submission, a second purchase, a second transfer, on a customer's account.
//
// The predicate used to enumerate the EFFECTFUL kinds, which meant a kind added
// later was replay-safe by omission and silently became auto-retryable. It now
// enumerates the SAFE kinds instead, so an unrecognised kind fails safe. Today's
// six kinds are classified exactly as before — this changed nothing at the time
// it landed and changes the default for whatever is added next.
//
// The existing `agent-intent-result` suite spot-checks a few kinds. That cannot
// catch an unclassified NEW kind, because the assertion has to name the kind to
// test it. This derives the roster from the canonical `AgentIntentSchema` union
// so the check is about the kinds that exist, not the kinds someone remembered.

import { describe, expect, it } from 'vitest';

import { AgentIntentSchema } from '../../../../packages/api-types/src/agent-intents.js';
import { intentReplayMayDuplicateEffect } from '../../src/services/agent-intent-result.js';
import type { AgentIntent } from '../../src/services/agent-decomposer.js';

/**
 * Kinds whose replay cannot duplicate an effect, each with the reason it is
 * safe. Mirrors the allowlist in the implementation; the point of restating it
 * here is that the two must agree, and drifting apart is what this file fails
 * on.
 */
const EXPECTED_REPLAY_SAFE: Record<string, string> = {
  capture: 'Reads page state (screenshot / dom_snapshot / pdf). Changes nothing.',
  wait: 'Carries its own internal timeout; re-waiting alters no page state.',
};

/** The canonical union, read off the discriminated union rather than hand-listed. */
function intentKinds(): string[] {
  return AgentIntentSchema.options
    .map((opt) => {
      const shape = opt.shape as { kind?: { value?: unknown } };
      return typeof shape.kind?.value === 'string' ? shape.kind.value : null;
    })
    .filter((k): k is string => k !== null)
    .sort();
}

/** A minimal valid-enough instance for each kind; only `kind` is read. */
function sample(kind: string): AgentIntent {
  return { kind } as unknown as AgentIntent;
}

describe('every intent kind is explicitly classified for replay safety', () => {
  const KINDS = intentKinds();

  it('CRITICAL the canonical union was actually read. An empty or broken enumeration would make every check below vacuous — and this file exists precisely because a check that names its own inputs cannot see a new kind.', () => {
    expect(KINDS.length, 'intent kinds on AgentIntentSchema').toBeGreaterThan(3);
    expect(KINDS, 'a known effectful kind must survive the enumeration').toContain('interact');
    expect(KINDS, 'a known safe kind must survive the enumeration').toContain('capture');
  });

  it('CRITICAL every kind the union defines is accounted for. A kind that is neither listed safe here nor treated as effectful is a kind nobody decided about, and the executor would be auto-retrying it.', () => {
    const unclassified = KINDS.filter(
      (kind) =>
        EXPECTED_REPLAY_SAFE[kind] === undefined && !intentReplayMayDuplicateEffect(sample(kind)),
    );
    expect(
      unclassified.sort(),
      'intent kind(s) treated as replay-safe without a stated reason — add the reason to EXPECTED_REPLAY_SAFE, or make the kind effectful:',
    ).toEqual([]);
  });

  it('CRITICAL the safe list and the implementation agree in BOTH directions. A kind documented safe here that the implementation treats as effectful is a stale reason; the reverse is an undocumented exemption.', () => {
    for (const [kind, reason] of Object.entries(EXPECTED_REPLAY_SAFE)) {
      expect(KINDS, `${kind} is listed safe but is not a kind the union defines`).toContain(kind);
      expect(
        intentReplayMayDuplicateEffect(sample(kind)),
        `${kind} is documented replay-safe (${reason}) but the implementation says it may duplicate`,
      ).toBe(false);
    }
  });

  it('CRITICAL an UNRECOGNISED kind is treated as effectful. This is the fail-safe direction: the next intent kind is not auto-retried until someone decides it can be, rather than being auto-retried until someone notices it should not have been.', () => {
    expect(
      intentReplayMayDuplicateEffect(sample('upload_file_that_does_not_exist_yet')),
      'an unknown kind must default to may-duplicate',
    ).toBe(true);
  });

  it('CRITICAL the classification of the kinds that exist today is UNCHANGED by the rewrite. navigate, interact, scroll and behavioral_pause stay effectful; capture and wait stay safe.', () => {
    for (const kind of ['navigate', 'interact', 'scroll', 'behavioral_pause']) {
      expect(intentReplayMayDuplicateEffect(sample(kind)), `${kind} must stay effectful`).toBe(
        true,
      );
    }
    for (const kind of ['capture', 'wait']) {
      expect(intentReplayMayDuplicateEffect(sample(kind)), `${kind} must stay replay-safe`).toBe(
        false,
      );
    }
  });
});
