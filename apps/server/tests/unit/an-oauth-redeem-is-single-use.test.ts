// Cookie-free OAuth v2 (2026-09-11) — the hand-off code in the fragment is a
// one-shot, 60-second pointer. Reverting these production lines reds it:
//   • routes/auth-oauth-client.ts /redeem `const raw = await deps.flowStore
//     .consume(handoffKey(body.code)); if (raw === null) throw new
//     BadRequestError('Hand-off code invalid, expired, or already used.')`
//     — a peek instead of a consume answers 200 twice.
//   • `const HANDOFF_TTL_SECONDS = 60` and the `flowStore.set(handoffKey(…),
//     …, HANDOFF_TTL_SECONDS)` in the top-level route — a longer TTL reds the
//     expiry arm.
//   • `RedeemBodySchema` (`z.string().regex(BASE64URL_256_BIT_RE)` ×2) — a
//     loosened shape reds the validation arm.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  completeToHandoff,
  mountOauthHarness,
  redeem,
  SESSION_PLAINTEXT,
} from './an-oauth-v2-harness.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('an OAuth /redeem is single-use', () => {
  it('first redeem mints the session; the identical second request is refused and mints nothing', async () => {
    const h = await mountOauthHarness();
    const { start, code } = await completeToHandoff(h);
    const first = await redeem(h, code, start.secret);
    expect(first.statusCode).toBe(200);
    expect(first.json<{ session_token?: string }>().session_token).toBe(SESSION_PLAINTEXT);
    const second = await redeem(h, code, start.secret);
    expect(second.statusCode).toBe(400);
    expect(second.json<{ detail?: string }>().detail).toMatch(/invalid, expired, or already used/);
    expect(h.linkCalls).toHaveLength(1);
    expect(h.sessionCalls).toHaveLength(1);
  });

  it('a hand-off older than 60 s is gone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); // only Date: Fastify + the IDP fetch deadline need real timers
    vi.setSystemTime(new Date('2026-09-11T10:00:00Z'));
    const h = await mountOauthHarness();
    const { start, code } = await completeToHandoff(h);
    vi.setSystemTime(new Date('2026-09-11T10:01:01Z'));
    const res = await redeem(h, code, start.secret);
    expect(res.statusCode).toBe(400);
    expect(h.sessionCalls).toHaveLength(0);
  });

  it('a never-issued code answers the same 400 as a consumed one (no enumeration oracle)', async () => {
    const h = await mountOauthHarness();
    const { start, code } = await completeToHandoff(h);
    const unknown = await redeem(
      h,
      code.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')),
      start.secret,
    );
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json<{ detail?: string }>().detail).toBe(
      'Hand-off code invalid, expired, or already used.',
    );
    // The real code is still redeemable — a miss on a different code must not burn it.
    expect((await redeem(h, code, start.secret)).statusCode).toBe(200);
  });

  it('a body outside the 43-char base64url shape is refused by validation, before the store is touched', async () => {
    const h = await mountOauthHarness();
    await completeToHandoff(h);
    const consumesBefore = h.storeConsumes.length;
    for (const payload of [
      { code: 'short', flow_secret: 'a'.repeat(43) },
      { code: 'a'.repeat(43), flow_secret: 'a'.repeat(44) },
      { code: 'a'.repeat(43) },
      { code: '+'.repeat(43), flow_secret: 'a'.repeat(43) },
    ]) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/auth/oauth-client/redeem',
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(h.storeConsumes).toHaveLength(consumesBefore);
  });
});
