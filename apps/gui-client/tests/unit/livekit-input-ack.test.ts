import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Room } from '../../src/lib/livekit';
import {
  handleInputAck,
  MAX_PENDING_INPUT_RECEIPTS,
  pendingInputReceiptCount,
  registerInputReceipt,
  rejectedInputAckCounts,
  resetInputReceipts,
  subscribeInputReceiptIssues,
} from '../../src/lib/livekit-input-ack';

const room = (): Room => ({}) as Room;

afterEach(() => {
  vi.useRealTimers();
});

describe('per-Room committed input receipts', () => {
  it('settles only the exact three-key applied acknowledgement for a pending id', () => {
    const r = room();
    const issues: Array<string | null> = [];
    subscribeInputReceiptIssues(r, (issue) => issues.push(issue));
    registerInputReceipt(r, 'tap_1', 10_000);
    expect(pendingInputReceiptCount(r)).toBe(1);
    expect(handleInputAck(r, { type: 'inputAck', id: 'tap_1', status: 'applied' })).toBe(true);
    expect(pendingInputReceiptCount(r)).toBe(0);
    expect(issues).toEqual([null, null]);
  });

  it('surfaces dropped and failed terminal dispositions without exposing payload data', () => {
    const r = room();
    const issues: Array<string | null> = [];
    subscribeInputReceiptIssues(r, (issue) => issues.push(issue));
    registerInputReceipt(r, 'drop_1', 10_000);
    handleInputAck(r, { type: 'inputAck', id: 'drop_1', status: 'dropped' });
    registerInputReceipt(r, 'fail_1', 10_000);
    handleInputAck(r, { type: 'inputAck', id: 'fail_1', status: 'failed' });
    expect(issues).toEqual([null, 'dropped', 'failed']);
  });

  it('does not let an older applied receipt erase a newer failed input', () => {
    const r = room();
    const issues: Array<string | null> = [];
    subscribeInputReceiptIssues(r, (issue) => issues.push(issue));
    registerInputReceipt(r, 'older_1', 10_000);
    registerInputReceipt(r, 'newer_1', 10_000);

    handleInputAck(r, { type: 'inputAck', id: 'newer_1', status: 'failed' });
    handleInputAck(r, { type: 'inputAck', id: 'older_1', status: 'applied' });

    expect(issues).toEqual([null, 'failed']);
    expect(pendingInputReceiptCount(r)).toBe(0);
  });

  it('does not let an older timeout overwrite a newer applied receipt', () => {
    vi.useFakeTimers();
    const r = room();
    const issues: Array<string | null> = [];
    subscribeInputReceiptIssues(r, (issue) => issues.push(issue));
    registerInputReceipt(r, 'older_2', 5_000);
    registerInputReceipt(r, 'newer_2', 10_000);

    handleInputAck(r, { type: 'inputAck', id: 'newer_2', status: 'applied' });
    vi.advanceTimersByTime(5_000);

    expect(issues).toEqual([null, null]);
    expect(pendingInputReceiptCount(r)).toBe(0);
  });

  it('marks an unacknowledged committed boundary timed out at its deadline', () => {
    vi.useFakeTimers();
    const r = room();
    const issues: Array<string | null> = [];
    subscribeInputReceiptIssues(r, (issue) => issues.push(issue));
    // One lost ack is no longer reported — it is weak evidence, because the
    // input is injected BEFORE the ack is attempted and the ack can be dropped
    // in transit unlogged. The badge is calibrated to consecutive misses, so
    // this arm burns one first and then measures the deadline on the second.
    registerInputReceipt(r, 'key_0', 5_000);
    vi.advanceTimersByTime(6_000);
    expect(issues, 'a single miss raised the badge').toEqual([null]);

    registerInputReceipt(r, 'key_1', 5_000);
    vi.advanceTimersByTime(4_999);
    expect(issues, 'the badge rose BEFORE the deadline').toEqual([null]);
    vi.advanceTimersByTime(1);
    expect(issues).toEqual([null, 'timeout']);
    expect(pendingInputReceiptCount(r)).toBe(0);
  });

  it('consumes malformed or late inputAck frames inertly and rejects unrelated frames', () => {
    const r = room();
    registerInputReceipt(r, 'tap_2', 10_000);
    expect(
      handleInputAck(r, {
        type: 'inputAck',
        id: 'tap_2',
        status: 'applied',
        activeTabId: 'must-not-be-accepted',
      }),
    ).toBe(true);
    expect(pendingInputReceiptCount(r)).toBe(1);
    expect(handleInputAck(r, { type: 'page_state', id: 'tap_2', status: 'applied' })).toBe(false);
    expect(handleInputAck(r, { type: 'inputAck', id: 'late_1', status: 'applied' })).toBe(true);
    expect(pendingInputReceiptCount(r)).toBe(1);
    resetInputReceipts(r);
  });

  it('REPORTS a rejected inputAck instead of dropping it silently', () => {
    const r = room();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerInputReceipt(r, 'tap_9', 10_000);

    // Behaviour is UNCHANGED and that is deliberate: a frame claiming `inputAck`
    // while carrying a `tabListUpdate` field is still refused, still leaves the
    // receipt pending. This arm is about what the refusal SAYS, not what it does.
    expect(
      handleInputAck(r, {
        type: 'inputAck',
        id: 'tap_9',
        status: 'applied',
        activeTabId: 'must-not-be-accepted',
      }),
    ).toBe(true);
    expect(pendingInputReceiptCount(r)).toBe(1);

    // The diagnostic that did not exist. `unexpected-fields` is the reason that
    // means PROTOCOL DRIFT — the harness grew a field — as opposed to one bad frame.
    expect(rejectedInputAckCounts(r)).toEqual({ 'unexpected-fields': 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    // The keys are the whole diagnostic: without them a reader knows a frame was
    // refused but not which field is new, which is the only actionable part.
    expect(warn.mock.calls[0]?.[0]).toContain('keys=[activeTabId,id,status,type]');

    // Deduped per reason: a device emitting the drifted frame on EVERY input must
    // not turn the console into the failure. Counter still climbs.
    handleInputAck(r, {
      type: 'inputAck',
      id: 'tap_9',
      status: 'applied',
      activeTabId: 'again',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(rejectedInputAckCounts(r)).toEqual({ 'unexpected-fields': 2 });

    // A different fault is a different reason, and IS worth its own warning.
    handleInputAck(r, { type: 'inputAck', id: 'tap_9', status: 'not-a-status' });
    expect(rejectedInputAckCounts(r)['bad-status']).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2);

    warn.mockRestore();
    resetInputReceipts(r);
  });

  it('bounds pending cardinality and fails visibly instead of growing without limit', () => {
    vi.useFakeTimers();
    const r = room();
    const issues: Array<string | null> = [];
    subscribeInputReceiptIssues(r, (issue) => issues.push(issue));
    // Overflow by TWO. Each eviction is one unanswered receipt, and the badge is
    // calibrated to consecutive misses — so overflowing by one proves the bound
    // holds but no longer proves it is reported, which is the other half of what
    // this arm is named for.
    for (let i = 0; i <= MAX_PENDING_INPUT_RECEIPTS + 1; i += 1) {
      registerInputReceipt(r, `id_${i}`, 60_000);
    }
    expect(pendingInputReceiptCount(r)).toBe(MAX_PENDING_INPUT_RECEIPTS);
    expect(issues.at(-1), 'evictions were silent — the bound held but said nothing').toBe(
      'timeout',
    );
    resetInputReceipts(r);
    expect(pendingInputReceiptCount(r)).toBe(0);
    expect(issues.at(-1)).toBe(null);
  });

  it('ignores invalid ids and clears every timer on ownership reset', () => {
    vi.useFakeTimers();
    const r = room();
    registerInputReceipt(r, 'bad id', 5_000);
    registerInputReceipt(r, 'x'.repeat(65), 5_000);
    registerInputReceipt(r, 'valid_1', 5_000);
    expect(pendingInputReceiptCount(r)).toBe(1);
    resetInputReceipts(r);
    vi.advanceTimersByTime(5_000);
    expect(pendingInputReceiptCount(r)).toBe(0);
  });

  it('reset clears the visible issue and starts a fresh settlement epoch', () => {
    const r = room();
    const issues: Array<string | null> = [];
    subscribeInputReceiptIssues(r, (issue) => issues.push(issue));
    registerInputReceipt(r, 'before_reset', 10_000);
    handleInputAck(r, { type: 'inputAck', id: 'before_reset', status: 'failed' });

    resetInputReceipts(r);
    registerInputReceipt(r, 'after_reset', 10_000);
    handleInputAck(r, { type: 'inputAck', id: 'after_reset', status: 'dropped' });

    expect(issues).toEqual([null, 'failed', null, 'dropped']);
  });
});
