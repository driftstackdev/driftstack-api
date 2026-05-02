import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '../../src/webhook-signature.js';

const SECRET = 'whsec_test_supersecret';

function sign(body: string, timestamp: number, secret = SECRET): string {
  const hex = createHmac('sha256', secret).update(`${timestamp.toString()}.${body}`).digest('hex');
  return `t=${timestamp.toString()},v1=${hex}`;
}

describe('verifyWebhookSignature', () => {
  it('accepts a valid signature with current timestamp', () => {
    const now = Date.now();
    const t = Math.floor(now / 1000);
    const body = '{"event":"session.completed"}';
    const ok = verifyWebhookSignature({
      body,
      header: sign(body, t),
      secret: SECRET,
      nowMs: now,
    });
    expect(ok).toBe(true);
  });

  it('rejects when secret differs', () => {
    const now = Date.now();
    const t = Math.floor(now / 1000);
    const body = 'x';
    const ok = verifyWebhookSignature({
      body,
      header: sign(body, t, 'wrong-secret'),
      secret: SECRET,
      nowMs: now,
    });
    expect(ok).toBe(false);
  });

  it('rejects when body is tampered', () => {
    const now = Date.now();
    const t = Math.floor(now / 1000);
    const ok = verifyWebhookSignature({
      body: 'tampered',
      header: sign('original', t),
      secret: SECRET,
      nowMs: now,
    });
    expect(ok).toBe(false);
  });

  it('rejects timestamps outside tolerance window', () => {
    const now = Date.now();
    const t = Math.floor(now / 1000) - 600; // 10 minutes old
    const body = 'x';
    const ok = verifyWebhookSignature({
      body,
      header: sign(body, t),
      secret: SECRET,
      nowMs: now,
    });
    expect(ok).toBe(false);
  });

  it('accepts timestamps within configured tolerance', () => {
    const now = Date.now();
    const t = Math.floor(now / 1000) - 200; // ~3 minutes old (within default 5 min)
    const body = 'x';
    const ok = verifyWebhookSignature({
      body,
      header: sign(body, t),
      secret: SECRET,
      nowMs: now,
    });
    expect(ok).toBe(true);
  });

  it('rejects malformed header', () => {
    expect(
      verifyWebhookSignature({ body: 'x', header: 'not-a-valid-header', secret: SECRET }),
    ).toBe(false);
    expect(verifyWebhookSignature({ body: 'x', header: 't=12345', secret: SECRET })).toBe(false);
    expect(verifyWebhookSignature({ body: 'x', header: 'v1=abc', secret: SECRET })).toBe(false);
    expect(verifyWebhookSignature({ body: 'x', header: undefined, secret: SECRET })).toBe(false);
  });

  it('accepts Buffer body', () => {
    const now = Date.now();
    const t = Math.floor(now / 1000);
    const body = Buffer.from('{"x":1}', 'utf8');
    const ok = verifyWebhookSignature({
      body,
      header: sign('{"x":1}', t),
      secret: SECRET,
      nowMs: now,
    });
    expect(ok).toBe(true);
  });
});
