// S45 2026-07-07 (founder-approved) — incident.broadcast on the
// customer SSE notification bus.
//
// Asserts that the public-incident lifecycle hooks (the same ones
// that fan out subscriber emails + Slack/generic webhooks) ALSO
// publish an `incident.broadcast` NotificationEvent so dashboard SSE
// subscribers (GET /v1/account/me/notifications) receive it:
//   - created  → one frame per subscribed account, each stamped with
//     that subscriber's own accountId;
//   - updates  → one frame per posted update (SSE frames are not
//     throttled — that cap is email-only);
//   - resolved → one frame;
//   - PRIVATE incidents publish nothing (the hooks only fire for
//     public incidents);
//   - zero subscribers → nothing recorded, nothing thrown (the bus
//     drops undelivered events on the floor by design).
//
// The bus subscription here stands in for the SSE route's handler —
// the route subscribes with exactly this API and serializes each
// event verbatim into `event:`/`data:` frames (pinned by the
// notification-bus cross-source invariant), so bus-level delivery is
// the load-bearing integration point. LightMyRequest can't hold a
// hijacked SSE stream open, so the stream itself is exercised at the
// unit/parity layer.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import type { NotificationEvent } from '../../src/services/notification-event-bus.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const headers = { 'content-type': 'application/json' };

async function postIncident(
  fixture: TestAppFixture,
  body: { title: string; description: string; severity: string; public?: boolean },
): Promise<string> {
  const res = await fixture.app.inject({
    method: 'POST',
    url: '/v1/admin/incidents',
    headers: { ...headers, authorization: `Bearer ${fixture.plaintext}` },
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ incident: { id: string } }>().incident.id;
}

describe('S45 incident.broadcast → customer notification bus', () => {
  it('publishes an incident.broadcast frame to every subscribed account on public-incident create', async () => {
    fx = await buildTestApp();
    const receivedA: NotificationEvent[] = [];
    const receivedB: NotificationEvent[] = [];
    fx.notificationEventBus.subscribe('acc_aaa', (e) => receivedA.push(e));
    fx.notificationEventBus.subscribe('acc_bbb', (e) => receivedB.push(e));

    const incidentId = await postIncident(fx, {
      title: 'API server elevated 5xx',
      description: 'Investigating.',
      severity: 'major',
    });

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(1);
    const frameA = receivedA[0]!;
    expect(frameA.kind).toBe('incident.broadcast');
    if (frameA.kind !== 'incident.broadcast') throw new Error('unreachable');
    // Per-subscriber accountId stamping — each copy carries the
    // recipient's own account id, preserving the SSE frame shape.
    expect(frameA.accountId).toBe('acc_aaa');
    expect(receivedB[0]!.accountId).toBe('acc_bbb');
    // Customer-facing id shape + payload fields per the docs table.
    expect(frameA.incidentId).toBe(incidentId);
    expect(frameA.incidentId).toMatch(/^inc_/);
    expect(frameA.severity).toBe('major');
    expect(frameA.title).toBe('API server elevated 5xx');
    expect(new Date(frameA.at).getTime()).not.toBeNaN();
  });

  it('publishes one frame per posted update and one on resolve (SSE frames are not email-throttled)', async () => {
    fx = await buildTestApp();
    const incidentId = await postIncident(fx, {
      title: 'API slow',
      description: 'Investigating.',
      severity: 'minor',
    });

    const received: NotificationEvent[] = [];
    fx.notificationEventBus.subscribe('acc_ccc', (e) => received.push(e));

    for (const message of ['Scope expanded.', 'Mitigation deployed.'] as const) {
      const res = await fx.app.inject({
        method: 'POST',
        url: `/v1/admin/incidents/${incidentId}/updates`,
        headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
        payload: { message, status: 'identified' },
      });
      expect(res.statusCode).toBe(201);
    }

    const resolveRes = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/incidents/${incidentId}/resolve`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { message: 'Rolled back the deploy.' },
    });
    expect(resolveRes.statusCode).toBe(200);

    const broadcasts = received.filter((e) => e.kind === 'incident.broadcast');
    expect(broadcasts).toHaveLength(3); // 2 updates + 1 resolve
    for (const frame of broadcasts) {
      if (frame.kind !== 'incident.broadcast') throw new Error('unreachable');
      expect(frame.incidentId).toBe(incidentId);
      expect(frame.accountId).toBe('acc_ccc');
    }
  });

  it('PRIVATE incidents publish NO incident.broadcast frames', async () => {
    fx = await buildTestApp();
    const received: NotificationEvent[] = [];
    fx.notificationEventBus.subscribe('acc_ddd', (e) => received.push(e));

    await postIncident(fx, {
      title: 'Internal triage',
      description: 'd',
      severity: 'minor',
      public: false,
    });

    expect(received.filter((e) => e.kind === 'incident.broadcast')).toHaveLength(0);
  });

  it('zero subscribers → create still succeeds (undelivered broadcasts drop on the floor)', async () => {
    fx = await buildTestApp();
    const incidentId = await postIncident(fx, {
      title: 'No one is listening',
      description: 'd',
      severity: 'minor',
    });
    expect(incidentId).toMatch(/^inc_/);
  });
});
