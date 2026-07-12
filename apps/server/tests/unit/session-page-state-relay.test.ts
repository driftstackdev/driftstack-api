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

  it('preserves per-session ORDER even when the first frame lookup resolves SLOWER than the second (no stale clobber)', async () => {
    const store = new SessionPageStateStore();
    // First lookup is deliberately slow, second is fast — without per-session
    // chaining the fast 'loaded' would land first and the slow 'loading' would
    // clobber it. With chaining, frame 1 fully applies before frame 2 is looked
    // up, so the final stored state is the NEWER frame ('loaded').
    let call = 0;
    const sessions = {
      get: vi.fn().mockImplementation(() => {
        call += 1;
        const delayMs = call === 1 ? 30 : 0; // frame 1 slow, frame 2 fast
        return new Promise((resolve) => setTimeout(() => resolve({ nodeId: 'node-1' }), delayMs));
      }),
    };
    const relay = makeSessionPageStateRelay(sessions, store, logger);
    const loading: PageStateFrame = {
      type: 'pageState',
      sessionId: 'agt_1',
      state: 'loading',
      url: 'https://example.com',
    };
    const loaded: PageStateFrame = {
      type: 'pageState',
      sessionId: 'agt_1',
      state: 'loaded',
      url: 'https://example.com',
    };
    relay(loading, 'node-1');
    relay(loaded, 'node-1');
    await new Promise((r) => setTimeout(r, 60));
    // The newer frame wins; the older slow one did NOT overwrite it.
    expect(store.get('agt_1')?.state).toBe('loaded');
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
