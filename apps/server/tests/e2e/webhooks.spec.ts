// E2E webhook flow: customer subscribes, fires an event, worker delivers
// to a test-side HTTP receiver that verifies the signature.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from '@playwright/test';
import { verifyWebhookSignature } from '@driftstack/sdk';
import { startTestServer, type TestServer } from './helpers/server.js';
import { seedAccount, authHeader } from './helpers/seed.js';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test.beforeEach(async () => {
  await server.resetState();
});

interface ReceivedDelivery {
  signature: string;
  eventId: string;
  eventType: string;
  body: string;
  parsedBody: Record<string, unknown>;
}

/**
 * Spin up a tiny HTTP receiver. Resolves with the first delivery it gets.
 *
 * `requestCount` exists so a test can assert that NOTHING arrived. Awaiting
 * `waitForDelivery()` cannot express that — it would hang until the suite
 * timeout and report a timeout rather than the fact under test.
 */
function startReceiver(): Promise<{
  url: string;
  waitForDelivery: () => Promise<ReceivedDelivery>;
  requestCount: () => number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    let received = 0;
    let resolveDelivery: (d: ReceivedDelivery) => void = () => {
      /* set later */
    };
    const deliveryP = new Promise<ReceivedDelivery>((r) => {
      resolveDelivery = r;
    });

    const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received += 1;
        const bodyBuf = Buffer.concat(chunks);
        const body = bodyBuf.toString('utf8');
        const sig = req.headers['x-driftstack-signature'];
        const evtId = req.headers['x-driftstack-event-id'];
        const evtType = req.headers['x-driftstack-event-type'];
        resolveDelivery({
          signature: typeof sig === 'string' ? sig : '',
          eventId: typeof evtId === 'string' ? evtId : '',
          eventType: typeof evtType === 'string' ? evtType : '',
          body,
          parsedBody: JSON.parse(body) as Record<string, unknown>,
        });
        res.statusCode = 204;
        res.end();
      });
    });

    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port.toString()}/webhook`,
        waitForDelivery: () => deliveryP,
        requestCount: () => received,
        close: () => new Promise((r) => httpServer.close(() => r())),
      });
    });
  });
}

test('signed payload round-trips: worker signs, receiver verifies with the SDK helper', async ({
  request,
}) => {
  // Companion to the SSRF refusal above. The production worker cannot reach a
  // local receiver by design, so this uses the plumbing-only unguarded seam to
  // exercise signature generation, header shape and payload structure over a
  // real HTTP hop. It asserts NO delivery policy — the refusal test owns that.
  const seed = await seedAccount(server.client, { tier: 'api_builder' });
  const receiver = await startReceiver();
  try {
    const subRes = await request.post(`${server.baseUrl}/v1/webhooks`, {
      headers: { 'content-type': 'application/json', ...authHeader(seed.plaintext) },
      data: { url: 'https://placeholder.test/webhook', events: ['session.completed'] },
    });
    expect(subRes.status()).toBe(201);
    const sub = (await subRes.json()) as { id: string; secret: string };
    const subUuid = sub.id.replace(/^whk_/, '');
    await server.client`UPDATE webhook_endpoints SET url = ${receiver.url} WHERE id = ${subUuid}`;

    const sessRes = await request.post(`${server.baseUrl}/v1/sessions`, {
      headers: { 'content-type': 'application/json', ...authHeader(seed.plaintext) },
      data: {},
    });
    expect(sessRes.status()).toBe(201);
    const session = (await sessRes.json()) as { id: string };
    expect(
      (
        await request.delete(`${server.baseUrl}/v1/sessions/${session.id}`, {
          headers: authHeader(seed.plaintext),
        })
      ).status(),
    ).toBe(204);

    const tick = await server.unguardedWebhookWorker.tickOnce();
    expect(tick.claimed).toBe(1);
    expect(tick.outcomes[0]?.kind).toBe('delivered');

    const got = await receiver.waitForDelivery();
    expect(got.eventType).toBe('session.completed');
    const ok = await verifyWebhookSignature({
      body: got.body,
      header: got.signature,
      secret: sub.secret,
    });
    expect(ok).toBe(true);
    expect(got.parsedBody.type).toBe('session.completed');
    expect((got.parsedBody.data as { session_id: string }).session_id).toBe(session.id);
  } finally {
    await receiver.close();
  }
});

test('webhook worker REFUSES to deliver to a loopback endpoint, and the receiver sees nothing', async ({
  request,
}) => {
  // This spec previously asserted a successful delivery to a localhost
  // receiver and had been failing. It was NOT sandbox networking, which is what
  // it looked like: `deliverOnce` calls `isLiteralUnsafeWebhookHost(endpoint.url)`
  // on EVERY send regardless of which fetch is injected, and that returns true
  // for `localhost` and all of 127.0.0.0/8. The guard throws, the throw is
  // classified as a retryable failure, and the outcome is `retry` — exactly what
  // was observed. The product was refusing an SSRF target correctly and the spec
  // asserted a delivery that can never happen against a local receiver.
  //
  // So it now asserts the refusal, which is worth more: the predicate has unit
  // coverage, but nothing proved the WORKER is actually wired to it. A
  // regression that dropped the call would leave those unit tests green while
  // the worker happily POSTed to 169.254.169.254.
  const seed = await seedAccount(server.client, { tier: 'api_builder' });
  const receiver = await startReceiver();
  try {
    const subRes = await request.post(`${server.baseUrl}/v1/webhooks`, {
      headers: { 'content-type': 'application/json', ...authHeader(seed.plaintext) },
      data: { url: 'https://placeholder.test/webhook', events: ['session.completed'] },
    });
    expect(subRes.status()).toBe(201);
    const sub = (await subRes.json()) as { id: string; secret: string };
    const subUuid = sub.id.replace(/^whk_/, '');

    // The API rejects http:// at the boundary, so point the stored row at the
    // loopback receiver directly — the same bypass the original spec used.
    await server.client`UPDATE webhook_endpoints SET url = ${receiver.url} WHERE id = ${subUuid}`;

    const sessRes = await request.post(`${server.baseUrl}/v1/sessions`, {
      headers: { 'content-type': 'application/json', ...authHeader(seed.plaintext) },
      data: {},
    });
    expect(sessRes.status()).toBe(201);
    const session = (await sessRes.json()) as { id: string };
    const destroyRes = await request.delete(`${server.baseUrl}/v1/sessions/${session.id}`, {
      headers: authHeader(seed.plaintext),
    });
    expect(destroyRes.status()).toBe(204);

    // The delivery is claimed, attempted, and refused.
    const tick = await server.webhookWorker.tickOnce();
    expect(tick.claimed).toBe(1);
    expect(
      tick.outcomes[0]?.kind,
      'a loopback endpoint must NOT be delivered to; the SSRF guard should refuse it',
    ).not.toBe('delivered');

    // The strongest assertion here: no request ever reached the receiver. If the
    // guard were removed, the receiver would have observed a signed POST.
    expect(
      receiver.requestCount(),
      'the SSRF guard must prevent the request from being made at all',
    ).toBe(0);

    // And the row is not marked delivered.
    const rows = await server.client<Array<{ status: string; delivered_at: string | null }>>`
      SELECT status, delivered_at FROM webhook_deliveries WHERE webhook_id = ${subUuid}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).not.toBe('delivered');
    expect(rows[0]?.delivered_at).toBeNull();
  } finally {
    await receiver.close();
  }
});
