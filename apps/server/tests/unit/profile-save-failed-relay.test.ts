// A3 W1364 — profile save-failure relay. makeProfileSaveFailedRelay resolves
// the owning account from the harness `profileSaveFailed` frame's session id
// and enqueues a `session.profile_save_failed` webhook (the customer-visible
// half of the save-failure asymmetry fix: restore-failure errors the session,
// save-failure was previously ops-stderr-only). Fire-and-forget off the receive
// loop: it must never throw (a thrown handler would crash the node's WS receive
// loop), and an unknown session drops the relay (no webhook). Mirrors
// challenge-relay.test.ts.

import { describe, expect, it, vi } from 'vitest';
import { makeProfileSaveFailedRelay } from '../../src/services/profile-save-failed-relay.js';
import type { ProfileSaveFailed } from '../../src/schemas/harness-control-protocol.js';
import type { Logger } from '../../src/lib/logger.js';

const FRAME: ProfileSaveFailed = {
  type: 'profileSaveFailed',
  sessionId: 'agt_1',
  profile_id: 'prof_1',
  reason: 'upload_failed',
  detail: 'presigned PUT returned 503',
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

// Drain microtasks: the handler is sync void + fire-and-forget (.get().then().
// then()), so settle the chain before asserting.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('A3-W1364 makeProfileSaveFailedRelay', () => {
  it('resolves accountId from the session + enqueues session.profile_save_failed', async () => {
    const sessions = {
      get: vi.fn().mockResolvedValue({ accountId: 'acc_9', nodeId: 'node_1' }),
    };
    const webhooks = { enqueueEvent: vi.fn().mockResolvedValue(2) };
    const relay = makeProfileSaveFailedRelay(sessions, webhooks, logger);
    relay(FRAME, 'node_1');
    await flush();
    expect(sessions.get).toHaveBeenCalledWith('agt_1');
    expect(webhooks.enqueueEvent).toHaveBeenCalledWith('acc_9', 'session.profile_save_failed', {
      session_id: 'agt_1',
      profile_id: 'prof_1',
      reason: 'upload_failed',
      detail: 'presigned PUT returned 503',
    });
  });

  it('omits detail from the payload when the frame carries none (no undefined key)', async () => {
    const sessions = {
      get: vi.fn().mockResolvedValue({ accountId: 'acc_9', nodeId: 'node_1' }),
    };
    const webhooks = { enqueueEvent: vi.fn().mockResolvedValue(1) };
    const relay = makeProfileSaveFailedRelay(sessions, webhooks, logger);
    const { detail: _detail, ...noDetail } = FRAME;
    relay({ ...noDetail, reason: 'too_large' }, 'node_1');
    await flush();
    expect(webhooks.enqueueEvent).toHaveBeenCalledWith('acc_9', 'session.profile_save_failed', {
      session_id: 'agt_1',
      profile_id: 'prof_1',
      reason: 'too_large',
    });
  });

  it('drops the relay (no webhook) for an unknown session', async () => {
    const sessions = { get: vi.fn().mockResolvedValue(null) };
    const webhooks = { enqueueEvent: vi.fn().mockResolvedValue(0) };
    const relay = makeProfileSaveFailedRelay(sessions, webhooks, logger);
    relay(FRAME, 'node_1');
    await flush();
    expect(webhooks.enqueueEvent).not.toHaveBeenCalled();
  });

  it('never throws + does not enqueue when the lookup rejects (fire-and-forget, error-logged)', async () => {
    const sessions = { get: vi.fn().mockRejectedValue(new Error('db down')) };
    const webhooks = { enqueueEvent: vi.fn() };
    const relay = makeProfileSaveFailedRelay(sessions, webhooks, logger);
    expect(() => relay(FRAME, 'node_1')).not.toThrow();
    await flush();
    expect(webhooks.enqueueEvent).not.toHaveBeenCalled();
  });

  // audit M1 — cross-node ownership gate (the frame's sessionId is attacker-
  // controllable; only the OWNING node may fire its webhook).
  it('M1 — enqueues when the reporting node OWNS the session', async () => {
    const sessions = { get: vi.fn().mockResolvedValue({ accountId: 'acc_9', nodeId: 'node-1' }) };
    const webhooks = { enqueueEvent: vi.fn().mockResolvedValue(1) };
    const relay = makeProfileSaveFailedRelay(sessions, webhooks, logger);
    relay(FRAME, 'node-1');
    await flush();
    expect(webhooks.enqueueEvent).toHaveBeenCalledTimes(1);
  });

  it('M1 — DROPS (no webhook) when a NON-owning node reports the save failure', async () => {
    const sessions = { get: vi.fn().mockResolvedValue({ accountId: 'acc_9', nodeId: 'node-1' }) };
    const webhooks = { enqueueEvent: vi.fn() };
    const relay = makeProfileSaveFailedRelay(sessions, webhooks, logger);
    relay(FRAME, 'node-evil');
    await flush();
    expect(webhooks.enqueueEvent).not.toHaveBeenCalled();
  });

  it('M1 — DROPS when an authenticated node targets a NULL-owner session', async () => {
    const sessions = { get: vi.fn().mockResolvedValue({ accountId: 'acc_9', nodeId: null }) };
    const webhooks = { enqueueEvent: vi.fn().mockResolvedValue(1) };
    const relay = makeProfileSaveFailedRelay(sessions, webhooks, logger);
    relay(FRAME, 'node-anything');
    await flush();
    expect(webhooks.enqueueEvent).not.toHaveBeenCalled();
  });

  // audit M2 — scrub the node egress IP from the free-form detail before the webhook.
  it('M2 — scrubs the node egress IP (direct=<node-ip>) from detail', async () => {
    const sessions = { get: vi.fn().mockResolvedValue({ accountId: 'acc_9', nodeId: 'node-1' }) };
    const webhooks = { enqueueEvent: vi.fn().mockResolvedValue(1) };
    const relay = makeProfileSaveFailedRelay(sessions, webhooks, logger);
    relay({ ...FRAME, detail: 'egress lost direct=10.0.0.7' }, 'node-1');
    await flush();
    const enqueued = webhooks.enqueueEvent.mock.calls[0]?.[2] as { detail: string };
    expect(enqueued.detail).not.toContain('10.0.0.7');
    expect(enqueued.detail).toContain('direct=[redacted]');
  });
});
