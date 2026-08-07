// audit M1 — makeSessionPageStateRelay gates pageState writes by the reporting
// node's ownership of the session, so a non-owning node can't fake another
// customer's live page overlay (loading bar / error). Unknown and NULL-node
// sessions fail closed and retain no attacker-controlled page strings. Wraps the pure
// SessionPageStateStore (read by GET /v1/agent-sessions/:id/page-state).

import { describe, expect, it, vi } from 'vitest';
import { makeSessionPageStateRelay } from '../../src/services/session-page-state-relay.js';
import { SessionPageStateStore } from '../../src/services/session-page-state-store.js';
import type { PageStateFrame } from '../../src/schemas/harness-control-protocol.js';
import type { Logger } from '../../src/lib/logger.js';

const FRAME: PageStateFrame = {
  type: 'pageState',
  sessionId: 'agt_1',
  state: 'loaded',
  url: 'https://example.com',
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A lookup the TEST decides when to resolve. Lets the ordering tests below pin
 *  the relay's chaining without depending on wall-clock timings — a fixed sleep
 *  turns CPU contention into a spurious failure, and simply widening it hides the
 *  next real regression. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('audit-M1 makeSessionPageStateRelay', () => {
  it('stores the pageState when the reporting node OWNS the session', async () => {
    const store = new SessionPageStateStore();
    const sessions = { get: vi.fn().mockResolvedValue({ nodeId: 'node-1' }) };
    makeSessionPageStateRelay(sessions, store, logger)(FRAME, 'node-1');
    await flush();
    expect(store.get('agt_1')).toEqual({
      state: 'loaded',
      url: 'https://example.com',
      title: null,
      tabId: null,
      error: null,
    });
  });

  it('DROPS the pageState when a NON-owning node reports it (cross-node spoof guard)', async () => {
    const store = new SessionPageStateStore();
    const sessions = { get: vi.fn().mockResolvedValue({ nodeId: 'node-1' }) };
    makeSessionPageStateRelay(sessions, store, logger)(FRAME, 'node-evil');
    await flush();
    expect(store.get('agt_1')).toBeNull();
    expect(store.size).toBe(0);
  });

  it('DROPS a NULL node_id session because no fleet node owns it', async () => {
    const store = new SessionPageStateStore();
    const sessions = { get: vi.fn().mockResolvedValue({ nodeId: null }) };
    makeSessionPageStateRelay(sessions, store, logger)(FRAME, 'node-anything');
    await flush();
    expect(store.get('agt_1')).toBeNull();
    expect(store.size).toBe(0);
  });

  it('DROPS an unknown session instead of retaining attacker-controlled strings', async () => {
    const store = new SessionPageStateStore();
    const sessions = { get: vi.fn().mockResolvedValue(null) };
    makeSessionPageStateRelay(sessions, store, logger)(FRAME, 'node-1');
    await flush();
    expect(store.get('agt_1')).toBeNull();
    expect(store.size).toBe(0);
  });

  it('preserves per-session order and coalesces pending state to the newest frame', async () => {
    const store = new SessionPageStateStore();
    // Frame 1's lookup is held open by the test, so the relay's per-session
    // chaining is observed directly rather than inferred from a race that
    // happened to settle in the expected order. Without chaining the newer
    // 'loaded' would be looked up and applied immediately and frame 1's late
    // result would then clobber it, leaving 'loading' as the final state.
    const first = deferred<{ nodeId: string }>();
    const second = deferred<{ nodeId: string }>();
    let call = 0;
    const sessions = {
      get: vi.fn().mockImplementation(() => {
        call += 1;
        return call === 1 ? first.promise : second.promise;
      }),
    };
    const relay = makeSessionPageStateRelay(sessions, store, logger);
    const frame = (state: PageStateFrame['state']): PageStateFrame => ({
      type: 'pageState',
      sessionId: 'agt_1',
      state,
      url: 'https://example.com',
    });

    relay(frame('loading'), 'node-1');
    relay(frame('stalled'), 'node-1');
    relay(frame('loaded'), 'node-1');

    // Chaining, stated as a fact about the mechanism: while frame 1 is in flight
    // the successor has NOT been looked up, and nothing has been stored.
    await flush();
    expect(sessions.get).toHaveBeenCalledTimes(1);
    expect(store.get('agt_1')).toBeNull();

    first.resolve({ nodeId: 'node-1' });
    await vi.waitFor(() => {
      expect(sessions.get).toHaveBeenCalledTimes(2);
    });
    // Frame 1 fully applied before the successor was even looked up.
    expect(store.get('agt_1')?.state).toBe('loading');

    second.resolve({ nodeId: 'node-1' });
    await vi.waitFor(() => {
      expect(store.get('agt_1')?.state).toBe('loaded');
    });
    // 'stalled' was coalesced away by the newer frame and never looked up: three
    // frames, two lookups.
    expect(sessions.get).toHaveBeenCalledTimes(2);
  });

  it('never throws + does not store when the lookup rejects (fire-and-forget, error-logged)', async () => {
    const store = new SessionPageStateStore();
    const sessions = { get: vi.fn().mockRejectedValue(new Error('db down')) };
    const relay = makeSessionPageStateRelay(sessions, store, logger);
    expect(() => relay(FRAME, 'node-1')).not.toThrow();
    await flush();
    expect(store.get('agt_1')).toBeNull();
  });
});
