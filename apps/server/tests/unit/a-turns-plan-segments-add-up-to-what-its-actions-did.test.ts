// A TURN'S SEGMENTS ADD UP TO WHAT ITS ACTIONS DID.
//
// One turn runs up to three plan segments, and the runtime folds them together
// with `mergeExecutorRuns`. Every other field that merge carries describes HOW
// THE RUN ENDED, so it takes the LAST segment's value and discards the first's.
// The action-path counts are the one field that does not work that way: they
// describe WHAT THE DEVICE DID, and a turn that failed a step and re-planned
// around it performed the actions of both plans.
//
// ⛔ WHY THIS NEEDS ITS OWN GUARD. Taking the second segment's counts alone is
// the pattern the whole function follows, so it is the natural thing to write —
// and it drops the actions of the SEGMENT THAT WENT WRONG, which is the segment
// a stealth audit is about. The result reads like a turn in which everything
// was configured correctly. No other test calls this function at all.

import { describe, expect, it } from 'vitest';
import type { AgentIntent } from '@driftstack/api-types';
import type { ExecutorRunResult, IntentResult } from '../../src/services/agent-executor.js';
import { mergeExecutorRuns } from '../../src/services/agent-runtime.js';
import {
  emptyAgentActionPathCounts,
  type AgentActionPathCounts,
} from '../../src/services/agent-turn-telemetry.js';

const TAP: AgentIntent = { kind: 'interact', action: 'tap', selector: '#go' };
const OK: IntentResult = { kind: 'success', intent: TAP, summary: 'tapped' };
const BAD: IntentResult = { kind: 'failure', intent: TAP, reason: 'nothing there' };

function counts(patch: (c: AgentActionPathCounts) => void): AgentActionPathCounts {
  const c = emptyAgentActionPathCounts();
  patch(c);
  return c;
}

function run(results: IntentResult[], actionPaths?: AgentActionPathCounts): ExecutorRunResult {
  return {
    results,
    ok: results.every((r) => r.kind === 'success'),
    ...(actionPaths === undefined ? {} : { actionPaths }),
  };
}

/** The segment that went wrong: one tap, by a session with NO behaviour
 *  profile attached, that then failed. */
const FAILED_SEGMENT = (): AgentActionPathCounts =>
  counts((c) => {
    c.actions = 1;
    c.profileAttached.false = 1;
    c.unprofiledByVerb.click = 1;
    c.outcomes.failed = 1;
    c.looks = 1;
    c.resolvers.script = 1;
    c.verdicts.clear = 1;
    c.nextActions.tapped = 1;
  });

/** The re-planned remainder: two taps that worked, with a profile attached. */
const RECOVERED_SEGMENT = (): AgentActionPathCounts =>
  counts((c) => {
    c.actions = 2;
    c.profileAttached.true = 2;
    c.outcomes.ok = 2;
    c.looks = 2;
    c.resolvers.native = 2;
    c.verdicts.clear = 2;
    c.nextActions.tapped = 2;
  });

describe('the action counts of a turn’s plan segments are summed, not replaced', () => {
  it('CRITICAL the segment that FAILED keeps its counts when a re-plan recovers the turn — it is the segment an audit is about', () => {
    const merged = mergeExecutorRuns(
      run([BAD], FAILED_SEGMENT()),
      run([OK, OK], RECOVERED_SEGMENT()),
    );
    expect(merged.actionPaths?.actions).toBe(3);
    // ⛔ NEGATIVE CONTROL for "take the second segment's counts", the pattern
    // every other field of this merge follows. That mutation reports 2 actions,
    // ALL of them profile-attached, and the misconfiguration disappears from
    // the turn — while `ok` stays true and nothing else in the suite moves.
    expect(merged.actionPaths?.profileAttached).toEqual({ true: 2, false: 1, unreported: 0 });
    expect(merged.actionPaths?.unprofiledByVerb.click).toBe(1);
    expect(merged.actionPaths?.outcomes).toEqual({ ok: 2, failed: 1, unknown: 0 });
    // And the mirror mutation, "take the first", is refused by the same arm:
    // neither segment's counts alone can satisfy all three assertions above.
    expect(merged.actionPaths?.resolvers).toEqual({
      native: 2,
      script: 1,
      none: 0,
      unanswered: 0,
    });
    expect(merged.ok).toBe(true);
  });

  it('three segments add up too — a turn may re-plan twice, and the merge is applied again to its own result', () => {
    const merged = mergeExecutorRuns(
      mergeExecutorRuns(run([BAD], FAILED_SEGMENT()), run([BAD], FAILED_SEGMENT())),
      run([OK, OK], RECOVERED_SEGMENT()),
    );
    expect(merged.actionPaths?.actions).toBe(4);
    expect(merged.actionPaths?.profileAttached.false).toBe(2);
    expect(merged.actionPaths?.looks).toBe(4);
  });

  it('CRITICAL merging does not mutate either segment’s counts — the accumulator is fresh, so a segment merged twice cannot double its own numbers', () => {
    const first = run([BAD], FAILED_SEGMENT());
    const second = run([OK, OK], RECOVERED_SEGMENT());
    mergeExecutorRuns(first, second);
    mergeExecutorRuns(first, second);
    expect(first.actionPaths?.actions).toBe(1);
    expect(second.actionPaths?.actions).toBe(2);
  });

  it('a segment that reported no counts contributes nothing rather than emptying the other’s', () => {
    expect(mergeExecutorRuns(run([BAD], FAILED_SEGMENT()), run([OK])).actionPaths?.actions).toBe(1);
    expect(mergeExecutorRuns(run([BAD]), run([OK], RECOVERED_SEGMENT())).actionPaths?.actions).toBe(
      2,
    );
  });

  it('a turn in which NEITHER segment dispatched an action carries no counts at all — a line of zeroes would read as "every action was fine" rather than "there were none"', () => {
    const merged = mergeExecutorRuns(run([OK]), run([OK]));
    expect(merged.actionPaths).toBeUndefined();
    expect('actionPaths' in merged).toBe(false);
  });
});
