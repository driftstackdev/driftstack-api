// A customer may SET a bundled monthly soft cap of at most $100 (10,000 cents).
//
// It was $10,000: the column's storage bound (migration 0050's CHECK), exposed
// as the write bound, so one PATCH could authorise Driftstack's key to spend
// $10,000 a month for one account. Lowered 2026-09-19.
//
// ⛔ Caps already stored above $100 are GRANDFATHERED, not clamped: they are
// read, returned and enforced exactly as before, and re-sending the SAME value is
// accepted — because both clients (desktop Settings, dashboard settings) save
// the whole object, so a customer with a $500 cap who only flips consent
// re-sends 50,000. Refusing that would lock them out of their own consent toggle.
// A grandfathered cap may also be LOWERED to any value, including one still
// above $100 (the owner's decision, 2026-09-19: lowering only shrinks exposure).
// It can never be RAISED, and going back up after lowering is raising: a
// grandfathered amount, once given up, is gone.

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

interface Settings {
  consent: boolean;
  monthly_cap_usd_cents: number;
}

describe('a new bundled cap is at most $100; older higher caps are kept', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  const patch = (payload: Record<string, unknown>) =>
    fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload,
    });

  it('CRITICAL 10,000 is accepted and 10,001 is refused as a validation failure naming the field and the limit', async () => {
    fx = await buildTestApp({ enableBundledLlm: { consent: true, monthlyCapUsdCents: 2_000 } });

    const ok = await patch({ monthly_cap_usd_cents: 10_000 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<Settings>().monthly_cap_usd_cents).toBe(10_000);

    const over = await patch({ monthly_cap_usd_cents: 10_001 });
    expect(over.statusCode).toBe(400);
    const body = over.json<{
      type: string;
      issues: { fieldErrors: Record<string, string[]> };
    }>();
    expect(body.type).toBe(PROBLEM_TYPES.ValidationFailed);
    expect(body.issues.fieldErrors['monthly_cap_usd_cents']?.[0]).toMatch(
      /at most 10000 \(\$100\.00\)/,
    );

    // The refused write changed nothing.
    const get = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(get.json<Settings>().monthly_cap_usd_cents).toBe(10_000);
  });

  it('CRITICAL the old $10,000 ceiling is no longer settable as a new value', async () => {
    fx = await buildTestApp({ enableBundledLlm: { consent: true, monthlyCapUsdCents: 2_000 } });
    expect((await patch({ monthly_cap_usd_cents: 1_000_000 })).statusCode).toBe(400);
  });

  it('CRITICAL a grandfathered cap is returned and kept when the customer only flips consent', async () => {
    fx = await buildTestApp({ enableBundledLlm: { consent: true, monthlyCapUsdCents: 50_000 } });
    const res = await patch({ consent: false });
    expect(res.statusCode).toBe(200);
    expect(res.json<Settings>()).toEqual({ consent: false, monthly_cap_usd_cents: 50_000 });
  });

  it('CRITICAL a grandfathered cap may be re-sent unchanged — both clients save the whole settings object', async () => {
    fx = await buildTestApp({ enableBundledLlm: { consent: false, monthlyCapUsdCents: 50_000 } });
    const res = await patch({ consent: false, monthly_cap_usd_cents: 50_000 });
    expect(res.statusCode).toBe(200);
    expect(res.json<Settings>().monthly_cap_usd_cents).toBe(50_000);
  });

  it('CRITICAL a grandfathered cap cannot be RAISED, and once lowered it cannot come back', async () => {
    fx = await buildTestApp({ enableBundledLlm: { consent: true, monthlyCapUsdCents: 50_000 } });
    expect((await patch({ monthly_cap_usd_cents: 50_001 })).statusCode).toBe(400);
    expect((await patch({ monthly_cap_usd_cents: 5_000 })).statusCode).toBe(200);
    expect((await patch({ monthly_cap_usd_cents: 50_000 })).statusCode).toBe(400);
  });

  it('CRITICAL a grandfathered cap may be LOWERED to a value still above $100, and then not raised again', async () => {
    fx = await buildTestApp({ enableBundledLlm: { consent: true, monthlyCapUsdCents: 50_000 } });
    // $500 -> $300: still above the new $100 maximum, and allowed, because it
    // only shrinks what Driftstack's key may spend for this account.
    expect((await patch({ monthly_cap_usd_cents: 30_000 })).statusCode).toBe(200);
    // …and the lowered value is now the ceiling: back up to $400 is refused.
    expect((await patch({ monthly_cap_usd_cents: 40_000 })).statusCode).toBe(400);
    // Lowering further is still fine.
    expect((await patch({ monthly_cap_usd_cents: 20_000 })).statusCode).toBe(200);
  });

  it('a grandfathered cap is still what the status endpoint reports', async () => {
    fx = await buildTestApp({ enableBundledLlm: { consent: true, monthlyCapUsdCents: 50_000 } });
    const status = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/bundled-llm-status',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(status.json<{ cap_cents: number }>().cap_cents).toBe(50_000);
  });
});
