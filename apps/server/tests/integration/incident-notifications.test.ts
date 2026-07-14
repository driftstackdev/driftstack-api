// V-295c3-followup — incident-notification fan-out.
//
// Asserts that the IncidentsService lifecycle callbacks fire the
// notification fan-out exactly once per public-incident state change,
// and never for private incidents.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const headers = { 'content-type': 'application/json' };

// Each subscriber gets its own remoteAddress so the IP rate limiter
// (3/min) doesn't cap the test setup. Real users naturally come from
// distinct IPs, so this models reality rather than test-only escape.
function ipFor(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) hash = (hash * 31 + email.charCodeAt(i)) | 0;
  const lo = Math.abs(hash) % 254;
  return `198.51.100.${lo + 1}`;
}

async function subscribeAndConfirm(fixture: TestAppFixture, email: string): Promise<void> {
  const ip = ipFor(email);
  await fixture.app.inject({
    method: 'POST',
    url: '/v1/status/subscribe',
    headers,
    remoteAddress: ip,
    payload: { email },
  });
  const last = fixture.emailSends[fixture.emailSends.length - 1];
  if (!last) throw new Error('no email after subscribe');
  const link = last.vars.confirmLink as string;
  const token = new URL(link).searchParams.get('token');
  if (!token) throw new Error('no token in confirmLink');
  await fixture.app.inject({
    method: 'GET',
    url: `/v1/status/subscribe/confirm?token=${encodeURIComponent(token)}`,
    remoteAddress: ip,
  });
}

