// Webhook receiver example — verify the signature before processing.
//
// Uses Node's stdlib http server to keep the example dep-free. In any
// real framework, the principle is the same: receive RAW BYTES (not a
// parsed JSON body), pass them to verifyWebhookSignature, then parse +
// dispatch.

/* eslint-disable no-console */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { verifyWebhookSignature } from '@driftstack/sdk';

const SECRET = process.env.DRIFTSTACK_WEBHOOK_SECRET ?? 'whsec_dev_only';
const PORT = Number(process.env.PORT ?? '3000');

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method !== 'POST' || req.url !== '/driftstack-webhook') {
    res.statusCode = 404;
    res.end();
    return;
  }
  void (async () => {
    const body = await readBody(req);
    const sig = req.headers['x-driftstack-signature'];

    const ok = await verifyWebhookSignature({
      body,
      header: typeof sig === 'string' ? sig : undefined,
      secret: SECRET,
    });
    if (!ok) {
      console.warn('webhook: invalid signature, rejecting');
      res.statusCode = 401;
      res.end();
      return;
    }

    const event = JSON.parse(body.toString('utf8')) as {
      id: string;
      type: string;
      created_at: string;
      data: Record<string, unknown>;
    };

    // Customers should treat events as at-least-once. Dedupe by event.id.
    console.log(`got ${event.type} (id=${event.id})`, event.data);

    switch (event.type) {
      case 'session.completed':
      case 'session.failed':
      case 'api_key.revoked':
        // dispatch to your app's handler
        break;
      default:
        console.warn(`unknown event type: ${event.type}`);
    }

    res.statusCode = 204;
    res.end();
  })().catch((err: unknown) => {
    console.error(err);
    res.statusCode = 500;
    res.end();
  });
});

server.listen(PORT, () => {
  console.log(`listening on :${PORT.toString()}`);
});
