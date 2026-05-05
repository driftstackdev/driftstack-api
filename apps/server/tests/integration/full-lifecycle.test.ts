// V-166 — full customer lifecycle integration test (PRIORITY 5).
//
// Walks the customer journey across multiple subsystems on a single
// fixture, asserting they interlock correctly. Each subsystem is
// individually tested elsewhere (auth-flows.test.ts, billing.test.ts,
// stripe-webhooks-mutations.test.ts, sessions.test.ts, etc.); V-166
// is the cross-cutting test that catches "subsystems work in
// isolation but not together" regressions.
//
// SURFACED GAP (left unfixed in V-166 — separate workstream): the V-079
// web session minted by /v1/auth/verify-email cannot be used as a
// bearer on /v1/api-keys. The requireAuth middleware in
// apps/server/src/middleware/auth.ts only authenticates API keys
// (prefix lookup + scrypt verify); there is no parallel web-session
// auth path. That means a freshly-signed-up user has no path to mint
// their first API key without a separate provisioning step. Today,
// tests use the seedAccount fixture (which directly inserts an admin
// key); production presumably uses a founder-side or onboarding-flow
// provisioning path that hasn't landed yet.
//
// V-166 covers the parts that DO work end-to-end:
//   1. Signup → email verify → web session token returned (auth surface).
//   2. Pre-seeded admin key → scoped sub-key issuance → session create
//      → navigate → destroy → usage read (production session lifecycle).
//   3. Cache-invalidation cross-cutting: revoke the sub-key → next op
//      with the revoked key → 401 (D-020 / D-025 invariant).
//
// DEFERRED to follow-on V-NNN: Stripe trial-pack webhook simulation
// + post-purchase tier transition + session-create-on-trial-pack
// gating. The signature-verification path needs the test secret +
// computed-signature header; existing stripe-webhooks-mutations.test.ts
// has the harness but state isn't shared across fixtures cleanly.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

interface SignupResponse {
  verification_email_expires_at: string;
  debug_token?: string;
}

interface SessionEnvelope {
  session: {
    token: string;
    expires_at: string;
    account_id: string;
  };
}

interface ApiKeyResponse {
  id: string;
  plaintext: string;
  prefix: string;
  scopes: readonly string[];
}

interface DriverSessionResponse {
  id: string;
  status: string;
  archetype: string;
}

interface NavigateResponse {
  url: string;
  title: string;
}

interface UsageSummaryResponse {
  period_start: string;
  period_end: string;
  tier: string;
  totals: Record<string, number>;
  quotas: Record<string, number | null>;
}

