// V-166 + V-168 — full customer lifecycle integration test.
//
// Walks the customer journey across multiple subsystems on a single
// fixture, asserting they interlock correctly. Each subsystem is
// individually tested elsewhere (auth-flows.test.ts, billing.test.ts,
// stripe-webhooks-mutations.test.ts, sessions.test.ts, etc.); the
// cross-cutting tests here catch "subsystems work in isolation but
// not together" regressions.
//
// V-166 surfaced + V-168 fixed: web session bearer tokens now
// authenticate against any route using requireAuth (including
// /v1/api-keys). Self-serve onboarding works end-to-end:
//   signup → verify-email → web session →
//   accept legal docs → mint first API key → use it.
//
// Tests:
//   1. signup → verify → web-session-mints-API-key (V-168 onboarding).
//   2. logout invalidates the cached web-session AccountContext (V-168
//      D-020 / D-025 invariant).
//   3. admin key → scoped sub-key → session create → navigate →
//      destroy → usage read (production session lifecycle).
//   4. revoking the sub-key invalidates the auth cache (D-020 / D-025
//      invariant — symmetric to test 2 but for API keys).
//   5. web session can mint a customer-scoped sub-key but is blocked
//      from minting an elevated (admin/driftstack_internal_admin) key
//      (V-174 scope model + de-escalation: account_owner control, no
//      privilege escalation).
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

interface RequiredLegalDoc {
  document_key: string;
  current_version: string;
  content_hash: string;
}

/**
 * V-168 helper — accept all required legal documents for the calling
 * web-session bearer. Production onboarding does this between signup
 * and first-key-issuance; the API-key creation gate (V-049) blocks
 * with 409 LegalAcceptanceRequired until done.
 */
