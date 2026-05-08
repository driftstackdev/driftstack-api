// V-307 — customer self-service webhook delivery replay.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const headers = { 'content-type': 'application/json' };

async function createEndpoint(fixture: TestAppFixture): Promise<string> {
  const res = await fixture.app.inject({
    method: 'POST',
    url: '/v1/webhooks',
    headers: { ...headers, authorization: `Bearer ${fixture.plaintext}` },
    payload: {
      url: 'https://example.test/webhook',
      events: ['session.completed'],
      description: 'test',
    },
  });
  return res.json<{ id: string }>().id.replace(/^whk_/, '');
}

async function enqueueDelivery(fixture: TestAppFixture): Promise<string> {
  const endpointId = await createEndpoint(fixture);
  // Trigger one delivery via the service-level enqueueEvent.
  const count = await fixture.webhooksService.enqueueEvent(fixture.accountId, 'session.completed', {
    id: 'ses_test',
    status: 'completed',
  });
  if (count === 0) throw new Error('no delivery enqueued');
  // Read back via the GET /v1/webhooks/:id/deliveries endpoint.
  const res = await fixture.app.inject({
    method: 'GET',
    url: `/v1/webhooks/whk_${endpointId}/deliveries`,
    headers: { authorization: `Bearer ${fixture.plaintext}` },
  });
  const body = res.json<{ data: { id: string }[] }>();
  if (body.data.length === 0) throw new Error('no delivery rows');
  return body.data[0]!.id;
}

describe('POST /v1/webhook-deliveries/:deliveryId/replay', () => {
  it('200 resets the delivery to pending', async () => {
    fx = await buildTestApp();
    const deliveryPublicId = await enqueueDelivery(fx);

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/webhook-deliveries/${deliveryPublicId}/replay`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; status: string }>();
    expect(body.id).toBe(deliveryPublicId);
    expect(body.status).toBe('pending');
  });

  it('writes account_audit webhook_delivery.replayed entry', async () => {
    fx = await buildTestApp();
    const deliveryPublicId = await enqueueDelivery(fx);

    await fx.app.inject({
      method: 'POST',
      url: `/v1/webhook-deliveries/${deliveryPublicId}/replay`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
    });
    const replayed = fx.accountAuditRepo
      .getAll()
      .filter((r) => r.action === 'webhook_delivery.replayed');
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.targetResourceId).toBe(deliveryPublicId);
  });

  it('404 when delivery does not exist', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhook-deliveries/wdl_00000000-0000-4000-8000-000000000999/replay',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400 on malformed delivery id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhook-deliveries/not-a-delivery-id/replay',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
