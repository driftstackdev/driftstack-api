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

function relayWith(process: (frame: Frame, nodeId: string) => Promise<void>) {
  const onError = vi.fn();
  const onOverflow = vi.fn();
  const relay = makeBoundedNodeLatestRelay({
    getSessionId: (frame: Frame) => frame.sessionId,
    process,
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
