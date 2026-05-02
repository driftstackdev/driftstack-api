// Round-trip tests: server signs, SDK verifier accepts.
// (The SDK verifier itself is unit-tested separately in
// packages/sdk-typescript/tests/unit/webhook-signature.test.ts.)

import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '@driftstack/sdk';
import {
  generateWebhookSecret,
  signWebhookPayload,
  webhookSecretPrefix,
} from '../../src/lib/webhook-signing.js';

describe('generateWebhookSecret', () => {
  it('produces a key with the expected shape: whsec_<32 base32 chars>', () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[a-z2-7]{32}$/);
  });

  it('produces high-entropy distinct secrets', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateWebhookSecret());
    expect(seen.size).toBe(200);
  });
});

describe('webhookSecretPrefix', () => {
  it('returns the first 12 chars', () => {
    const prefix = webhookSecretPrefix('whsec_abcdefghijklmnop');
    expect(prefix).toBe('whsec_abcdef');
    expect(prefix).toHaveLength(12);
  });
});

describe('signWebhookPayload', () => {
  it('produces a header in t=…,v1=… format', () => {
    const header = signWebhookPayload({
      body: '{"hello":"world"}',
      secret: 'whsec_test',
      timestampSec: 1750000000,
    });
    expect(header).toMatch(/^t=1750000000,v1=[0-9a-f]{64}$/);
  });

  it('different bodies produce different signatures', () => {
    const a = signWebhookPayload({ body: 'a', secret: 'whsec_test', timestampSec: 1 });
    const b = signWebhookPayload({ body: 'b', secret: 'whsec_test', timestampSec: 1 });
    expect(a).not.toBe(b);
  });

  it('different timestamps produce different signatures even for the same body', () => {
    const a = signWebhookPayload({ body: 'x', secret: 'whsec_test', timestampSec: 1 });
    const b = signWebhookPayload({ body: 'x', secret: 'whsec_test', timestampSec: 2 });
    expect(a).not.toBe(b);
  });
});

describe('round-trip with SDK verifier', () => {
  it('SDK verifyWebhookSignature accepts a server-signed payload', async () => {
    const secret = generateWebhookSecret();
    const body = JSON.stringify({ id: 'evt_123', type: 'session.completed' });
    const now = Date.now();
    const header = signWebhookPayload({
      body,
      secret,
      timestampSec: Math.floor(now / 1000),
    });
    const ok = await verifyWebhookSignature({ body, header, secret, nowMs: now });
    expect(ok).toBe(true);
  });

  it('SDK rejects when secret differs', async () => {
    const realSecret = generateWebhookSecret();
    const wrongSecret = generateWebhookSecret();
    const body = '{"x":1}';
    const t = Math.floor(Date.now() / 1000);
    const header = signWebhookPayload({ body, secret: realSecret, timestampSec: t });
    const ok = await verifyWebhookSignature({ body, header, secret: wrongSecret });
    expect(ok).toBe(false);
  });

  it('SDK rejects when body is tampered', async () => {
    const secret = generateWebhookSecret();
    const t = Math.floor(Date.now() / 1000);
    const header = signWebhookPayload({ body: 'original', secret, timestampSec: t });
    const ok = await verifyWebhookSignature({ body: 'tampered', header, secret });
    expect(ok).toBe(false);
  });
});
