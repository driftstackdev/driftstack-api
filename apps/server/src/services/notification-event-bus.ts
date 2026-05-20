// 2026-05-20 — GUI panel notification stream.
//
// In-process pub/sub for per-account notifications surfaced in the
// desktop GUI's panel-level view ("what's happening on your account
// right now"). Mirrors the shape of `AgentSessionEventBus` (Arc 2
// sub-slice 8.3) so a future Redis-backed implementation drops in
// without changing call sites.
//
// Subscriber keying: per-`accountId`. Cross-account leakage is
// impossible by construction — publishes only fan out to handlers
// registered on the exact same `accountId`.
//
// Publish semantics: best-effort. A handler that throws MUST NOT
// block other handlers or the publisher. No persistence; events
// with no live subscribers are dropped on the floor.
//
// Full design at `docs/internal/driftstack-telemetry-event-schema-
// for-gui-panel.md`.

import type { ThresholdState } from '../lib/cost-estimator.js';

/** What subscribers receive. Discriminated on `kind` so each
 *  payload carries its own shape; the union is intentionally
 *  narrow in v0 — see the design doc for the v0.1+ catalog. */
export type NotificationEvent =
  | {
      kind: 'cost.threshold_alert';
      accountId: string;
      severity: 'warn' | 'critical' | 'resolved';
      billingCycle: string;
      previousState: ThresholdState | null;
      currentState: ThresholdState;
      totalCents: number;
      thresholdSoftCents: number;
      thresholdHardCents: number;
      at: string;
    }
  | {
      kind: 'incident.broadcast';
      accountId: string;
      incidentId: string;
      severity: 'minor' | 'major' | 'critical';
      title: string;
      at: string;
    }
  | {
      kind: 'audit.high_severity';
      accountId: string;
      action: string;
      actorType: 'customer' | 'admin' | 'system';
      targetResourceId: string | null;
      at: string;
    }
  | {
      kind: 'session.errored';
      accountId: string;
      sessionId: string;
      errorClass: string;
      at: string;
    };

export type NotificationEventHandler = (event: NotificationEvent) => void;

export class NotificationEventBus {
  private readonly subscribers = new Map<string, Set<NotificationEventHandler>>();

  /** Subscribe to one account's notification stream. Returns an
   *  unsubscribe function the caller MUST call on disconnect. */
  subscribe(accountId: string, handler: NotificationEventHandler): () => void {
    const existing = this.subscribers.get(accountId) ?? new Set();
    existing.add(handler);
    this.subscribers.set(accountId, existing);
    return () => {
      const set = this.subscribers.get(accountId);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) this.subscribers.delete(accountId);
    };
  }

  publish(event: NotificationEvent): void {
    const set = this.subscribers.get(event.accountId);
    if (!set) return;
    for (const handler of set) {
      // Best-effort: a buggy handler MUST NOT block other handlers
      // or the publisher.
      try {
        handler(event);
      } catch {
        /* swallow */
      }
    }
  }

  /** Test-only — surfaces the current subscriber count for a given
   *  account id, so tests can assert subscribe / unsubscribe lifecycle. */
  subscriberCount(accountId: string): number {
    return this.subscribers.get(accountId)?.size ?? 0;
  }
}
