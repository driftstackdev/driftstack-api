// V-295d — outbound incident broadcast tests.
//
// Asserts that:
//   - When BROADCAST_SLACK_WEBHOOK_URL is set, a public-incident
//     create/resolve POSTs a Slack incoming-webhook payload.
//   - When BROADCAST_GENERIC_WEBHOOK_URL is set, the same lifecycle
//     POSTs a JSON envelope.
//   - When neither is set, no HTTP calls fire.
//   - Private incidents do NOT trigger broadcasts.
//   - Slack and generic channels are independent (one configured, one
//     not — only the configured one fires).

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

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
  return res.json<{ incident: { id: string } }>().incident.id;
}

describe('IncidentBroadcastService', () => {
  it('POSTs Slack payload on public-incident create', async () => {
    fx = await buildTestApp({ broadcastSlackUrl: 'https://hooks.slack.com/test' });
    await postIncident(fx, {
      title: 'API server elevated 5xx',
      description: 'Investigating.',
      severity: 'major',
    });

    expect(fx.broadcastFetchCalls).toHaveLength(1);
    const call = fx.broadcastFetchCalls[0]!;
    expect(call.url).toBe('https://hooks.slack.com/test');
    const body = call.body as { text: string; attachments: unknown[] };
    expect(body.text).toContain('Posted incident');
    expect(body.text).toContain('API server elevated 5xx');
    expect(body.attachments).toHaveLength(1);
  });

  it('POSTs generic JSON envelope on public-incident create', async () => {
    fx = await buildTestApp({ broadcastGenericUrl: 'https://relay.example.test/incidents' });
    await postIncident(fx, {
      title: 'API server elevated 5xx',
      description: 'd',
      severity: 'major',
    });

    expect(fx.broadcastFetchCalls).toHaveLength(1);
    const body = fx.broadcastFetchCalls[0]!.body as {
      event: string;
      incident: { id: string; title: string; severity: string };
      update: { message: string };
    };
    expect(body.event).toBe('incident.created');
    expect(body.incident.title).toBe('API server elevated 5xx');
    expect(body.incident.severity).toBe('major');
    expect(body.incident.id).toMatch(/^inc_/);
    expect(body.update.message).toBe('d');
  });

  it('POSTs to BOTH channels when both URLs are configured', async () => {
    fx = await buildTestApp({
      broadcastSlackUrl: 'https://hooks.slack.com/test',
      broadcastGenericUrl: 'https://relay.example.test/incidents',
    });
    await postIncident(fx, { title: 'x', description: 'd', severity: 'minor' });
    expect(fx.broadcastFetchCalls).toHaveLength(2);
    const urls = fx.broadcastFetchCalls.map((c) => c.url).sort();
    expect(urls).toEqual(['https://hooks.slack.com/test', 'https://relay.example.test/incidents']);
  });

  it('does NOT POST when neither URL is configured', async () => {
    fx = await buildTestApp();
    await postIncident(fx, { title: 'x', description: 'd', severity: 'minor' });
    expect(fx.broadcastFetchCalls).toHaveLength(0);
  });

  it('does NOT POST on private incidents', async () => {
    fx = await buildTestApp({ broadcastSlackUrl: 'https://hooks.slack.com/test' });
    await postIncident(fx, {
      title: 'Internal triage',
      description: 'd',
      severity: 'minor',
      public: false,
    });
    expect(fx.broadcastFetchCalls).toHaveLength(0);
  });

  it('POSTs resolved-event payload on incident resolve', async () => {
    fx = await buildTestApp({ broadcastGenericUrl: 'https://relay.example.test/incidents' });
    const incidentId = await postIncident(fx, {
      title: 'x',
      description: 'd',
      severity: 'major',
    });

    const beforeResolve = fx.broadcastFetchCalls.length;
    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/incidents/${incidentId}/resolve`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { message: 'Rolled back the deploy.' },
    });
    const after = fx.broadcastFetchCalls.slice(beforeResolve);
    expect(after).toHaveLength(1);
    const body = after[0]!.body as { event: string; update: { message: string } };
    expect(body.event).toBe('incident.resolved');
    expect(body.update.message).toBe('Rolled back the deploy.');
  });

  it('Slack payload color reflects resolved status', async () => {
    fx = await buildTestApp({ broadcastSlackUrl: 'https://hooks.slack.com/test' });
    const incidentId = await postIncident(fx, {
      title: 'x',
      description: 'd',
      severity: 'major',
    });
    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/incidents/${incidentId}/resolve`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { message: 'Done.' },
    });
    const resolved = fx.broadcastFetchCalls[fx.broadcastFetchCalls.length - 1]!;
    const body = resolved.body as { attachments: { color: string }[] };
    expect(body.attachments[0]!.color).toBe('#2ea44f'); // green for resolved
  });
});
