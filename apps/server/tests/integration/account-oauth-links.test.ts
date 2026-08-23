// V-667.C-followup — integration tests for
//   GET /v1/account/me/oauth-links
//
// Customer-facing read of the OAuth links table. The route registers
// only when oauthLinksRepo is wired on AppDeps; the fixture passes
// it through whenever opts.oauthClient is set.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const OAUTH = {
  signingSecret: 'b'.repeat(32),
  callbackUrlBase: 'https://api.driftstack.test/v1/auth/oauth',
  dashboardOrigin: 'https://app.driftstack.test',
  google: { clientId: 'g-id', clientSecret: 'g-secret' },
};

describe('GET /v1/account/me/oauth-links (V-667.C-followup)', () => {
  it('returns 200 + empty list when the account has no linked IDPs', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/oauth-links',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[] }>();
    expect(body.data).toEqual([]);
  });

  it('returns the active link with provider + email + linked_at after a seed insert', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    await fx.oauthLinksRepo.insertLink({
      accountId: fx.accountId,
      provider: 'google',
      providerSub: 'g-sub-123',
      providerEmail: 'tester@driftstack.local',
      providerName: 'Tester',
      providerAvatarUrl: null,
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/oauth-links',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{
        id: string;
        provider: string;
        provider_email: string | null;
        linked_at: string;
        last_login_at: string | null;
        last_revoked_at: string | null;
      }>;
    }>();
    expect(body.data).toHaveLength(1);
    const link = body.data[0]!;
    expect(link.id).toMatch(/^ol_[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(link.provider).toBe('google');
    expect(link.provider_email).toBe('tester@driftstack.local');
    expect(typeof link.linked_at).toBe('string');
    expect(link.last_login_at).toBeNull();
    expect(link.last_revoked_at).toBeNull();
  });

  it('does not surface internal fields (provider_avatar_url, provider_name, provider_sub)', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    await fx.oauthLinksRepo.insertLink({
      accountId: fx.accountId,
      provider: 'google',
      providerSub: 'g-sub-secret',
      providerEmail: 'tester@driftstack.local',
      providerName: 'Tester Internal',
      providerAvatarUrl: 'https://lh3.googleusercontent.com/abc',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/oauth-links',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const raw = res.body;
    expect(raw).not.toMatch(/g-sub-secret/);
    expect(raw).not.toMatch(/lh3\.googleusercontent\.com/);
    expect(raw).not.toMatch(/Tester Internal/);
  });

  it("scopes results to the calling account (does not leak another account's links)", async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    // Seed a link for an unrelated account id.
    await fx.oauthLinksRepo.insertLink({
      accountId: 'other-account-id',
      provider: 'github',
      providerSub: 'gh-sub-456',
      providerEmail: 'other@driftstack.local',
      providerName: 'Other',
      providerAvatarUrl: null,
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/oauth-links',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[] }>();
    expect(body.data).toEqual([]);
  });

  it('returns 401 without auth', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/oauth-links',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when oauthLinksRepo was never wired (prod-pre-env-wire posture)', async () => {
    fx = await buildTestApp(); // no oauthClient → no oauthLinksRepo
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/oauth-links',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns multiple links when an account has both providers linked', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    await fx.oauthLinksRepo.insertLink({
      accountId: fx.accountId,
      provider: 'google',
      providerSub: 'g-1',
      providerEmail: 'tester@driftstack.local',
      providerName: 'Tester',
      providerAvatarUrl: null,
    });
    await fx.oauthLinksRepo.insertLink({
      accountId: fx.accountId,
      provider: 'github',
      providerSub: 'gh-1',
      providerEmail: 'tester@driftstack.local',
      providerName: 'Tester',
      providerAvatarUrl: null,
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/oauth-links',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ provider: string }> }>();
    expect(body.data).toHaveLength(2);
    expect(body.data.map((l) => l.provider).sort()).toEqual(['github', 'google']);
  });

  it('?active_only=true hides Verdict-2 revoked links; default shows them', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const link = await fx.oauthLinksRepo.insertLink({
      accountId: fx.accountId,
      provider: 'google',
      providerSub: 'g-rev',
      providerEmail: 'tester@driftstack.local',
      providerName: 'Tester',
      providerAvatarUrl: null,
    });
    await fx.oauthLinksRepo.markRevokedAt(link.id, new Date());

    const both = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/oauth-links',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(both.json<{ data: unknown[] }>().data).toHaveLength(1);

    const activeOnly = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/oauth-links?active_only=true',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(activeOnly.json<{ data: unknown[] }>().data).toHaveLength(0);
  });

  // V-1367 — `active_only` is read straight off request.query with no schema, while the
  // two other boolean query params in this codebase (admin-api-keys `revoked`,
  // admin-rate-limit-overrides `include_expired`) are validated first. A repeated query
  // key parses to an ARRAY, so the untyped comparison silently answers false and the
  // filter the caller asked for is never applied.
  async function withOneRevokedAndOneLive(): Promise<TestAppFixture> {
    const fixture = await buildTestApp({ oauthClient: OAUTH });
    const revoked = await fixture.oauthLinksRepo.insertLink({
      accountId: fixture.accountId,
      provider: 'google',
      providerSub: 'g-dup-revoked',
      providerEmail: 'tester@driftstack.local',
      providerName: 'Tester',
      providerAvatarUrl: null,
    });
    await fixture.oauthLinksRepo.markRevokedAt(revoked.id, new Date());
    await fixture.oauthLinksRepo.insertLink({
      accountId: fixture.accountId,
      provider: 'github',
      providerSub: 'gh-dup-live',
      providerEmail: 'tester@driftstack.local',
      providerName: 'Tester',
      providerAvatarUrl: null,
    });
    return fixture;
  }

  it('CRITICAL a REPEATED ?active_only is refused rather than silently ignored. The repeat parses to an array, which never equals the string "true", so the unvalidated read answers false and returns the revoked links the caller asked to hide — a wrong answer with a 200 on it, which is worse than an error.', async () => {
    fx = await withOneRevokedAndOneLive();

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/oauth-links?active_only=true&active_only=true',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode, `a repeated filter must not be answered: ${res.body}`).toBe(400);
  });

  it('CRITICAL the single-value filter still works, so the refusal above cannot be satisfied by a route that rejects every filtered read', async () => {
    fx = await withOneRevokedAndOneLive();

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/oauth-links?active_only=true',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json<{ data: Array<{ provider: string }> }>().data;
    expect(
      data.map((l) => l.provider),
      'the revoked link is filtered out',
    ).toEqual(['github']);
  });

  it('CRITICAL a single unrecognised value is still accepted and still means "show all", exactly as before. The fix narrows the type of the parameter, NOT its accepted values — an enum here would start 400ing ?active_only=1 and ?active_only= on a documented customer endpoint, which is a different change than the one this defect calls for.', async () => {
    fx = await withOneRevokedAndOneLive();

    for (const raw of ['1', '', 'TRUE', 'yes']) {
      const res = await fx.app.inject({
        method: 'GET',
        url: `/v1/account/me/oauth-links?active_only=${raw}`,
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });
      expect(res.statusCode, `?active_only=${raw} should still be accepted`).toBe(200);
      expect(
        res.json<{ data: unknown[] }>().data,
        `?active_only=${raw} means show all, as it did before`,
      ).toHaveLength(2);
    }
  });

  it('surfaces last_revoked_at when the link was marked revoked (Verdict 2 fallback)', async () => {
    fx = await buildTestApp({ oauthClient: OAUTH });
    const link = await fx.oauthLinksRepo.insertLink({
      accountId: fx.accountId,
      provider: 'google',
      providerSub: 'g-revoked',
      providerEmail: 'tester@driftstack.local',
      providerName: 'Tester',
      providerAvatarUrl: null,
    });
    const revokedAt = new Date('2026-05-10T12:00:00Z');
    await fx.oauthLinksRepo.markRevokedAt(link.id, revokedAt);

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/oauth-links',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ last_revoked_at: string | null }> }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.last_revoked_at).toBe(revokedAt.toISOString());
  });
});
