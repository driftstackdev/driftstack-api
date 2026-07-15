import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Room } from '../../src/lib/livekit';
import {
  handleInputAck,
  MAX_PENDING_INPUT_RECEIPTS,
  pendingInputReceiptCount,
  registerInputReceipt,
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

  it('marks an unacknowledged committed boundary timed out at its deadline', () => {
    vi.useFakeTimers();
    const r = room();
    const issues: Array<string | null> = [];
    subscribeInputReceiptIssues(r, (issue) => issues.push(issue));
    registerInputReceipt(r, 'key_1', 5_000);
    vi.advanceTimersByTime(4_999);
    expect(issues).toEqual([null]);
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

  it('bounds pending cardinality and fails visibly instead of growing without limit', () => {
    vi.useFakeTimers();
    const r = room();
    const issues: Array<string | null> = [];
    subscribeInputReceiptIssues(r, (issue) => issues.push(issue));
    for (let i = 0; i <= MAX_PENDING_INPUT_RECEIPTS; i += 1) {
      registerInputReceipt(r, `id_${i}`, 60_000);
    }
    expect(pendingInputReceiptCount(r)).toBe(MAX_PENDING_INPUT_RECEIPTS);
    expect(issues.at(-1)).toBe('timeout');
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
});
