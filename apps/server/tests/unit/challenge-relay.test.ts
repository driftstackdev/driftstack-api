// W393 — challenge-handling relay. makeChallengeRelay resolves the owning
// account from the harness `challengeDetected` frame's session id and enqueues
// a `session.challenge_detected` webhook. Fire-and-forget off the receive loop:
// it must never throw (a thrown handler would crash the node's WS receive loop),
// and an unknown session drops the relay (no webhook).

import { describe, expect, it, vi } from 'vitest';
import { makeChallengeRelay } from '../../src/services/challenge-relay.js';
import type { ChallengeDetected } from '../../src/schemas/harness-control-protocol.js';
import type { Logger } from '../../src/lib/logger.js';

const FRAME: ChallengeDetected = {
  type: 'challengeDetected',
  sessionId: 'ses_1',
  challengeId: 'chl_1',
  challenge: { type: 'datadome', confidence: 0.9, detail: 'captcha' },
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

// Drain microtasks: the handler is sync void + fire-and-forget (.get().then().
// then()), so settle the chain before asserting.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('W393 makeChallengeRelay', () => {
  it('resolves accountId from the session + enqueues session.challenge_detected', async () => {
    const sessions = {
      get: vi.fn().mockResolvedValue({ accountId: 'acc_9', nodeId: 'node_1' }),
    };
    const webhooks = { enqueueEvent: vi.fn().mockResolvedValue(2) };
    const relay = makeChallengeRelay(sessions, webhooks, logger);
    relay(FRAME, 'node_1');
    await flush();
    expect(sessions.get).toHaveBeenCalledWith('ses_1');
    expect(webhooks.enqueueEvent).toHaveBeenCalledWith('acc_9', 'session.challenge_detected', {
      session_id: 'ses_1',
      challenge_id: 'chl_1',
      challenge: { type: 'datadome', confidence: 0.9, detail: 'captcha' },
    });
  });

  it('drops the relay (no webhook) for an unknown session', async () => {
    const sessions = { get: vi.fn().mockResolvedValue(null) };
    const webhooks = { enqueueEvent: vi.fn().mockResolvedValue(0) };
    const relay = makeChallengeRelay(sessions, webhooks, logger);
    relay(FRAME, 'node_1');
    await flush();
    expect(webhooks.enqueueEvent).not.toHaveBeenCalled();
  });

  it('never throws + does not enqueue when the lookup rejects (fire-and-forget, error-logged)', async () => {
    const sessions = { get: vi.fn().mockRejectedValue(new Error('db down')) };
    const webhooks = { enqueueEvent: vi.fn() };
    const relay = makeChallengeRelay(sessions, webhooks, logger);
    expect(() => relay(FRAME, 'node_1')).not.toThrow();
    await flush();
    expect(webhooks.enqueueEvent).not.toHaveBeenCalled();
  });

  // audit M1 — cross-node ownership gate. The frame's sessionId is attacker-
  // controllable; only the session's OWNING node may fire its webhook.
  it('M1 — enqueues when the reporting node OWNS the session', async () => {
    const sessions = { get: vi.fn().mockResolvedValue({ accountId: 'acc_9', nodeId: 'node-1' }) };
    const webhooks = { enqueueEvent: vi.fn().mockResolvedValue(1) };
    const relay = makeChallengeRelay(sessions, webhooks, logger);
    relay(FRAME, 'node-1');
    await flush();
    expect(webhooks.enqueueEvent).toHaveBeenCalledTimes(1);
  });

  it('M1 — DROPS (no webhook) when a NON-owning node reports the challenge', async () => {
    const sessions = { get: vi.fn().mockResolvedValue({ accountId: 'acc_9', nodeId: 'node-1' }) };
    const webhooks = { enqueueEvent: vi.fn() };
    const relay = makeChallengeRelay(sessions, webhooks, logger);
    relay(FRAME, 'node-evil');
    await flush();
    expect(webhooks.enqueueEvent).not.toHaveBeenCalled();
  });

  it('M1 — DROPS when an authenticated node targets a NULL-owner session', async () => {
    const sessions = { get: vi.fn().mockResolvedValue({ accountId: 'acc_9', nodeId: null }) };
    const webhooks = { enqueueEvent: vi.fn().mockResolvedValue(1) };
    const relay = makeChallengeRelay(sessions, webhooks, logger);
    relay(FRAME, 'node-anything');
    await flush();
    expect(webhooks.enqueueEvent).not.toHaveBeenCalled();
  });

  // audit M2 — scrub the node's real egress IP (W1859 `direct=<node-ip>`) from
  // the free-form challenge.detail before it crosses to the customer webhook.
  it('M2 — scrubs the node egress IP from challenge.detail before the webhook', async () => {
    const frame: ChallengeDetected = {
      ...FRAME,
      challenge: {
        type: 'datadome',
        confidence: 0.9,
        detail: 'blocked proxied=1.2.3.4 direct=10.0.0.7',
      },
    };
    const sessions = { get: vi.fn().mockResolvedValue({ accountId: 'acc_9', nodeId: 'node-1' }) };
    const webhooks = { enqueueEvent: vi.fn().mockResolvedValue(1) };
    const relay = makeChallengeRelay(sessions, webhooks, logger);
    relay(frame, 'node-1');
    await flush();
    const enqueued = webhooks.enqueueEvent.mock.calls[0]?.[2] as {
      challenge: { detail: string };
    };
    expect(enqueued.challenge.detail).not.toContain('10.0.0.7');
    expect(enqueued.challenge.detail).toContain('direct=[redacted]');
    // bare IPv4 (the customer's own proxied= exit) is also redacted (defence-in-depth).
    expect(enqueued.challenge.detail).not.toContain('1.2.3.4');
  });
});
