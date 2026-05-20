// 2026-05-20 — unit tests for the GUI panel notification subscriber.
// Mocks the EventSource constructor so we can drive open / message /
// error events deterministically; asserts frame parsing + state
// transitions + cleanup-on-close.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NOTIFICATION_EVENT_KINDS,
  subscribeNotifications,
  type NotificationEvent,
} from '../../src/lib/notifications';

// Minimal mock EventSource matching the lib's call sites.
type Handler = (e: Event | MessageEvent<string>) => void;

class FakeEventSource {
  static readonly CONNECTING = 0 as const;
  static readonly OPEN = 1 as const;
  static readonly CLOSED = 2 as const;
  readyState = FakeEventSource.CONNECTING;
  private readonly listeners = new Map<string, Set<Handler>>();
  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  static instances: FakeEventSource[] = [];

  addEventListener(type: string, handler: Handler): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, handler: Handler): void {
    this.listeners.get(type)?.delete(handler);
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  // Test seams ───────────────────────────────────────────────────
  fireOpen(): void {
    this.readyState = FakeEventSource.OPEN;
    this.listeners.get('open')?.forEach((h) => h(new Event('open')));
  }
  fireKind(kind: string, data: object): void {
    const set = this.listeners.get(kind);
    if (!set) return;
    const ev = new MessageEvent<string>(kind, { data: JSON.stringify(data) });
    set.forEach((h) => h(ev));
  }
  fireError(transient = true): void {
    if (!transient) this.readyState = FakeEventSource.CLOSED;
    this.listeners.get('error')?.forEach((h) => h(new Event('error')));
  }
}

beforeEach(() => {
  FakeEventSource.instances.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NOTIFICATION_EVENT_KINDS — v0 union pinned', () => {
  it('exports exactly 4 kinds in the documented order', () => {
    expect(NOTIFICATION_EVENT_KINDS).toEqual([
      'cost.threshold_alert',
      'incident.broadcast',
      'audit.high_severity',
      'session.errored',
    ]);
  });
});

