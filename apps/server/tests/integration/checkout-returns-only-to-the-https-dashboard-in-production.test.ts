// Checkout returns only to the HTTPS dashboard in production (security sweep
// 2026-09-24, finding #31).
//
// POST /v1/billing/checkout-session accepts a customer-supplied success_url and
// cancel_url, and the return-URL allowlist is the guard against sending a payer
// somewhere else after they enter their card. The list held two plain-HTTP
// origins for local development and the e2e suite — `http://localhost:5173` and
// `http://app.driftstack.local`, the second resolved by mDNS on whatever network
// the payer is on — and it was the same list in every environment. Those two are
// now accepted only when the server is not running in production; production
// accepts the HTTPS dashboard alone.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(HERE, '..', '..', 'src');

const DEVELOPMENT_ORIGINS = ['http://localhost:5173', 'http://app.driftstack.local'] as const;

async function checkout(
  fx: TestAppFixture,
  field: 'success_url' | 'cancel_url',
  url: string,
): Promise<{ status: number; detail: string }> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/billing/checkout-session',
    headers: { authorization: `Bearer ${fx.plaintext}` },
    payload: { tier: 'api_builder', billing_period: 'monthly', [field]: url },
  });
  return {
    status: res.statusCode,
    detail: res.statusCode === 200 ? '' : (res.json<{ detail?: string }>().detail ?? ''),
  };
}

describe('checkout returns only to the HTTPS dashboard in production', () => {
  let fx: TestAppFixture | undefined;

  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  for (const field of ['success_url', 'cancel_url'] as const) {
    for (const origin of DEVELOPMENT_ORIGINS) {
      it(`CRITICAL production refuses a ${field} on the plain-HTTP development origin ${origin}, and creates no Checkout`, async () => {
        fx = await buildTestApp();
        const result = await checkout(fx, field, `${origin}/billing/success`);
        expect(result.status, `${field}=${origin} was accepted in production`).toBe(400);
        expect(result.detail).toContain(field);
        expect(result.detail).toContain('allowlist');
        expect(fx.billingProvider.state.checkoutSessions).toHaveLength(0);
      });

      it(`outside production, a ${field} on ${origin} is still accepted for local development and the e2e suite`, async () => {
        fx = await buildTestApp({ allowDevelopmentReturnOrigins: true });
        const result = await checkout(fx, field, `${origin}/billing/success`);
        expect(result.status, result.detail).toBe(200);
      });
    }

    it(`control: production accepts a ${field} on the HTTPS dashboard`, async () => {
      fx = await buildTestApp();
      const result = await checkout(fx, field, 'https://app.driftstack.io/billing/success');
      expect(result.status, result.detail).toBe(200);
    });
  }

  it('CRITICAL the server admits the development origins only when it is not running in production', () => {
    const bootstrap = readFileSync(resolve(SERVER_SRC, 'lib/bootstrap.ts'), 'utf8');
    expect(bootstrap).toMatch(/allowDevelopmentReturnOrigins: config\.nodeEnv !== 'production'/);
  });
});
