// "Device did not confirm the last input" fired on a single unanswered receipt.
//
// A missing ack is not a failed input. The harness INJECTS first and acks
// afterwards, so by the time the 5s deadline expires the tap has already been
// applied. And the ack itself can vanish without anyone noticing:
// `publishInputAck` sends via `try? await publishData(...)`, which silently
// discards BOTH a not-connected error and a bounded-publish timeout — and the
// LiveKit SDK's publish is documented to hang, which is exactly what that
// timeout converts into a throw. Nothing counts those; `inputAckFramesDropped`
// only counts buffer overflow.
//
// So one silent loss accused the customer's device of dropping input it had in
// fact applied, and the badge then stayed up until some later input happened to
// ack — which is the "this keeps coming, very annoying" report.
//
// Calibrating to two consecutive misses does NOT hide an outage: a device that
// genuinely stops answering produces an unbroken run and still trips on the
// second one. What it stops is a lone lost frame being reported as a fault.

import { describe, expect, it, vi } from 'vitest';
import type { Room } from 'livekit-client';
import {
  MISSED_ACKS_BEFORE_ALARM,
  handleInputAck,
  registerInputReceipt,
  resetInputReceipts,
  subscribeInputReceiptIssues,
} from '../../src/lib/livekit-input-ack';

const room = (): Room => ({}) as unknown as Room;

function watch(r: Room): Array<string | null> {
  const seen: Array<string | null> = [];
  subscribeInputReceiptIssues(r, (issue) => seen.push(issue));
  return seen;
}

const applied = (id: string) => ({ type: 'inputAck', id, status: 'applied' }) as const;

/** Register a receipt and let its deadline expire unanswered. */
function missOne(r: Room, id: string): void {
  registerInputReceipt(r, id, 5_000);
  vi.advanceTimersByTime(6_000);
}

describe('one lost ack is not a broken device', () => {
  it('CRITICAL a SINGLE unanswered receipt does not accuse the device. The input was already applied before the ack was even attempted, and the ack can be lost in transit with no error surfaced anywhere.', () => {
    vi.useFakeTimers();
    try {
      const r = room();
      const seen = watch(r);
      missOne(r, 'tap_1');
      expect(seen.at(-1) ?? null, 'a lone lost ack raised the badge').toBe(null);
      resetInputReceipts(r);
    } finally {
      vi.useRealTimers();
    }
  });

  it('CRITICAL a real outage STILL trips it — the second consecutive miss raises the badge, so this calibrates the alarm rather than disabling it', () => {
    vi.useFakeTimers();
    try {
      const r = room();
      const seen = watch(r);
      missOne(r, 'tap_1');
      missOne(r, 'tap_2');
      expect(seen.at(-1), 'a device that answers nothing was never reported').toBe('timeout');
      resetInputReceipts(r);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an ack in between BREAKS the run, so two misses either side of a success stay quiet', () => {
    vi.useFakeTimers();
    try {
      const r = room();
      const seen = watch(r);
      missOne(r, 'tap_1');
      registerInputReceipt(r, 'tap_ok', 5_000);
      handleInputAck(r, applied('tap_ok')); // the link is demonstrably alive
      missOne(r, 'tap_2');
      expect(seen.at(-1), 'isolated misses around a success were reported as an outage').toBe(null);
      resetInputReceipts(r);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a LATE ack also breaks the run — answering slowly is evidence the path works', () => {
    vi.useFakeTimers();
    try {
      const r = room();
      const seen = watch(r);
      missOne(r, 'tap_late');
      handleInputAck(r, applied('tap_late')); // arrives after the deadline
      missOne(r, 'tap_next');
      expect(seen.at(-1), 'a late ack did not count as the device answering').toBe(null);
      resetInputReceipts(r);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the threshold is 2 — high enough to absorb a lost frame, low enough to report a real outage on the next input', () => {
    // Pinned because both directions are a regression: 1 restores the false
    // alarm, and a large value means a genuinely dead device stays unreported
    // through several taps.
    expect(MISSED_ACKS_BEFORE_ALARM).toBe(2);
  });
});