describe('subscribeNotifications', () => {
  it('opens an EventSource at the provided URL', () => {
    const onEvent = vi.fn();
    subscribeNotifications({
      url: 'https://api.driftstack.dev/v1/account/me/notifications',
      onEvent,
      eventSourceFactory: FakeEventSource as unknown as typeof EventSource,
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe(
      'https://api.driftstack.dev/v1/account/me/notifications',
    );
  });

  it('emits onState transitions: connecting → open on open event', () => {
    const states: string[] = [];
    subscribeNotifications({
      url: 'https://api.example/notifications',
      onEvent: vi.fn(),
      onState: (s) => states.push(s),
      eventSourceFactory: FakeEventSource as unknown as typeof EventSource,
    });
    expect(states).toEqual(['connecting']);
    FakeEventSource.instances[0]?.fireOpen();
    expect(states).toEqual(['connecting', 'open']);
  });

  it('parses a cost.threshold_alert frame and routes via onEvent', () => {
    const onEvent = vi.fn<(e: NotificationEvent) => void>();
    subscribeNotifications({
      url: 'https://api.example/notifications',
      onEvent,
      eventSourceFactory: FakeEventSource as unknown as typeof EventSource,
    });
    const es = FakeEventSource.instances[0];
    if (!es) throw new Error('expected instance');
    es.fireKind('cost.threshold_alert', {
      kind: 'cost.threshold_alert',
      accountId: 'acc_a',
      severity: 'warn',
      billingCycle: '2026-05',
      previousState: 'under-soft',
      currentState: 'between-soft-and-hard',
      totalCents: 12_500,
      thresholdSoftCents: 10_000,
      thresholdHardCents: 25_000,
      at: '2026-05-20T22:00:00.000Z',
    });
    expect(onEvent).toHaveBeenCalledTimes(1);
    const arg = onEvent.mock.calls[0]?.[0];
    expect(arg?.kind).toBe('cost.threshold_alert');
    if (arg?.kind === 'cost.threshold_alert') {
      expect(arg.severity).toBe('warn');
      expect(arg.totalCents).toBe(12_500);
    }
  });

  it('routes all 4 v0 kinds independently — each addEventListener fires only its own discriminator', () => {
    const received: NotificationEvent[] = [];
    subscribeNotifications({
      url: 'https://api.example/notifications',
      onEvent: (e) => received.push(e),
      eventSourceFactory: FakeEventSource as unknown as typeof EventSource,
    });
    const es = FakeEventSource.instances[0];
    if (!es) throw new Error('expected instance');
    es.fireKind('cost.threshold_alert', {
      kind: 'cost.threshold_alert',
      accountId: 'acc_a',
      severity: 'critical',
      billingCycle: '2026-05',
      previousState: null,
      currentState: 'over-hard',
      totalCents: 30_000,
      thresholdSoftCents: 10_000,
      thresholdHardCents: 25_000,
      at: '2026-05-20T22:00:00.000Z',
    });
    es.fireKind('incident.broadcast', {
      kind: 'incident.broadcast',
      accountId: 'acc_a',
      incidentId: 'inc_x',
      severity: 'major',
      title: 'API degraded',
      at: '2026-05-20T22:00:00.000Z',
    });
    es.fireKind('audit.high_severity', {
      kind: 'audit.high_severity',
      accountId: 'acc_a',
      action: 'api_key.revoked',
      actorType: 'customer',
      targetResourceId: 'key_y',
      at: '2026-05-20T22:00:00.000Z',
    });
    es.fireKind('session.errored', {
      kind: 'session.errored',
      accountId: 'acc_a',
      sessionId: 'ses_z',
      errorClass: 'driver_error',
      at: '2026-05-20T22:00:00.000Z',
    });
    expect(received.map((e) => e.kind)).toEqual([
      'cost.threshold_alert',
      'incident.broadcast',
      'audit.high_severity',
      'session.errored',
    ]);
  });

  it("transient error → onState('reconnecting'); CLOSED readyState → onState('closed')", () => {
    const states: string[] = [];
    subscribeNotifications({
      url: 'https://api.example/notifications',
      onEvent: vi.fn(),
      onState: (s) => states.push(s),
      eventSourceFactory: FakeEventSource as unknown as typeof EventSource,
    });
    const es = FakeEventSource.instances[0];
    if (!es) throw new Error('expected instance');
    es.fireError(true);
    es.fireError(false); // hard close
    // Note: connecting + reconnecting + closed (cleanup-driven close
    // not invoked here — onState('closed') comes from the readyState
    // check on the SECOND fireError).
    expect(states).toEqual(['connecting', 'reconnecting', 'closed']);
  });

  it('malformed JSON on a frame routes through onError without throwing', () => {
    const onError = vi.fn();
    subscribeNotifications({
      url: 'https://api.example/notifications',
      onEvent: vi.fn(),
      onError,
      eventSourceFactory: FakeEventSource as unknown as typeof EventSource,
    });
    const es = FakeEventSource.instances[0];
    if (!es) throw new Error('expected instance');
    // Manually fire a malformed frame on the cost.threshold_alert
    // channel (bypassing the helper that JSON-stringifies). Reach into
    // the listeners directly.
    const listeners = (
      es as unknown as { listeners: Map<string, Set<(e: Event) => void>> }
    ).listeners.get('cost.threshold_alert');
    if (!listeners) throw new Error('expected cost.threshold_alert listener');
    const malformedEvent = new MessageEvent<string>('cost.threshold_alert', {
      data: '{not valid json',
    });
    expect(() => {
      listeners.forEach((h) => h(malformedEvent));
    }).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });

  it('returned close handle invokes es.close() + emits onState(closed)', () => {
    const states: string[] = [];
    const close = subscribeNotifications({
      url: 'https://api.example/notifications',
      onEvent: vi.fn(),
      onState: (s) => states.push(s),
      eventSourceFactory: FakeEventSource as unknown as typeof EventSource,
    });
    const es = FakeEventSource.instances[0];
    if (!es) throw new Error('expected instance');
    close();
    expect(es.readyState).toBe(FakeEventSource.CLOSED);
    expect(states[states.length - 1]).toBe('closed');
  });
});
