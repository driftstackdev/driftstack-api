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
// Production note: webhook-worker.ts (the live delivery path) calls
// signWebhookPayload WITH `secretPrev` during a rotation grace
// window, emitting the Stripe-style dual-`v1=` single header
// `x-driftstack-signature: t=…,v1=<new>,v1=<old>`. (The forward-path
// durable-webhook-delivery.ts instead emits two SEPARATE headers
// `x-driftstack-signature` + `x-driftstack-signature-prev`; the SDK
// verifier accepts that form via the `headerPrev` input.)
//
// Finding #13 fix: the SDK verifier now collects EVERY `v1=` and
// accepts if our HMAC matches ANY (constant-time per candidate), so
// a verifier holding either the new OR the old secret passes the
// dual-`v1=` single-header form — no longer last-wins. These tests
// pin that primitive + verifier behavior.
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

  it('SDK verifier accepts EITHER secret from the dual-`v1=` single-header form (finding #13 — collects all v1=, no longer last-wins)', async () => {
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
    // OLD-secret holders pass (their HMAC is the LAST v1=).
    expect(await verifyWebhookSignature({ body, header, secret: oldSecret })).toBe(true);
    // NEW-secret holders ALSO pass now — their HMAC is the FIRST v1=,
    // which the pre-fix last-wins parser discarded. This is the live
    // rotation bug (#13) the verifier fix resolves.
    expect(await verifyWebhookSignature({ body, header, secret: newSecret })).toBe(true);
    // An unrelated secret matches neither v1=.
    expect(await verifyWebhookSignature({ body, header, secret: generateWebhookSecret() })).toBe(
      false,
    );
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
