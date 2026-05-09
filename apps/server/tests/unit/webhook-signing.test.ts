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

// V-397 — V-359 dual-signing during rotation grace at the
// signWebhookPayload primitive level.
//
// Production note: there are TWO webhook delivery paths in the
// codebase. webhook-worker.ts uses signWebhookPayload (Stripe-
// style `t=…,v1=…` header) but does NOT thread secretPrev through
// — it only single-signs. durable-webhook-delivery.ts emits two
// SEPARATE headers (`x-driftstack-signature` +
// `x-driftstack-signature-prev`), each a raw hex digest, and that
// path IS what runs grace-period dual-signing in production. The
// SDK verifier accepts the two-header form via the `headerPrev`
// input.
//
// The dual-`v1=` form below is therefore an internal-use code
// path of signWebhookPayload — it CAN be emitted, but production
// dispatchers don't reach for it. These tests pin the primitive
// behavior so a future consolidation onto the Stripe-style format
// has a known reference point. Format-consolidation queued as a
// separate slice (TD-snap).
describe('V-359 dual-signing — signWebhookPayload primitive', () => {
  it('emits two v1=… entries when secretPrev is set', () => {
    const header = signWebhookPayload({
      body: '{"hello":"world"}',
      secret: 'whsec_new',
      secretPrev: 'whsec_old',
      timestampSec: 1750000000,
    });
    expect(header).toMatch(/^t=1750000000,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/);
    const matches = header.match(/v1=([0-9a-f]{64})/g)!;
    expect(matches).toHaveLength(2);
    // Distinct digests — different secrets, same signed string.
    expect(matches[0]).not.toBe(matches[1]);
  });

  it('omits the second v1= when secretPrev is undefined or empty', () => {
    const a = signWebhookPayload({ body: 'x', secret: 's1', timestampSec: 1 });
    expect(a.match(/v1=/g)).toHaveLength(1);
    const b = signWebhookPayload({ body: 'x', secret: 's1', secretPrev: '', timestampSec: 1 });
    expect(b.match(/v1=/g)).toHaveLength(1);
    expect(a).toBe(b);
  });

  it('SDK verifier currently keeps only the LAST v1= entry — an inherent limitation of dual-`v1=` consumed via the single-header path. Production avoids this by emitting separate headers (header + headerPrev) instead.', async () => {
    const oldSecret = generateWebhookSecret();
    const newSecret = generateWebhookSecret();
    const body = '{"x":1}';
    const t = Math.floor(Date.now() / 1000);
    const header = signWebhookPayload({
      body,
      secret: newSecret,
      secretPrev: oldSecret,
      timestampSec: t,
    });
    // OLD secret holders pass — parser keeps the LAST v1= which
    // is the prev-secret HMAC.
    const okOld = await verifyWebhookSignature({ body, header, secret: oldSecret });
    expect(okOld).toBe(true);
    // NEW secret holders FAIL when consuming the dual-`v1=` form
    // through a single header; this is the limitation the prod
    // dispatcher avoids by sending two separate headers.
    const okNew = await verifyWebhookSignature({ body, header, secret: newSecret });
    expect(okNew).toBe(false);
  });
});

// V-397 — V-359 separate-header path (the actual production form).
// `verifyWebhookSignature({ header, headerPrev, secret })` accepts
// either header matching the secret. This is the path the durable
// webhook dispatcher uses for grace-period rotation.
describe('V-359 separate-header path (verifier headerPrev acceptance)', () => {
  it('verifier accepts when only the prev header carries the matching secret', async () => {
    const oldSecret = generateWebhookSecret();
    const newSecret = generateWebhookSecret();
    const body = '{"x":1}';
    const t = Math.floor(Date.now() / 1000);
    const headerCurr = signWebhookPayload({ body, secret: newSecret, timestampSec: t });
    const headerPrev = signWebhookPayload({ body, secret: oldSecret, timestampSec: t });
    // Customer hasn't rolled yet — verifier still has old secret.
    const ok = await verifyWebhookSignature({
      body,
      header: headerCurr,
      headerPrev,
      secret: oldSecret,
    });
    expect(ok).toBe(true);
  });

  it('verifier accepts when only the current header carries the matching secret', async () => {
    const oldSecret = generateWebhookSecret();
    const newSecret = generateWebhookSecret();
    const body = '{"x":1}';
    const t = Math.floor(Date.now() / 1000);
    const headerCurr = signWebhookPayload({ body, secret: newSecret, timestampSec: t });
    const headerPrev = signWebhookPayload({ body, secret: oldSecret, timestampSec: t });
    // Customer has rolled — verifier has new secret.
    const ok = await verifyWebhookSignature({
      body,
      header: headerCurr,
      headerPrev,
      secret: newSecret,
    });
    expect(ok).toBe(true);
  });

  it('verifier rejects when neither header matches', async () => {
    const oldSecret = generateWebhookSecret();
    const newSecret = generateWebhookSecret();
    const unrelated = generateWebhookSecret();
    const body = '{"x":1}';
    const t = Math.floor(Date.now() / 1000);
    const headerCurr = signWebhookPayload({ body, secret: newSecret, timestampSec: t });
    const headerPrev = signWebhookPayload({ body, secret: oldSecret, timestampSec: t });
    const ok = await verifyWebhookSignature({
      body,
      header: headerCurr,
      headerPrev,
      secret: unrelated,
    });
    expect(ok).toBe(false);
  });
});