describe('IncidentNotificationsService — fan-out via lifecycle hooks', () => {
  it('sends a "created" email to every confirmed subscriber on public incident', async () => {
    fx = await buildTestApp();
    await subscribeAndConfirm(fx, 'a@example.test');
    await subscribeAndConfirm(fx, 'b@example.test');
    const beforeCreate = fx.emailSends.length;

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: {
        title: 'API server elevated 5xx',
        description: 'Investigating.',
        severity: 'major',
      },
    });
    expect(res.statusCode).toBe(201);

    const afterCreate = fx.emailSends.slice(beforeCreate);
    const notifications = afterCreate.filter((s) => s.template === 'status-incident-created');
    expect(notifications).toHaveLength(2);
    expect(notifications.map((n) => n.to).sort()).toEqual(['a@example.test', 'b@example.test']);
  });

  it('does NOT send notifications on private incidents', async () => {
    fx = await buildTestApp();
    await subscribeAndConfirm(fx, 'a@example.test');
    const beforeCreate = fx.emailSends.length;

    await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: {
        title: 'Internal triage',
        description: 'd',
        severity: 'minor',
        public: false,
      },
    });

    const after = fx.emailSends.slice(beforeCreate);
    expect(after.filter((s) => s.template === 'status-incident-created')).toHaveLength(0);
  });

  it('sends a "resolved" email when public incident is resolved', async () => {
    fx = await buildTestApp();
    await subscribeAndConfirm(fx, 'a@example.test');

    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { title: 'x', description: 'd', severity: 'major' },
    });
    const incidentId = create.json<{ incident: { id: string } }>().incident.id;

    const beforeResolve = fx.emailSends.length;
    const resolve = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/incidents/${incidentId}/resolve`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { message: 'Rolled back the deploy.' },
    });
    expect(resolve.statusCode).toBe(200);

    const after = fx.emailSends.slice(beforeResolve);
    const resolved = after.filter((s) => s.template === 'status-incident-resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.to).toBe('a@example.test');
  });

  it('rotates the unsubscribe token per fan-out so the link works exactly once', async () => {
    fx = await buildTestApp();
    await subscribeAndConfirm(fx, 'a@example.test');

    // Capture the welcome-email unsubscribe token (the original).
    const welcome = fx.emailSends.find((s) => s.template === 'status-subscription-welcome');
    const welcomeToken = new URL(welcome!.vars.unsubscribeLink as string).searchParams.get('token');

    // Fire one incident — this rotates the token.
    await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { title: 'x', description: 'd', severity: 'minor' },
    });
    const created = fx.emailSends.find((s) => s.template === 'status-incident-created');
    expect(new URL(created!.vars.unsubscribeLink as string).pathname).toBe(
      '/subscribe/unsubscribe/',
    );
    const createdToken = new URL(created!.vars.unsubscribeLink as string).searchParams.get('token');

    expect(createdToken).not.toBe(welcomeToken);

    // The freshly-rotated token works for unsubscribe (use a fresh IP
    // so the per-IP gate from subscribeAndConfirm doesn't trip here).
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/status/subscribe/unsubscribe?token=${encodeURIComponent(createdToken!)}`,
      remoteAddress: '198.51.100.200',
    });
    expect(res.statusCode).toBe(200);

    // The original welcome-email token is now stale → 404.
    const stale = await fx.app.inject({
      method: 'GET',
      url: `/v1/status/subscribe/unsubscribe?token=${encodeURIComponent(welcomeToken!)}`,
      remoteAddress: '198.51.100.201',
    });
    expect(stale.statusCode).toBe(404);
  });

  it('V-545.B Phase 2 — fires a "status-incident-updated" email on addUpdate of a public incident', async () => {
    fx = await buildTestApp();
    await subscribeAndConfirm(fx, 'a@example.test');
    const createRes = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { title: 'API slow', description: 'Investigating.', severity: 'major' },
    });
    const incidentId = createRes.json<{ incident: { id: string } }>().incident.id;
    const beforeUpdate = fx.emailSends.length;

    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/incidents/${incidentId}/updates`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { message: 'Scope expanded to dashboard.', status: 'identified' },
    });

    const after = fx.emailSends.slice(beforeUpdate);
    const updates = after.filter((s) => s.template === 'status-incident-updated');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.to).toBe('a@example.test');
  });

  it('V-545.B Phase 2 — throttles a second update within the 1-hour window (same subscriber, same incident)', async () => {
    fx = await buildTestApp();
    await subscribeAndConfirm(fx, 'a@example.test');
    const createRes = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { title: 'API slow', description: 'Investigating.', severity: 'major' },
    });
    const incidentId = createRes.json<{ incident: { id: string } }>().incident.id;

    // First update — should send.
    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/incidents/${incidentId}/updates`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { message: 'still investigating', status: 'identified' },
    });
    const firstUpdateCount = fx.emailSends.filter(
      (s) => s.template === 'status-incident-updated' && s.to === 'a@example.test',
    ).length;
    expect(firstUpdateCount).toBe(1);

    // Second update — should be throttled (no second email).
    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/incidents/${incidentId}/updates`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { message: 'still investigating, slower', status: 'identified' },
    });
    const secondCount = fx.emailSends.filter(
      (s) => s.template === 'status-incident-updated' && s.to === 'a@example.test',
    ).length;
    expect(secondCount).toBe(1);
  });

  it('skips unsubscribed recipients on subsequent fan-outs', async () => {
    fx = await buildTestApp();
    await subscribeAndConfirm(fx, 'a@example.test');
    await subscribeAndConfirm(fx, 'b@example.test');

    // Unsubscribe a@.
    const welcomeForA = fx.emailSends.find(
      (s) => s.template === 'status-subscription-welcome' && s.to === 'a@example.test',
    );
    const aUnsubToken = new URL(welcomeForA!.vars.unsubscribeLink as string).searchParams.get(
      'token',
    );
    await fx.app.inject({
      method: 'GET',
      url: `/v1/status/subscribe/unsubscribe?token=${encodeURIComponent(aUnsubToken!)}`,
      remoteAddress: '198.51.100.202',
    });

    const beforeIncident = fx.emailSends.length;
    await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/incidents',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { title: 'x', description: 'd', severity: 'major' },
    });
    const after = fx.emailSends.slice(beforeIncident);
    const fanout = after.filter((s) => s.template === 'status-incident-created');
    expect(fanout.map((n) => n.to)).toEqual(['b@example.test']);
  });
});
