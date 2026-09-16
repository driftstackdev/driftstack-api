import { describe, expect, it, vi } from 'vitest';
import {
  BOUNDED_NODE_LATEST_RELAY_MAX_CONCURRENT,
  BOUNDED_NODE_LATEST_RELAY_MAX_SESSIONS,
  makeBoundedNodeLatestRelay,
} from '../../src/services/bounded-node-latest-relay.js';

interface Frame {
  sessionId: string;
  value: string;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function relayWith(
  process: (frame: Frame, nodeId: string) => Promise<void>,
  coalesce?: (pending: Frame, incoming: Frame) => Frame,
) {
  const onError = vi.fn();
  const onOverflow = vi.fn();
  const relay = makeBoundedNodeLatestRelay({
    getSessionId: (frame: Frame) => frame.sessionId,
    process,
    ...(coalesce === undefined ? {} : { coalesce }),
    onError,
    onOverflow,
  });
  return { onError, onOverflow, relay };
}

describe('makeBoundedNodeLatestRelay', () => {
  it('coalesces repeated pending state to the newest successor while one session is in flight', async () => {
    const first = deferred();
    const seen: string[] = [];
    const process = vi.fn(async (frame: Frame) => {
      seen.push(frame.value);
      if (seen.length === 1) await first.promise;
    });
    const { relay } = relayWith(process);

    relay({ sessionId: 'agt_1', value: 'first' }, 'node-1');
    relay({ sessionId: 'agt_1', value: 'superseded' }, 'node-1');
    relay({ sessionId: 'agt_1', value: 'latest' }, 'node-1');

    expect(seen).toEqual(['first']);
    first.resolve();
    await vi.waitFor(() => expect(seen).toEqual(['first', 'latest']));
    expect(process).toHaveBeenCalledTimes(2);
  });

  // ── opt-in append-feed fold (session-network-log-relay) ───────────────────
  // The arm above is the DEFAULT and must stay the default: a state feed whose
  // frame carries the whole current state loses nothing to a replace. An APPEND
  // feed does — its queued rows exist nowhere else — so it supplies `coalesce`.

  it('folds a queued frame into its successor when the caller supplies coalesce (append feed)', async () => {
    const first = deferred();
    const seen: string[] = [];
    const process = vi.fn(async (frame: Frame) => {
      seen.push(frame.value);
      if (seen.length === 1) await first.promise;
    });
    const { relay } = relayWith(process, (pending, incoming) => ({
      sessionId: pending.sessionId,
      value: `${pending.value}+${incoming.value}`,
    }));

    relay({ sessionId: 'agt_1', value: 'first' }, 'node-1');
    relay({ sessionId: 'agt_1', value: 'second' }, 'node-1');
    relay({ sessionId: 'agt_1', value: 'third' }, 'node-1');

    expect(seen).toEqual(['first']);
    first.resolve();
    // 'second' is NOT superseded: it is folded with 'third', older first, so the
    // producer's order survives the burst.
    await vi.waitFor(() => expect(seen).toEqual(['first', 'second+third']));
    expect(process).toHaveBeenCalledTimes(2);
  });

  it('does NOT call coalesce for a frame that is merely in flight (nothing is superseded there)', async () => {
    const first = deferred();
    const seen: string[] = [];
    const process = vi.fn(async (frame: Frame) => {
      seen.push(frame.value);
      if (seen.length === 1) await first.promise;
    });
    const coalesce = vi.fn((pending: Frame, incoming: Frame) => ({
      sessionId: pending.sessionId,
      value: `${pending.value}+${incoming.value}`,
    }));
    const { relay } = relayWith(process, coalesce);

    relay({ sessionId: 'agt_1', value: 'first' }, 'node-1');
    relay({ sessionId: 'agt_1', value: 'second' }, 'node-1');

    first.resolve();
    await vi.waitFor(() => expect(seen).toEqual(['first', 'second']));
    // The in-flight frame is already being processed — folding its successor
    // into it would REPLAY rows the store has taken.
    expect(coalesce).not.toHaveBeenCalled();
  });

  it('contains a throwing coalesce, keeps the newest frame, and reports WHAT THE FAILED FOLD DESTROYED', async () => {
    const first = deferred();
    const seen: string[] = [];
    const process = vi.fn(async (frame: Frame) => {
      seen.push(frame.value);
      if (seen.length === 1) await first.promise;
    });
    const { onError, relay } = relayWith(process, () => {
      throw new Error('drop counter/logger failed');
    });

    expect(() => {
      relay({ sessionId: 'agt_1', value: 'first' }, 'node-1');
      relay({ sessionId: 'agt_1', value: 'second' }, 'node-1');
      relay({ sessionId: 'agt_1', value: 'third' }, 'node-1');
    }).not.toThrow();

    first.resolve();
    // Degrades to the default latest-state behaviour — no worse than a relay
    // without `coalesce`, and never a throw into the synchronous receive loop.
    await vi.waitFor(() => expect(seen).toEqual(['first', 'third']));
    // ⛔ THE ROWS, NOT JUST THE FACT. Asserting only that onError fired blesses a
    // silent loss: this fallback destroys the whole QUEUED frame, and for an
    // append feed those rows are the only copy that ever existed. The caller
    // cannot count a drop it was never told about, so the primitive must hand
    // back what it threw away. 'second' is that frame; 'third' survives as
    // `frame`, which is NOT a substitute — it is the rows that did not get lost.
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        discardedQueued: { sessionId: 'agt_1', value: 'second' },
        frame: { sessionId: 'agt_1', value: 'third' },
        reportingNodeId: 'node-1',
        sessionId: 'agt_1',
      }),
    );
  });

  it('VACUITY CONTROL: a SUCCEEDING fold reports nothing — discardedQueued marks the degraded path only', async () => {
    // Without this, the arm above would pass just as happily if the primitive
    // reported every fold as a discard, which would turn the healthy path into a
    // permanent phantom drop count in the caller's register.
    const first = deferred();
    const seen: string[] = [];
    const process = vi.fn(async (frame: Frame) => {
      seen.push(frame.value);
      if (seen.length === 1) await first.promise;
    });
    const { onError, relay } = relayWith(process, (pending, incoming) => ({
      sessionId: pending.sessionId,
      value: `${pending.value}+${incoming.value}`,
    }));

    relay({ sessionId: 'agt_1', value: 'first' }, 'node-1');
    relay({ sessionId: 'agt_1', value: 'second' }, 'node-1');
    relay({ sessionId: 'agt_1', value: 'third' }, 'node-1');

    first.resolve();
    await vi.waitFor(() => expect(seen).toEqual(['first', 'second+third']));
    expect(onError).not.toHaveBeenCalled();
  });

  it('caps concurrent ownership/persistence work independently for each reporting node', () => {
    const process = vi.fn((_frame: Frame, _nodeId: string) => new Promise<void>(() => undefined));
    const { relay } = relayWith(process);

    for (const nodeId of ['node-1', 'node-2']) {
      for (let i = 0; i < BOUNDED_NODE_LATEST_RELAY_MAX_CONCURRENT + 3; i += 1) {
        relay({ sessionId: `${nodeId}-agt-${i}`, value: 'state' }, nodeId);
      }
    }

    expect(process).toHaveBeenCalledTimes(BOUNDED_NODE_LATEST_RELAY_MAX_CONCURRENT * 2);
    expect(process.mock.calls.filter((call) => call[1] === 'node-1')).toHaveLength(
      BOUNDED_NODE_LATEST_RELAY_MAX_CONCURRENT,
    );
    expect(process.mock.calls.filter((call) => call[1] === 'node-2')).toHaveLength(
      BOUNDED_NODE_LATEST_RELAY_MAX_CONCURRENT,
    );
  });

  it('sheds unique-session overflow before work and reports saturation only once', () => {
    const process = vi.fn(() => new Promise<void>(() => undefined));
    const { onOverflow, relay } = relayWith(process);

    for (let i = 0; i < BOUNDED_NODE_LATEST_RELAY_MAX_SESSIONS; i += 1) {
      relay({ sessionId: `agt_${i}`, value: 'state' }, 'node-1');
    }
    relay({ sessionId: 'agt_overflow_1', value: 'state' }, 'node-1');
    relay({ sessionId: 'agt_overflow_2', value: 'state' }, 'node-1');

    expect(process).toHaveBeenCalledTimes(BOUNDED_NODE_LATEST_RELAY_MAX_CONCURRENT);
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(onOverflow).toHaveBeenCalledWith(
      expect.objectContaining({
        reportingNodeId: 'node-1',
        sessionBudget: BOUNDED_NODE_LATEST_RELAY_MAX_SESSIONS,
        sessionId: 'agt_overflow_1',
      }),
    );
  });

  it('contains a failed item and continues draining queued work', async () => {
    const processed: string[] = [];
    const process = vi.fn((frame: Frame) => {
      processed.push(frame.sessionId);
      if (frame.sessionId === 'agt_fail') return Promise.reject(new Error('db unavailable'));
      return Promise.resolve();
    });
    const { onError, relay } = relayWith(process);

    relay({ sessionId: 'agt_fail', value: 'state' }, 'node-1');
    relay({ sessionId: 'agt_ok', value: 'state' }, 'node-1');

    await vi.waitFor(() => expect(processed).toEqual(['agt_fail', 'agt_ok']));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ reportingNodeId: 'node-1', sessionId: 'agt_fail' }),
    );
  });

  it('contains a synchronous processor throw and drains the newest same-session successor', async () => {
    const seen: string[] = [];
    const processFrame = vi.fn((frame: Frame): Promise<void> => {
      seen.push(frame.value);
      if (frame.value === 'throws') throw new Error('synchronous adapter failure');
      return Promise.resolve();
    });
    const { onError, relay } = relayWith(processFrame);

    expect(() => {
      relay({ sessionId: 'agt_1', value: 'throws' }, 'node-1');
      relay({ sessionId: 'agt_1', value: 'successor' }, 'node-1');
    }).not.toThrow();

    await vi.waitFor(() => expect(seen).toEqual(['throws', 'successor']));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ reportingNodeId: 'node-1', sessionId: 'agt_1' }),
    );
  });

  it('contains a throwing error observer, releases the slot, and emits no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const values: string[] = [];
    const processFrame = vi.fn((frame: Frame) => {
      values.push(frame.value);
      return frame.value === 'reject'
        ? Promise.reject(new Error('processor rejected'))
        : Promise.resolve();
    });
    const onError = vi.fn(() => {
      throw new Error('logger failed');
    });
    const relay = makeBoundedNodeLatestRelay({
      getSessionId: (frame: Frame) => frame.sessionId,
      process: processFrame,
      onError,
      onOverflow: vi.fn(),
    });

    try {
      relay({ sessionId: 'agt_1', value: 'reject' }, 'node-1');
      relay({ sessionId: 'agt_1', value: 'successor' }, 'node-1');
      await vi.waitFor(() => expect(values).toEqual(['reject', 'successor']));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(onError).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('contains a throwing overflow observer without starting overflow work', async () => {
    const processFrame = vi.fn(() => new Promise<void>(() => undefined));
    const onOverflow = vi.fn(() => {
      throw new Error('overflow logger failed');
    });
    const relay = makeBoundedNodeLatestRelay({
      getSessionId: (frame: Frame) => frame.sessionId,
      process: processFrame,
      onError: vi.fn(),
      onOverflow,
    });
    for (let i = 0; i < BOUNDED_NODE_LATEST_RELAY_MAX_SESSIONS; i += 1) {
      relay({ sessionId: `agt_${i}`, value: 'state' }, 'node-1');
    }

    expect(() => relay({ sessionId: 'agt_overflow', value: 'state' }, 'node-1')).not.toThrow();
    expect(onOverflow).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(processFrame).toHaveBeenCalledTimes(BOUNDED_NODE_LATEST_RELAY_MAX_CONCURRENT),
    );
  });
});
