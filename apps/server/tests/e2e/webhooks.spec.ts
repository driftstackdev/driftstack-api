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

/** Spin up a tiny HTTP receiver. Resolves with the first delivery it gets. */
function startReceiver(): Promise<{
  url: string;
  waitForDelivery: () => Promise<ReceivedDelivery>;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
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
        close: () => new Promise((r) => httpServer.close(() => r())),
      });
    });
  });
}

test('full webhook flow: subscribe → event → worker delivers signed POST → receiver verifies', async ({
  request,
}) => {
  const seed = await seedAccount(server.client, { tier: 'api_builder' });
  const receiver = await startReceiver();
  try {
    // 1. Subscribe to session.completed via the API. We have to talk https://
    //    on the wire because the API rejects http://, but the API doesn't
    //    actually probe the URL — that's the worker's job. So we lie at the
    //    boundary: subscribe to a fake https URL, then directly UPDATE the
    //    DB row to point at the test receiver. (Production never needs this
    //    bypass; it's only because the test receiver is http on localhost.)
    const subRes = await request.post(`${server.baseUrl}/v1/webhooks`, {
      headers: { 'content-type': 'application/json', ...authHeader(seed.plaintext) },
      data: {
        url: 'https://placeholder.test/webhook',
        events: ['session.completed'],
      },
    });
    expect(subRes.status()).toBe(201);
    const sub = (await subRes.json()) as { id: string; secret: string };
    const subUuid = sub.id.replace(/^whk_/, '');

    // Override the URL to point at the local test receiver.
    await server.client`UPDATE webhook_endpoints SET url = ${receiver.url} WHERE id = ${subUuid}`;

    // 2. Create + destroy a session — that fires session.completed.
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

    // 3. Tick the worker — it should claim the pending delivery and POST.
    const tick = await server.webhookWorker.tickOnce();
    expect(tick.claimed).toBe(1);
    expect(tick.outcomes[0]?.kind).toBe('delivered');

    // 4. The receiver must have received the signed POST.
    const got = await receiver.waitForDelivery();
    expect(got.eventType).toBe('session.completed');

    // 5. Verify signature with the SDK helper.
    const ok = await verifyWebhookSignature({
      body: got.body,
      header: got.signature,
      secret: sub.secret,
    });
    expect(ok).toBe(true);

    // 6. Spot-check payload structure.
    expect(got.parsedBody.type).toBe('session.completed');
    expect(typeof got.parsedBody.id).toBe('string');
    expect((got.parsedBody.data as { session_id: string }).session_id).toBe(session.id);

    // 7. DB state: delivery row marked delivered.
    const rows = await server.client<Array<{ status: string; delivered_at: string | null }>>`
      SELECT status, delivered_at FROM webhook_deliveries WHERE webhook_id = ${subUuid}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('delivered');
    expect(rows[0]?.delivered_at).not.toBeNull();
  } finally {
    await receiver.close();
  }
});
