import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '../../src/webhook-signature.js';

const SECRET = 'whsec_test_supersecret';

function sign(body: string, timestamp: number, secret = SECRET): string {
  const hex = createHmac('sha256', secret).update(`${timestamp.toString()}.${body}`).digest('hex');
  return `t=${timestamp.toString()},v1=${hex}`;
}

describe('verifyWebhookSignature', () => {
  it('accepts a valid signature with current timestamp', async () => {
    const now = Date.now();
    const t = Math.floor(now / 1000);
    const body = '{"event":"session.completed"}';
    const ok = await verifyWebhookSignature({
      body,
      header: sign(body, t),
      secret: SECRET,
      nowMs: now,
    });
    expect(ok).toBe(true);
  });

  it('rejects when secret differs', async () => {
    const now = Date.now();
    const t = Math.floor(now / 1000);
    const body = 'x';
    const ok = await verifyWebhookSignature({
      body,
      header: sign(body, t, 'wrong-secret'),
      secret: SECRET,
      nowMs: now,
    });
    expect(ok).toBe(false);
  });

  it('rejects when body is tampered', async () => {
    const now = Date.now();
    const t = Math.floor(now / 1000);
    const ok = await verifyWebhookSignature({
      body: 'tampered',
      header: sign('original', t),
      secret: SECRET,
      nowMs: now,
    });
    expect(ok).toBe(false);
  });

  it('rejects timestamps outside tolerance window', async () => {
    const now = Date.now();
    const t = Math.floor(now / 1000) - 600; // 10 minutes old
    const body = 'x';
    const ok = await verifyWebhookSignature({
      body,
      header: sign(body, t),
      secret: SECRET,
      nowMs: now,
    });
    expect(ok).toBe(false);
  });

  it('accepts timestamps within configured tolerance', async () => {
    const now = Date.now();
    const t = Math.floor(now / 1000) - 200; // ~3 minutes old (within default 5 min)
    const body = 'x';
    const ok = await verifyWebhookSignature({
      body,
      header: sign(body, t),
      secret: SECRET,
      nowMs: now,
    });
    expect(ok).toBe(true);
  });

  it('rejects malformed header', async () => {
    expect(
      await verifyWebhookSignature({ body: 'x', header: 'not-a-valid-header', secret: SECRET }),
    ).toBe(false);
    expect(await verifyWebhookSignature({ body: 'x', header: 't=12345', secret: SECRET })).toBe(
      false,
    );
    expect(await verifyWebhookSignature({ body: 'x', header: 'v1=abc', secret: SECRET })).toBe(
      false,
    );
    expect(await verifyWebhookSignature({ body: 'x', header: undefined, secret: SECRET })).toBe(
      false,
    );
  });

  it('accepts Uint8Array body', async () => {
    const now = Date.now();
    const t = Math.floor(now / 1000);
    const bodyText = '{"x":1}';
    const body = new TextEncoder().encode(bodyText);
    const ok = await verifyWebhookSignature({
      body,
      header: sign(bodyText, t),
      secret: SECRET,
      nowMs: now,
    });
    expect(ok).toBe(true);
  });
});
