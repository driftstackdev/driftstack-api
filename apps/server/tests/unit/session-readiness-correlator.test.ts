import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionStatus } from '../../src/schemas/harness-control-protocol.js';
import {
  SESSION_READINESS_DEFAULT_TIMEOUT_MS,
  SESSION_READINESS_MAX_PENDING,
  SessionReadinessCorrelator,
} from '../../src/services/session-readiness-correlator.js';

function status(
  state: string,
  sessionId = 'agt_a',
  extra: Partial<SessionStatus> = {},
): SessionStatus {
  return {
    type: 'sessionStatus',
    sessionId,
    status: state,
    timestamp: '2026-07-15T00:00:00Z',
    ...extra,
  };
}

describe('SessionReadinessCorrelator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reserves synchronously before a caller send and accepts a fast active reply', async () => {
    const correlator = new SessionReadinessCorrelator();
    const pending = correlator.waitForActive('agt_a');
    expect(correlator.inFlight()).toBe(1);

    // Models a transport whose send path can synchronously deliver a reply.
    const send = () => {
      expect(correlator.inFlight()).toBe(1);
      correlator.onSessionStatus(status('active'));
    };
    send();

    expect(await pending).toEqual({ status: 'active' });
    expect(correlator.inFlight()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores unknown and intermediate states, then uses the exact default policy timeout', async () => {
    const correlator = new SessionReadinessCorrelator();
    const pending = correlator.waitForActive('agt_a');
    correlator.onSessionStatus(status('active', 'agt_unknown'));
    for (const state of ['provisioning', 'idle', 'paused', 'resumed', 'future_state']) {
      correlator.onSessionStatus(status(state));
    }
    expect(correlator.inFlight()).toBe(1);
    await vi.advanceTimersByTimeAsync(SESSION_READINESS_DEFAULT_TIMEOUT_MS - 1);
    expect(correlator.inFlight()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ status: 'timeout' });
    expect(correlator.inFlight()).toBe(0);
  });

  it('allows the future caller to override the control-plane timeout policy', async () => {
    const correlator = new SessionReadinessCorrelator();
    const pending = correlator.waitForActive('agt_a', 2_500);
    await vi.advanceTimersByTimeAsync(2_499);
    expect(correlator.inFlight()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ status: 'timeout' });
    expect(correlator.inFlight()).toBe(0);
  });

  it('returns bounded terminal status/reason and never retains free-text detail', async () => {
    const correlator = new SessionReadinessCorrelator();
    const pending = correlator.waitForActive('agt_a');
    correlator.onSessionStatus(
      status('errored', 'agt_a', {
        reason: 'node_draining',
        detail: 'customer-secret-shaped diagnostic must not be retained',
      }),
    );
    expect(await pending).toEqual({
      status: 'terminal',
      terminalStatus: 'errored',
      reason: 'node_draining',
    });
  });

  it('terminal ended without a reason is still deterministic', async () => {
    const correlator = new SessionReadinessCorrelator();
    const pending = correlator.waitForActive('agt_a');
    correlator.onSessionStatus(status('ended'));
    expect(await pending).toEqual({ status: 'terminal', terminalStatus: 'ended' });
  });

  it('refuses a duplicate without replacing the first owner', async () => {
    const correlator = new SessionReadinessCorrelator();
    const first = correlator.waitForActive('agt_a');
    const duplicate = correlator.waitForActive('agt_a');
    expect(await duplicate).toEqual({ status: 'duplicate' });
    expect(correlator.inFlight()).toBe(1);
    correlator.onSessionStatus(status('active'));
    expect(await first).toEqual({ status: 'active' });
  });

  it('caps each connection at 256 pending ids and preserves every admitted owner', async () => {
    const correlator = new SessionReadinessCorrelator();
    const admitted = Array.from({ length: SESSION_READINESS_MAX_PENDING }, (_, index) =>
      correlator.waitForActive(`agt_${String(index)}`),
    );
    expect(correlator.inFlight()).toBe(SESSION_READINESS_MAX_PENDING);
    expect(await correlator.waitForActive('agt_overflow')).toEqual({ status: 'capacity' });
    expect(correlator.inFlight()).toBe(SESSION_READINESS_MAX_PENDING);

    correlator.failAll();
    expect(await Promise.all(admitted)).toEqual(
      Array.from({ length: SESSION_READINESS_MAX_PENDING }, () => ({
        status: 'connection_closed',
      })),
    );
    expect(correlator.inFlight()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('connection loss settles all waiters immediately and never rejects', async () => {
    const correlator = new SessionReadinessCorrelator();
    const first = correlator.waitForActive('agt_a', 5_000);
    const second = correlator.waitForActive('agt_b', 5_000);
    correlator.failAll();
    expect(await first).toEqual({ status: 'connection_closed' });
    expect(await second).toEqual({ status: 'connection_closed' });
    expect(correlator.inFlight()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
