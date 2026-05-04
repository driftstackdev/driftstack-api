// V-124: Webhook signature verify microbenchmark.
//
// Customers call `verifyWebhookSignature` once per inbound webhook
// delivery. Latency here directly affects customer infra cost. SubtleCrypto
// HMAC-SHA256 is the dominant cost; the surrounding parse + timestamp
// tolerance are negligible.

import { bench, describe } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature } from '../../src/webhook-signature.js';

const SECRET = 'whsec_'.padEnd(48, 'a');
const BODY_SMALL = JSON.stringify({ event: 'session.completed', id: 'sess_test' });
const BODY_LARGE = JSON.stringify({ event: 'session.completed', payload: 'x'.repeat(10_000) });

function makeHeader(body: string, secret: string): string {
  const t = Math.floor(Date.now() / 1000);
  const hex = createHmac('sha256', secret).update(`${t.toString()}.${body}`).digest('hex');
  return `t=${t.toString()},v1=${hex}`;
}

const HEADER_SMALL = makeHeader(BODY_SMALL, SECRET);
const HEADER_LARGE = makeHeader(BODY_LARGE, SECRET);
const HEADER_BAD = `t=${Math.floor(Date.now() / 1000).toString()},v1=${'0'.repeat(64)}`;

describe('verifyWebhookSignature — small body (~70 bytes)', () => {
  bench('valid signature, small body', async () => {
    await verifyWebhookSignature({ body: BODY_SMALL, header: HEADER_SMALL, secret: SECRET });
  });

  bench('invalid signature, small body (constant-time compare still runs)', async () => {
    await verifyWebhookSignature({ body: BODY_SMALL, header: HEADER_BAD, secret: SECRET });
  });
});

describe('verifyWebhookSignature — large body (~10 KB)', () => {
  bench('valid signature, large body', async () => {
    await verifyWebhookSignature({ body: BODY_LARGE, header: HEADER_LARGE, secret: SECRET });
  });
});
