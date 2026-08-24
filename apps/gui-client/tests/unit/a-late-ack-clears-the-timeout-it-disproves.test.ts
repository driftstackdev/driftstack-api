// "Device did not confirm the last input" — shown for inputs the device confirmed.
//
// Reported live: the badge keeps appearing while everything works. Reproduced before
// anything here was written, against the unmodified module:
//
//   three taps, each acked `applied` six seconds after a five-second deadline
//   observed issue stream:  [null, 'timeout', 'timeout', 'timeout']
//
// Every one of those taps WAS applied, and the badge said otherwise for all three.
//
// ── the mechanism ─────────────────────────────────────────────────────────────
//
// `registerInputReceipt` arms a timer. When it fires, the pending entry is DELETED and
// 'timeout' is published. The device's ack then arrives to find no pending entry, and
// `handleInputAck` consumed it inertly — returning true without publishing. Nothing else
// clears the badge, so it stayed until some LATER input both registered and acked inside
// its own deadline.
//
// Which is why this is not a rare race. The deadline is 5s for tap/touchEnd/keyUp, and
// the harness acks only after the session-scoped injector finishes. On a device whose
// round trip is simply slower than that — a heavy page, a busy fleet device — EVERY
// input takes this path, so the badge is on permanently while every input lands. The
// worse the latency, the more confidently it reports a failure that is not happening.
//
// A timeout is a PREDICTION that the device will never answer. The device answering is
// that prediction being disproved, and the fix is to let the disproof through: receipts
// that time out are remembered (bounded exactly like `pending`), and a late ack settles
// against the sequence its timeout was published at.
//
// ⚠️ Deliberately still shown at the deadline. Suppressing the badge until some later
// evidence arrives would be wrong in the other direction — at 5s with no answer, "did
// not confirm" is the honest report. What is wrong is keeping it after the answer.
//
// ⚠️ NOT the cause, checked first: `expireOldest` evicts the oldest pending receipt at
// 128 in flight and reports it as a timeout, which for a healthy fast stream would be a
// false positive too. But receipts are registered only for tap/touchEnd/keyUp/text
// (livekit.ts — moves, wheel and nav are excluded by design), and 128 committed
// boundaries inside one 5s window is ~26 taps/second. Not reachable by a human, so it is
// not what was reported. It takes the same late-ack path anyway, and an arm below holds
// its bound.

import { describe, expect, it, vi } from 'vitest';
import type { Room } from '../../src/lib/livekit';
import {
  handleInputAck,
  MAX_PENDING_INPUT_RECEIPTS,
  pendingInputReceiptCount,
  registerInputReceipt,
  resetInputReceipts,
  subscribeInputReceiptIssues,
  timedOutInputReceiptCount,
} from '../../src/lib/livekit-input-ack';

const room = (): Room => ({}) as Room;

/** The observed badge state, in order, for one Room. */
/**
 * Burn ONE unanswered receipt.
 *
 * A single missing ack no longer raises the badge — an ack can be lost in
 * transit without the input having failed (the harness injects before it acks,
 * and `publishInputAck` drops publish errors with `try?`), so one miss is weak
 * evidence. These arms are about what happens ONCE the badge is up, so they
 * prime the run first and the receipt under test is the miss that trips it.
 * Publishes nothing itself, so `watch` stays clean.
 */
function primeMiss(r: Room): void {
  registerInputReceipt(r, 'prime_miss', 5_000);
  vi.advanceTimersByTime(6_000);
}

function watch(r: Room): Array<string | null> {
  const seen: Array<string | null> = [];
  subscribeInputReceiptIssues(r, (issue) => seen.push(issue));
  return seen;
}

const applied = (id: string): Record<string, string> => ({
  type: 'inputAck',
  id,
  status: 'applied',
});

