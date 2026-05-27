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

  // Dual-`v1=` in ONE header (Stripe-style multi-signature). During a
  // secret-rotation grace window the server dual-signs into a single
  // `x-driftstack-signature: t=,v1=<new>,v1=<old>` header (no separate
  // -prev header). The verifier must accept if EITHER signature matches the
  // configured secret — regardless of order — so a customer on the new OR
  // the old secret verifies during grace.
  describe('multi-v1 single header (rotation dual-sign)', () => {
    const NEW = 'whsec_new_rotated';
    const OLD = 'whsec_old_pre_rotation';
    const h = (b: string, t: number, s: string) =>
      createHmac('sha256', s).update(`${t.toString()}.${b}`).digest('hex');

    it('accepts the new-secret holder when v1=<new> is FIRST (was the discarded position)', async () => {
      const now = Date.now();
      const t = Math.floor(now / 1000);
      const body = '{"event":"x"}';
      const header = `t=${t.toString()},v1=${h(body, t, NEW)},v1=${h(body, t, OLD)}`;
      expect(await verifyWebhookSignature({ body, header, secret: NEW, nowMs: now })).toBe(true);
    });

    it('accepts the old-secret holder when v1=<old> is LAST', async () => {
      const now = Date.now();
      const t = Math.floor(now / 1000);
      const body = '{"event":"x"}';
      const header = `t=${t.toString()},v1=${h(body, t, NEW)},v1=${h(body, t, OLD)}`;
      expect(await verifyWebhookSignature({ body, header, secret: OLD, nowMs: now })).toBe(true);
    });

    it('rejects a secret matching NEITHER signature', async () => {
      const now = Date.now();
      const t = Math.floor(now / 1000);
      const body = '{"event":"x"}';
      const header = `t=${t.toString()},v1=${h(body, t, NEW)},v1=${h(body, t, OLD)}`;
      expect(
        await verifyWebhookSignature({ body, header, secret: 'whsec_unrelated', nowMs: now }),
      ).toBe(false);
    });
  });

  // V-359 — rotation grace: when the customer hasn't yet rolled the new
  // secret across their verifier, they pass `headerPrev` (the prev
  // signature header from the inbound request); the verifier accepts
  // EITHER header matching the supplied secret.
  describe('rotation grace (headerPrev)', () => {
    const NEW_SECRET = 'whsec_new_rotated';
    const OLD_SECRET = 'whsec_old_pre_rotation';

    it('accepts when only the prev header matches the (old) secret', async () => {
      const now = Date.now();
      const t = Math.floor(now / 1000);
      const body = '{"event":"x"}';
      // Server signs with both secrets; customer hasn't yet rolled
      // forward, so they verify against OLD_SECRET. Prev header
      // contains the OLD-secret HMAC.
      const ok = await verifyWebhookSignature({
        body,
        header: sign(body, t, NEW_SECRET),
        headerPrev: sign(body, t, OLD_SECRET),
        secret: OLD_SECRET,
        nowMs: now,
      });
      expect(ok).toBe(true);
    });

    it('accepts when only the current header matches the (new) secret', async () => {
      const now = Date.now();
      const t = Math.floor(now / 1000);
      const body = '{"event":"x"}';
      // Customer has rolled forward to NEW_SECRET.
      const ok = await verifyWebhookSignature({
        body,
        header: sign(body, t, NEW_SECRET),
        headerPrev: sign(body, t, OLD_SECRET),
        secret: NEW_SECRET,
        nowMs: now,
      });
      expect(ok).toBe(true);
    });

    it('rejects when neither header matches the configured secret', async () => {
      const now = Date.now();
      const t = Math.floor(now / 1000);
      const body = 'x';
      const ok = await verifyWebhookSignature({
        body,
        header: sign(body, t, NEW_SECRET),
        headerPrev: sign(body, t, OLD_SECRET),
        secret: 'whsec_unrelated',
        nowMs: now,
      });
      expect(ok).toBe(false);
    });

    it('headerPrev undefined keeps single-header behavior', async () => {
      const now = Date.now();
      const t = Math.floor(now / 1000);
      const body = 'x';
      const ok = await verifyWebhookSignature({
        body,
        header: sign(body, t, NEW_SECRET),
        secret: NEW_SECRET,
        nowMs: now,
      });
      expect(ok).toBe(true);
    });
  });
});
