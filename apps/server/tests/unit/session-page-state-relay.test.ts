// audit M1 — makeSessionPageStateRelay gates pageState writes by the reporting
// node's ownership of the session, so a non-owning node can't fake another
// customer's live page overlay (loading bar / error). An unknown session (no
// row) is still stored (no live session to hijack). Wraps the pure
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

  it('a NULL node_id session (legacy) is NOT gated — stores normally', async () => {
    const store = new SessionPageStateStore();
    const sessions = { get: vi.fn().mockResolvedValue({ nodeId: null }) };
    makeSessionPageStateRelay(sessions, store, logger)(FRAME, 'node-anything');
    await flush();
    expect(store.get('agt_1')).not.toBeNull();
  });

  it('an unknown session (no row — e.g. a late frame after close) is still stored', async () => {
    const store = new SessionPageStateStore();
    const sessions = { get: vi.fn().mockResolvedValue(null) };
    makeSessionPageStateRelay(sessions, store, logger)(FRAME, 'node-1');
    await flush();
    expect(store.get('agt_1')).not.toBeNull();
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
