// V-553.B-3 — unit tests for V-295e IncidentEventBus.
//
// Coverage at the integration level via SSE route tests; this file
// covers the in-process publish + listener-lifecycle semantics
// without the SSE layer: subscribe / unsubscribe, multi-listener
// fan-out, listener-throws-don't-break-others isolation, and the
// public-vs-internal row → wire-shape mapping.

import { describe, expect, it, vi } from 'vitest';
import { IncidentEventBus, type IncidentEvent } from '../../src/services/incident-event-bus.js';
import type { IncidentRow, IncidentUpdateRow } from '../../src/services/incidents.js';

function makeRow(overrides: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'API elevated 5xx',
    description: 'Investigating',
    severity: 'major',
    status: 'investigating',
    affectedComponents: ['api'],
    public: true,
    startedAt: new Date('2026-05-11T15:00:00Z'),
    resolvedAt: null,
    createdByAdminId: 'admin_1',
    createdByAdminKeyId: 'key_admin_1',
    autoProbeTarget: null,
    createdAt: new Date('2026-05-11T15:00:00Z'),
    updatedAt: new Date('2026-05-11T15:00:00Z'),
    ...overrides,
  };
}

function makeUpdate(overrides: Partial<IncidentUpdateRow> = {}): IncidentUpdateRow {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    incidentId: '11111111-1111-1111-1111-111111111111',
    message: 'We are looking into elevated error rates.',
    status: 'investigating',
    postedByAdminId: 'admin_1',
    postedByAdminKeyId: 'key_admin_1',
    postedAt: new Date('2026-05-11T15:01:00Z'),
    ...overrides,
  };
}

describe('V-553.B-3 IncidentEventBus — subscribe + fan-out', () => {
  it('subscribe returns an unsubscribe fn; listenerCount tracks state', () => {
    const bus = new IncidentEventBus();
    expect(bus.listenerCount()).toBe(0);
    const off1 = bus.subscribe(vi.fn());
    const off2 = bus.subscribe(vi.fn());
    expect(bus.listenerCount()).toBe(2);
    off1();
    expect(bus.listenerCount()).toBe(1);
    off2();
    expect(bus.listenerCount()).toBe(0);
  });

  it('publishCreated fans out to every subscriber with the expected shape', () => {
    const bus = new IncidentEventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);
    bus.publishCreated(makeRow(), makeUpdate());
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    const event = a.mock.calls[0]?.[0] as IncidentEvent;
    expect(event.event).toBe('incident.created');
    expect(event.incident.id).toBe('inc_11111111-1111-1111-1111-111111111111');
    expect(event.incident.severity).toBe('major');
    expect(event.update.message).toBe('We are looking into elevated error rates.');
    expect(typeof event.generated_at).toBe('string');
  });

  it('publishResolved fans out with the resolved kind', () => {
    const bus = new IncidentEventBus();
    const listener = vi.fn();
    bus.subscribe(listener);
    bus.publishResolved(
      makeRow({ status: 'resolved', resolvedAt: new Date('2026-05-11T16:00:00Z') }),
      makeUpdate({ status: 'resolved', message: 'Root cause: upstream DNS.' }),
    );
    const event = listener.mock.calls[0]?.[0] as IncidentEvent;
    expect(event.event).toBe('incident.resolved');
    expect(event.update.status).toBe('resolved');
    expect(event.update.message).toBe('Root cause: upstream DNS.');
  });
});

describe('V-553.B-3 IncidentEventBus — listener isolation', () => {
  it('a throwing listener does NOT prevent other listeners from receiving the event', () => {
    const bus = new IncidentEventBus();
    const thrower = vi.fn(() => {
      throw new Error('listener bug');
    });
    const good = vi.fn();
    bus.subscribe(thrower);
    bus.subscribe(good);
    expect(() => bus.publishCreated(makeRow(), makeUpdate())).not.toThrow();
    expect(thrower).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('unsubscribed listeners stop receiving events', () => {
    const bus = new IncidentEventBus();
    const listener = vi.fn();
    const off = bus.subscribe(listener);
    bus.publishCreated(makeRow(), makeUpdate());
    off();
    bus.publishResolved(makeRow({ status: 'resolved' }), makeUpdate({ status: 'resolved' }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('events fire in subscription order', () => {
    const bus = new IncidentEventBus();
    const order: string[] = [];
    bus.subscribe(() => order.push('first'));
    bus.subscribe(() => order.push('second'));
    bus.subscribe(() => order.push('third'));
    bus.publishCreated(makeRow(), makeUpdate());
    expect(order).toEqual(['first', 'second', 'third']);
  });
});

describe('V-553.B-3 IncidentEventBus — public wire-shape mapping', () => {
  it('row.id prefixed with inc_ on the wire (matches GET /v1/status/incidents)', () => {
    const bus = new IncidentEventBus();
    const listener = vi.fn();
    bus.subscribe(listener);
    bus.publishCreated(makeRow({ id: 'abc-123' }), makeUpdate());
    const event = listener.mock.calls[0]?.[0] as IncidentEvent;
    expect(event.incident.id).toBe('inc_abc-123');
  });

  it('Date fields serialised to ISO strings on the wire', () => {
    const bus = new IncidentEventBus();
    const listener = vi.fn();
    bus.subscribe(listener);
    bus.publishCreated(makeRow(), makeUpdate());
    const event = listener.mock.calls[0]?.[0] as IncidentEvent;
    expect(event.incident.started_at).toBe('2026-05-11T15:00:00.000Z');
    expect(event.update.posted_at).toBe('2026-05-11T15:01:00.000Z');
  });
});