async function acceptAllLegalDocs(fx: TestAppFixture, bearer: string): Promise<void> {
  const required = await fx.app.inject({
    method: 'GET',
    url: '/v1/legal/required',
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (required.statusCode !== 200) return;
  const docs = required.json<{ data: RequiredLegalDoc[] }>().data;
  for (const doc of docs) {
    await fx.app.inject({
      method: 'POST',
      url: '/v1/legal/accept',
      headers: { authorization: `Bearer ${bearer}` },
      payload: {
        document_key: doc.document_key,
        version: doc.current_version,
        content_hash: doc.content_hash,
      },
    });
  }
}

/** Mirror a checkout upgrade for an account created through the signup flow.
 *  `3202fdb17` made Free an interactive desktop tier, so a fresh signup cannot
 *  mint a general customer API key until it is on a paid tier. */
async function upgradeSignupToPaidTier(fx: TestAppFixture, email: string): Promise<void> {
  const row = await fx.authFlowsRepo.findAccountByEmail(email);
  if (row === null) throw new Error(`no signup account for ${email}`);
  fx.authFlowsRepo.seedAccount({ ...row, tier: 'api_builder' });
  await fx.authCache.invalidateAccount(row.id);
}

describe('Full customer lifecycle (V-166)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('signup → verify-email → web-session bearer mints API key (V-168 onboarding)', async () => {
    // V-168 closed the gap surfaced by V-166's first attempt: web-session
    // bearer tokens can now authenticate against /v1/api-keys (and any
    // other route using requireAuth). This test exercises the full
    // self-serve onboarding path: signup → verify → web session →
    // mint first API key.
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

    // V-049 + V-168 — accept legal docs before key issuance. Production
    // onboarding interleaves this between signup and first-key.
    await acceptAllLegalDocs(fx, session.token);

    // `3202fdb17` made Free an interactive desktop tier: a brand-new signup
    // lands on `free` and CANNOT mint a general customer API key. The desktop
    // device flow issues its own restricted credential instead.
    const mintOnFree = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${session.token}` },
      payload: { name: 'first-api-key', scopes: ['read', 'write'] },
    });
    expect(mintOnFree.statusCode).toBe(403);
    expect(mintOnFree.json<{ detail: string }>().detail).toContain('"apiAccess"');

    // Upgrade the way checkout does, then the same web session mints the key.
    await upgradeSignupToPaidTier(fx, 'lifecycle-signup@driftstack.local');

    // V-168 — the web session token authenticates against /v1/api-keys.
    const mintKey = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${session.token}` },
      payload: { name: 'first-api-key', scopes: ['read', 'write'] },
    });
    expect(mintKey.statusCode).toBe(201);
    const apiKey = mintKey.json<ApiKeyResponse>();
    expect(apiKey.id).toMatch(/^key_[0-9a-f-]{36}$/);
    expect(apiKey.plaintext.startsWith('ds_')).toBe(true);
    expect(apiKey.scopes).toEqual(['read', 'write']);
  });

  it('logout invalidates the cached web-session AccountContext (V-168)', async () => {
    fx = await buildTestApp();

    const signup = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'logout-test@driftstack.local', password: 'correct horse battery staple' },
    });
    const verify = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: signup.json<SignupResponse>().debug_token! },
    });
    const sessionToken = verify.json<SessionEnvelope>().session.token;
    await upgradeSignupToPaidTier(fx, 'logout-test@driftstack.local');
    await acceptAllLegalDocs(fx, sessionToken);

    // Use the session to populate the auth cache (mint a key — works
    // because legal docs were just accepted).
    const populateCache = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { name: 'pre-logout', scopes: ['read', 'write'] },
    });
    expect(populateCache.statusCode).toBe(201);

    // Logout.
    const logout = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      payload: { token: sessionToken },
    });
    expect(logout.statusCode).toBe(200);

    // Subsequent op with the logged-out session token MUST 401. Without
    // invalidation, the cached AccountContext from the prior call would
    // still serve a successful 201.
    const postLogout = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { name: 'post-logout', scopes: ['read', 'write'] },
    });
    expect(postLogout.statusCode).toBe(401);
  });

  it('session purpose defaults to production_customer + flows through (V-169 AFP CF1)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });

    // Default — no purpose specified.
    const defaultRes = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { label: 'default-purpose' },
    });
    expect(defaultRes.statusCode).toBe(201);
    expect(defaultRes.json<DriverSessionResponse & { purpose: string }>().purpose).toBe(
      'production_customer',
    );

    // Explicit cumulative_rig_validation.
    const cumRes = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { label: 'cum-rig', purpose: 'cumulative_rig_validation' },
    });
    expect(cumRes.statusCode).toBe(201);
    expect(cumRes.json<DriverSessionResponse & { purpose: string }>().purpose).toBe(
      'cumulative_rig_validation',
    );

    // Explicit test_domain_probe.
    const probeRes = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { label: 'probe', purpose: 'test_domain_probe' },
    });
    expect(probeRes.statusCode).toBe(201);
    expect(probeRes.json<DriverSessionResponse & { purpose: string }>().purpose).toBe(
      'test_domain_probe',
    );

    // Invalid purpose rejected at schema validation.
    const invalidRes = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { label: 'bad', purpose: 'unknown_value' },
    });
    expect(invalidRes.statusCode).toBe(400);
  });

  it('web session mints a customer-scoped sub-key but is blocked from elevated scopes (V-174 de-escalation)', async () => {
    fx = await buildTestApp();

    const signup = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'scope-test@driftstack.local', password: 'correct horse battery staple' },
    });
    const verify = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: signup.json<SignupResponse>().debug_token! },
    });
    const sessionToken = verify.json<SessionEnvelope>().session.token;
    await acceptAllLegalDocs(fx, sessionToken);
    await upgradeSignupToPaidTier(fx, 'scope-test@driftstack.local');

    // V-174 — web sessions get ['read', 'write', 'account_owner'] (no
    // legacy 'admin'). The dashboard user has full customer-account
    // control (mint customer-scoped sub-keys, revoke any of their keys)
    // but CANNOT escalate by minting an elevated (admin /
    // driftstack_internal_admin) key — ApiKeysService de-escalation
    // rejects granting an elevated scope the caller doesn't hold.
    const mintCustomerKey = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { name: 'sub-app-key', scopes: ['read', 'write', 'account_owner'] },
    });
    expect(mintCustomerKey.statusCode).toBe(201);
    expect(mintCustomerKey.json<ApiKeyResponse>().scopes).toEqual([
      'read',
      'write',
      'account_owner',
    ]);

    // Privilege escalation blocked: account_owner web session cannot
    // mint an 'admin' (or driftstack_internal_admin) key.
    const mintAdminKey = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { name: 'sub-admin-key', scopes: ['admin'] },
    });
    expect(mintAdminKey.statusCode).toBe(403);
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
    // 2026-06-11 cutover: locked default is now iphone17.
    expect(session.archetype).toBe('iphone17_ios18_7_safari26_4');

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
