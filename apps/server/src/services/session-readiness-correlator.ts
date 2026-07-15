// Connection-local SessionAssign readiness correlation.
//
// The harness acknowledges provisioning through sessionStatus frames. Ordinary
// launches return `active`; detached VPN launches return `provisioning` first
// and emit `active` later. A socket send returning is not browser readiness, so
// a future strict provisioner must reserve one waiter BEFORE it sends the
// SessionAssign and await the exact authenticated connection's status frame.
//
// This class deliberately does not send, retry or tear down anything. Each
// FleetControlConnection owns one instance, which makes a reconnect a hard
// ownership boundary: closing/superseding the old socket fails its waiters and
// a same-node successor cannot acknowledge work sent on the predecessor.

import type { SessionStatus } from '../schemas/harness-control-protocol.js';

/** Control-plane policy default, not a guaranteed producer maximum. The live
 * harness launch watchdog defaults to 90s but is operator-tunable; runtime
 * activation additionally requires fleet-wide timeout parity or an
 * authenticated reported watchdog capability. */
export const SESSION_READINESS_DEFAULT_TIMEOUT_MS = 105_000;

/** One authenticated connection may not retain unbounded session ids/timers. */
export const SESSION_READINESS_MAX_PENDING = 256;

/** Bounded, non-rejecting result. No free-text SessionStatus.detail or socket
 * diagnostic crosses this boundary. `reason`, when present, already passed the
 * protocol's bounded snake_case token schema. */
export type SessionReadinessOutcome =
  | { status: 'active' }
  | { status: 'terminal'; terminalStatus: 'ended' | 'errored'; reason?: string }
  | { status: 'timeout' }
  | { status: 'connection_closed' }
  | { status: 'duplicate' }
  | { status: 'capacity' };

interface PendingReadiness {
  resolve: (outcome: SessionReadinessOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SessionReadinessCorrelator {
  private readonly pending = new Map<string, PendingReadiness>();

  /**
   * Reserve one readiness waiter synchronously. The Promise executor installs
   * the map entry before this method returns, so callers can immediately send
   * SessionAssign without losing a synchronous/fast status reply.
   *
   * Duplicate and capacity failures resolve immediately and never replace an
   * existing owner. This method never rejects.
   */
  waitForActive(
    sessionId: string,
    timeoutMs = SESSION_READINESS_DEFAULT_TIMEOUT_MS,
  ): Promise<SessionReadinessOutcome> {
    if (this.pending.has(sessionId)) return Promise.resolve({ status: 'duplicate' });
    if (this.pending.size >= SESSION_READINESS_MAX_PENDING) {
      return Promise.resolve({ status: 'capacity' });
    }

    const effectiveTimeoutMs =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.floor(timeoutMs)
        : SESSION_READINESS_DEFAULT_TIMEOUT_MS;

    return new Promise<SessionReadinessOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(sessionId, { status: 'timeout' });
      }, effectiveTimeoutMs);
      timer.unref();
      this.pending.set(sessionId, { resolve, timer });
    });
  }

  /** Route an already schema-validated status from this exact connection. */
  onSessionStatus(frame: SessionStatus): void {
    if (!this.pending.has(frame.sessionId)) return;
    if (frame.status === 'active') {
      this.settle(frame.sessionId, { status: 'active' });
      return;
    }
    if (frame.status === 'ended' || frame.status === 'errored') {
      this.settle(frame.sessionId, {
        status: 'terminal',
        terminalStatus: frame.status,
        ...(frame.reason !== undefined ? { reason: frame.reason } : {}),
      });
    }
    // provisioning / idle / paused / resumed / forward-compatible states keep
    // waiting for exact active, a terminal state, connection loss or timeout.
  }

  /** The authenticated connection closed or was superseded. */
  failAll(): void {
    for (const sessionId of [...this.pending.keys()]) {
      this.settle(sessionId, { status: 'connection_closed' });
    }
  }

  /** Number of retained waiters/timers (test and boundedness inspection). */
  inFlight(): number {
    return this.pending.size;
  }

  private settle(sessionId: string, outcome: SessionReadinessOutcome): void {
    const target = this.pending.get(sessionId);
    if (target === undefined) return;
    clearTimeout(target.timer);
    this.pending.delete(sessionId);
    target.resolve(outcome);
  }
}