describe('a late ack clears the timeout it disproves', () => {
  it('CRITICAL an ack INSIDE the deadline still settles normally. Every other arm here reports a badge being CLEARED, and a module that cleared unconditionally — or never raised the badge at all — would satisfy them while being entirely broken. This is the arm that makes the rest mean something.', () => {
    vi.useFakeTimers();
    try {
      const r = room();
      const seen = watch(r);
      registerInputReceipt(r, 'tap_fast', 5_000);
      vi.advanceTimersByTime(100);
      expect(handleInputAck(r, applied('tap_fast'))).toBe(true);
      expect(seen, 'a prompt ack did not settle cleanly').toEqual([null, null]);
      // And the deadline passing afterwards must not resurrect a verdict on a
      // receipt that was already settled.
      vi.advanceTimersByTime(60_000);
      expect(seen.at(-1), 'a settled receipt timed out after the fact').toBe(null);
      resetInputReceipts(r);
    } finally {
      vi.useRealTimers();
    }
  });

  it('CRITICAL a LATE applied ack clears the badge. This is the reported defect: the device answered after the deadline, so the timeout was a wrong prediction, and the answer is the correction. Before the fix the ack was consumed inertly and the badge stayed on for an input that had been applied.', () => {
    vi.useFakeTimers();
    try {
      const r = room();
      const seen = watch(r);
      primeMiss(r);
      registerInputReceipt(r, 'tap_slow', 5_000);
      vi.advanceTimersByTime(6_000);
      expect(seen.at(-1), 'the deadline did not raise the badge — the arm proves nothing').toBe(
        'timeout',
      );

      expect(handleInputAck(r, applied('tap_slow'))).toBe(true);
      expect(
        seen.at(-1),
        'a late applied ack left "Device did not confirm the last input" on screen for an input the device confirmed',
      ).toBe(null);
      resetInputReceipts(r);
    } finally {
      vi.useRealTimers();
    }
  });

  it('CRITICAL a device consistently slower than the deadline does not pin the badge on. This is the reproduction as reported — three taps, each acked six seconds after a five-second deadline. It measured [null, timeout, timeout, timeout] before the fix: the badge never came back down because no input ever acked in time to clear it.', () => {
    vi.useFakeTimers();
    try {
      const r = room();
      const seen = watch(r);
      for (const id of ['tap_a', 'tap_b', 'tap_c']) {
        registerInputReceipt(r, id, 5_000);
        vi.advanceTimersByTime(6_000);
        handleInputAck(r, applied(id));
      }
      expect(
        seen.at(-1),
        `the badge is stuck on after three confirmed inputs: ${JSON.stringify(seen)}`,
      ).toBe(null);
      expect(
        seen.filter((s) => s === null).length,
        'the badge cleared fewer times than the device confirmed inputs',
      ).toBe(4);
      resetInputReceipts(r);
    } finally {
      vi.useRealTimers();
    }
  });

  it('CRITICAL a late dropped/failed ack REPLACES the timeout rather than being ignored. "The device dropped your input" and "the device never answered" are different things to tell someone, and the device just said which one it was — reporting the guess after the fact arrived is the same defect pointed the other way.', () => {
    vi.useFakeTimers();
    try {
      for (const status of ['dropped', 'failed'] as const) {
        const r = room();
        const seen = watch(r);
        primeMiss(r);
        registerInputReceipt(r, `tap_${status}`, 5_000);
        vi.advanceTimersByTime(6_000);
        expect(seen.at(-1)).toBe('timeout');
        handleInputAck(r, { type: 'inputAck', id: `tap_${status}`, status });
        expect(seen.at(-1), `a late ${status} ack was not surfaced`).toBe(status);
        resetInputReceipts(r);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('CRITICAL a late ack cannot overwrite a NEWER settled input. The whole point of the sequence guard is that the badge describes the most recent input; an ack arriving thirty seconds late for a long-superseded tap must not erase a genuine failure the customer is looking at right now.', () => {
    vi.useFakeTimers();
    try {
      const r = room();
      const seen = watch(r);
      primeMiss(r);
      registerInputReceipt(r, 'tap_old', 5_000);
      vi.advanceTimersByTime(6_000);
      expect(seen.at(-1)).toBe('timeout');

      // A newer input fails outright — that is the current, true state.
      registerInputReceipt(r, 'tap_new', 5_000);
      handleInputAck(r, { type: 'inputAck', id: 'tap_new', status: 'failed' });
      expect(seen.at(-1)).toBe('failed');

      // The old tap's ack finally shows up. It is stale news.
      handleInputAck(r, applied('tap_old'));
      expect(seen.at(-1), 'a late ack for a superseded input erased a newer real failure').toBe(
        'failed',
      );
      resetInputReceipts(r);
    } finally {
      vi.useRealTimers();
    }
  });

  it('CRITICAL an ack for an id that was NEVER registered stays inert. The late-ack path is keyed on receipts this client actually issued; if an unknown id could settle the badge, a stray or replayed frame would clear a real failure off the screen.', () => {
    vi.useFakeTimers();
    try {
      const r = room();
      const seen = watch(r);
      primeMiss(r);
      registerInputReceipt(r, 'tap_real', 5_000);
      vi.advanceTimersByTime(6_000);
      expect(seen.at(-1)).toBe('timeout');

      expect(handleInputAck(r, applied('never_issued')), 'the frame was not consumed').toBe(true);
      expect(seen.at(-1), 'an ack for an id this client never issued cleared the badge').toBe(
        'timeout',
      );
      resetInputReceipts(r);
    } finally {
      vi.useRealTimers();
    }
  });

  it('CRITICAL the memory of timed-out receipts is BOUNDED. It is fed by a device that is not answering, which is exactly when unbounded growth would be least noticed — so it is capped like `pending`, and the oldest entries are the ones dropped.', () => {
    vi.useFakeTimers();
    try {
      const r = room();
      const overflow = MAX_PENDING_INPUT_RECEIPTS + 10;
      for (let i = 0; i < overflow; i += 1) registerInputReceipt(r, `tap_bulk_${String(i)}`, 5_000);
      expect(
        pendingInputReceiptCount(r),
        'pending receipts grew past their own bound',
      ).toBeLessThanOrEqual(MAX_PENDING_INPUT_RECEIPTS);
      vi.advanceTimersByTime(6_000);
      expect(pendingInputReceiptCount(r), 'the deadline did not drain pending').toBe(0);
      expect(
        timedOutInputReceiptCount(r),
        'the timed-out memory grew past its bound — an unanswering device leaks here',
      ).toBeLessThanOrEqual(MAX_PENDING_INPUT_RECEIPTS);
      expect(
        timedOutInputReceiptCount(r),
        'nothing was remembered, so the late-ack path has no memory to bound',
      ).toBeGreaterThan(0);

      // The most recent timeouts are still settleable; the oldest have been dropped,
      // which is the bound doing its job rather than a leak.
      const newest = `tap_bulk_${String(overflow - 1)}`;
      const seen = watch(r);
      expect(seen.at(-1)).toBe('timeout');
      handleInputAck(r, applied(newest));
      expect(seen.at(-1), 'the newest timed-out receipt could not be settled late').toBe(null);
      resetInputReceipts(r);
    } finally {
      vi.useRealTimers();
    }
  });

  it('CRITICAL reset forgets the timed-out receipts too. Reset runs when the room binding is torn down, and a receipt from a previous session settling into the new one would report a stale device on a connection it was never sent over.', () => {
    vi.useFakeTimers();
    try {
      const r = room();
      registerInputReceipt(r, 'tap_prev', 5_000);
      vi.advanceTimersByTime(6_000);

      expect(timedOutInputReceiptCount(r), 'the timeout was not remembered').toBe(1);
      resetInputReceipts(r);
      expect(timedOutInputReceiptCount(r), 'reset left the timed-out memory populated').toBe(0);
      const seen = watch(r);
      expect(seen.at(-1), 'reset did not clear the visible issue').toBe(null);

      // The old session's ack arrives after the rebind.
      handleInputAck(r, { type: 'inputAck', id: 'tap_prev', status: 'failed' });
      expect(seen.at(-1), 'a receipt from before the reset settled into the new binding').toBe(
        null,
      );
      resetInputReceipts(r);
    } finally {
      vi.useRealTimers();
    }
  });
});