describe('Full customer lifecycle (V-166)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('signup → verify-email → web session token issued (auth surface end-to-end)', async () => {
    fx = await buildTestApp();

    const signup = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: 'lifecycle-signup@driftstack.local',
        password: 'correct horse battery staple',
        name: 'Lifecycle Test User',
      },
    });
    expect(signup.statusCode).toBe(200);
    const signupBody = signup.json<SignupResponse>();
    expect(signupBody.debug_token).toBeDefined();

    const verify = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: signupBody.debug_token! },
    });
    expect(verify.statusCode).toBe(200);
    const session = verify.json<SessionEnvelope>().session;
    expect(session.token).toBeTruthy();
    expect(session.account_id).toMatch(/^acc_[0-9a-f-]{36}$/);
    expect(new Date(session.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('admin key → scoped sub-key → session lifecycle → /v1/usage round-trip', async () => {
    // Pre-seeded admin via fixture (today's path; future: web-session-mints-
    // first-key flow once that wiring lands).
    fx = await buildTestApp({ tier: 'api_builder' });

    // ─── 1. Mint a scoped (read+write only) sub-key ──────────────────────
    const mintKey = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'lifecycle-app-key', scopes: ['read', 'write'] },
    });
    expect(mintKey.statusCode).toBe(201);
    const subKey = mintKey.json<ApiKeyResponse>();
    expect(subKey.id).toMatch(/^key_[0-9a-f-]{36}$/);
    expect(subKey.plaintext.startsWith('ds_')).toBe(true);
    expect(subKey.scopes).toEqual(['read', 'write']);

    // ─── 2. Sub-key creates a session ────────────────────────────────────
    const createSession = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${subKey.plaintext}` },
      payload: { label: 'lifecycle-test-session' },
    });
    expect(createSession.statusCode).toBe(201);
    const session = createSession.json<DriverSessionResponse>();
    expect(session.id).toMatch(/^ses_[0-9a-f-]{36}$/);
    expect(session.status).toBe('ready');
    // V-154 archetype rename — verify the locked default flowed through.
    expect(session.archetype).toBe('iphone16pro_ios18_7_safari26_4');

    // ─── 3. Navigate ─────────────────────────────────────────────────────
    const navigate = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/navigate`,
      headers: { authorization: `Bearer ${subKey.plaintext}` },
      payload: { url: 'https://example.com/' },
    });
    expect(navigate.statusCode).toBe(200);
    expect(navigate.json<NavigateResponse>().url).toBe('https://example.com/');

    // ─── 4. Destroy (idempotent per V-167) ───────────────────────────────
    const destroy = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${session.id}`,
      headers: { authorization: `Bearer ${subKey.plaintext}` },
    });
    expect(destroy.statusCode).toBe(204);

    // V-167 fix: second DELETE on a destroyed session is a true no-op
    // returning 204 (REST DELETE idempotency convention). Pre-V-167
    // this returned 410 because requireOwned() threw before the early-
    // return short-circuit could run.
    const destroyAgain = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${session.id}`,
      headers: { authorization: `Bearer ${subKey.plaintext}` },
    });
    expect(destroyAgain.statusCode).toBe(204);

    // ─── 5. Usage endpoint responds ──────────────────────────────────────
    // Note: usage_records writers are not yet wired in production code
    // (per V-014/V-015 amendment + apps/server/src/services/usage.ts:51-53
    // comment). Endpoint returns the period summary with zeros today; this
    // assertion locks in the contract shape, not that usage is recorded.
    const usage = await fx.app.inject({
      method: 'GET',
      url: '/v1/usage',
      headers: { authorization: `Bearer ${subKey.plaintext}` },
    });
    expect(usage.statusCode).toBe(200);
    const usageBody = usage.json<UsageSummaryResponse>();
    expect(usageBody.period_start).toBeDefined();
    expect(usageBody.period_end).toBeDefined();
    expect(usageBody.tier).toBe('api_builder');
    expect(usageBody.totals).toBeDefined();
    expect(usageBody.quotas).toBeDefined();
  });

  it('revoking the sub-key invalidates the auth cache (D-020 / D-025 invariant)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });

    // Mint a sub-key for the revoke test.
    const mintKey = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'revoke-test-key', scopes: ['read', 'write'] },
    });
    const subKey = mintKey.json<ApiKeyResponse>();

    // Use it once to populate the auth cache.
    const sessionA = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${subKey.plaintext}` },
      payload: { label: 'pre-revoke' },
    });
    expect(sessionA.statusCode).toBe(201);

    // Revoke the sub-key via the parent admin key.
    const revoke = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${subKey.id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(revoke.statusCode).toBe(204);

    // Subsequent op with the revoked key fails 401. Without
    // invalidation, the cached AccountContext from the prior call
    // would still serve a successful 201.
    const postRevoke = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${subKey.plaintext}` },
      payload: { label: 'post-revoke' },
    });
    expect(postRevoke.statusCode).toBe(401);

    // The parent admin key remains valid — invalidation is per-key,
    // not per-account, so revoking a sub-key does not cascade.
    const adminStillWorks = await fx.app.inject({
      method: 'GET',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(adminStillWorks.statusCode).toBe(200);
  });
});
