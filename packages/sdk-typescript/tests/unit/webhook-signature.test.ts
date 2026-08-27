import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  // ── the FUTURE half of the skew window ──────────────────────────────────────
  //
  // The two arms above walk the PAST only. `sdk-typescript-webhook-signature-content-parity`
  // states why that is not enough, in its own words: "the `Math.abs` is load-bearing —
  // it catches BOTH past-stale (replay) AND future-clock-skew (attacker forging a
  // timestamp far in the future). Drift to one-sided `now - timestampMs >` would let
  // future-dated signatures slip through." It asserts the SUBSTRING `Math.abs`, which
  // any rewrite that keeps the call while changing the comparison would satisfy.
  //
  // MEASURED: replacing `Math.abs(now - parsed.timestampMs)` with
  // `(now - parsed.timestampMs)` — one-sided, so a future-dated signature never
  // expires — left all 244 SDK unit tests green.
  //
  // ⚠️ The other two SDKs already cover this. sdk-python has
  // `test_rejects_future_timestamp_outside_tolerance` and sdk-go has `farFuture :=
  // now.Add(10 * time.Minute)`; TypeScript was the odd one out on a security property
  // its own siblings check. Cross-SDK parity is not a nicety here — a customer picks
  // one SDK and gets whatever that one enforces.
  it('rejects a FUTURE-dated timestamp outside tolerance. A forged far-future timestamp is a signature that never expires: it stays inside any past-only window forever, so the replay bound the header exists to impose simply does not apply to it.', async () => {
    const now = Date.now();
    const t = Math.floor(now / 1000) + 600; // 10 minutes ahead
    const body = 'x';
    const ok = await verifyWebhookSignature({
      body,
      header: sign(body, t),
      secret: SECRET,
      nowMs: now,
    });
    expect(ok, 'a signature dated 10 minutes in the future was accepted').toBe(false);
  });

  // The comparison is `> tolerance * 1000` — exclusive — so exactly-at-tolerance is
  // INSIDE the window. Both edges are driven because an off-by-one that flipped the
  // operator would still pass every arm above: 200s and 600s are nowhere near 300s.
  it('accepts a timestamp exactly AT the tolerance edge, past side. The check is exclusive (`>`), so the boundary itself is inside the window — pinning it means a flip to `>=` is a failure rather than a silent one-second narrowing.', async () => {
    const now = Date.now();
    const t = Math.floor(now / 1000) - 300; // default tolerance is 300s
    const body = 'edge';
    const ok = await verifyWebhookSignature({
      body,
      header: sign(body, t),
      secret: SECRET,
      nowMs: Math.floor(now / 1000) * 1000,
    });
    expect(ok, 'a signature exactly at the tolerance edge was rejected').toBe(true);
  });

  it('rejects one second BEYOND the tolerance edge, past side. With the arm above this brackets the boundary, so a widened window cannot pass as "still within tolerance".', async () => {
    const now = Date.now();
    const t = Math.floor(now / 1000) - 301;
    const body = 'edge';
    const ok = await verifyWebhookSignature({
      body,
      header: sign(body, t),
      secret: SECRET,
      nowMs: Math.floor(now / 1000) * 1000,
    });
    expect(ok, 'a signature one second past the edge was accepted').toBe(false);
  });

  it('rejects one second beyond the tolerance edge, FUTURE side. The same bracket on the half nothing was walking — and the half a one-sided comparison leaves wide open.', async () => {
    const now = Date.now();
    const t = Math.floor(now / 1000) + 301;
    const body = 'edge';
    const ok = await verifyWebhookSignature({
      body,
      header: sign(body, t),
      secret: SECRET,
      nowMs: Math.floor(now / 1000) * 1000,
    });
    expect(ok, 'a signature one second into the future beyond tolerance was accepted').toBe(false);
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

// V-1408 — two paths in the SDK's verifier that nothing exercised. This is code the
// CUSTOMER runs, in their own runtime, to decide whether a webhook is genuine, so both
// failure directions are theirs to live with: rejecting a real delivery, or accepting a
// forged one.
describe('verifyWebhookSignature — the header may arrive as an array, and crypto may be absent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('CRITICAL accepts a header delivered as a string ARRAY, which is how a duplicated `driftstack-signature` reaches a Node handler. The input type has always said `string | string[]`; nothing had ever passed the array form, and treating it as a plain string makes it fail the `typeof` check and reject a genuine delivery — a customer-visible outage with a correct signature on the wire.', async () => {
    const now = Date.now();
    const t = Math.floor(now / 1000);
    const body = '{"event":"session.completed"}';
    const header = sign(body, t);

    await expect(
      verifyWebhookSignature({ body, header: [header], secret: SECRET, nowMs: now }),
    ).resolves.toBe(true);
    await expect(
      verifyWebhookSignature({ body, header: [header, header], secret: SECRET, nowMs: now }),
    ).resolves.toBe(true);
  });

  it('CRITICAL reads the FIRST value of the array. A proxy that duplicates the header repeats the genuine one; anything appended after it is the part an attacker could influence, so first-wins is the safe reading and the one that must not drift to last-wins.', async () => {
    const now = Date.now();
    const t = Math.floor(now / 1000);
    const body = '{"event":"session.completed"}';
    const genuine = sign(body, t);
    const forged = sign(body, t, 'whsec_attacker_secret');

    await expect(
      verifyWebhookSignature({ body, header: [genuine, forged], secret: SECRET, nowMs: now }),
    ).resolves.toBe(true);
    await expect(
      verifyWebhookSignature({ body, header: [forged, genuine], secret: SECRET, nowMs: now }),
      'a forged value first must not be rescued by a genuine one after it',
    ).resolves.toBe(false);
  });

  it('CRITICAL fails CLOSED when the runtime has no WebCrypto. The SDK ships into browsers and older Node, and the probe for `crypto.subtle` is deliberate — but an absent primitive must mean "cannot verify, reject", never a throw the customer catches into an accept-by-default, and never a silent true.', async () => {
    const now = Date.now();
    const t = Math.floor(now / 1000);
    const body = '{"event":"session.completed"}';
    const header = sign(body, t);

    vi.stubGlobal('crypto', undefined);
    await expect(
      verifyWebhookSignature({ body, header, secret: SECRET, nowMs: now }),
    ).resolves.toBe(false);

    vi.stubGlobal('crypto', {});
    await expect(
      verifyWebhookSignature({ body, header, secret: SECRET, nowMs: now }),
      'a crypto object without subtle is the same situation and must answer the same way',
    ).resolves.toBe(false);
  });
  // V-2010 — an empty secret is the one input where all three SDKs answered
  // differently and all three were wrong: Python and Go hashed with a zero-length
  // key and VERIFIED an HMAC an attacker computes with no secret at all, and this
  // one threw DataError out of subtle.importKey where the contract promises a
  // boolean. The forged header below is built with the empty key on purpose — a
  // signature made with SECRET would be refused for the ordinary reason and prove
  // nothing about this branch.
  it('CRITICAL an empty secret refuses a signature forged with the empty key, and returns false rather than throwing', async () => {
    const body = JSON.stringify({ id: 'evt_1' });
    const t = Math.floor(Date.now() / 1000);
    const forged = createHmac('sha256', '').update(`${t}.${body}`).digest('hex');
    await expect(
      verifyWebhookSignature({ body, header: `t=${t},v1=${forged}`, secret: '' }),
      'an attacker who knows the body and timestamp must not verify against an empty secret',
    ).resolves.toBe(false);
  });
});
