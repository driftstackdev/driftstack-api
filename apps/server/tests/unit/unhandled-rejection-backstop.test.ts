// #2 — the process-level unhandled-rejection backstop logs + counts a rejection
// instead of crashing the control-plane process.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installUnhandledRejectionBackstop,
  getUnhandledRejectionCount,
  resetUnhandledRejectionCount,
} from '../../src/lib/unhandled-rejection-backstop.js';

describe('installUnhandledRejectionBackstop', () => {
  // Snapshot the listeners present before each test so we can remove only the
  // one(s) this test installs (don't disturb vitest's own handlers).
  let preexisting: Array<(...args: unknown[]) => void> = [];

  afterEach(() => {
    for (const l of process.listeners('unhandledRejection') as Array<(...a: unknown[]) => void>) {
      if (!preexisting.includes(l)) process.off('unhandledRejection', l);
    }
    resetUnhandledRejectionCount();
  });

  it('logs the rejection reason + increments the counter instead of throwing', async () => {
    preexisting = process.listeners('unhandledRejection') as Array<(...a: unknown[]) => void>;
    const logger = { error: vi.fn() };
    installUnhandledRejectionBackstop(logger);

    const before = getUnhandledRejectionCount();
    // Trigger a real unhandled rejection: a rejected promise with no catch.
    void Promise.reject(new Error('boom-from-test'));

    // unhandledRejection fires on the next microtask/tick.
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());

    expect(getUnhandledRejectionCount()).toBe(before + 1);
    const [obj, msg] = logger.error.mock.calls[0]!;
    expect(msg).toMatch(/unhandled promise rejection/);
    expect((obj as { reason: { message?: string } }).reason.message).toBe('boom-from-test');
    expect((obj as { unhandled_rejection_count: number }).unhandled_rejection_count).toBe(
      before + 1,
    );
  });
});
