// A linked Google or GitHub sign-in can be removed, and then no longer signs in.
//
// Sign-in audit, finding 5 (MEDIUM). A linked identity could never be removed:
// `markRevokedAt` had no production caller, the links route was GET-only, and a
// password reset does not touch the links table. The security page even said
// "the link is marked inactive…", which nothing did. So a customer whose GitHub
// account was compromised had no way to cut that sign-in off:
//
//   OAUTHLINK  after reset: GitHub sign-in outcome=signed-in-existing-link
//              session_token=true; DELETE /v1/account/me/oauth-links/:id -> 404
//
// DELETE /v1/account/me/oauth-links/:id now removes the link — the row is
// deleted, so the next sign-in with that identity finds no link and falls to the
// emailed merge confirmation like any never-linked identity. It takes a web
// session (never an API key), a fresh two-factor step-up when two-factor is on,
// refuses to remove an account's last way to sign in, and leaves a "Recent
// activity" row and an email.
//
// The sign-in half needs the Google/GitHub flow, which the real-database app does
// not wire, so this runs on `buildTestApp` with the provider injected. The
// database half (the Drizzle delete and its last-method check) is in
// a-removed-linked-sign-in-is-deleted-from-the-database-unless-it-is-the-last-way-in.test.ts.

import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { computeTotpCode } from '../../src/lib/mfa-totp.js';

let fx: TestAppFixture | null = null;

afterEach(async () => {
  if (fx) await fx.cleanup();
  fx = null;
});

function fixture(): TestAppFixture {
  if (fx === null) throw new Error('fixture not built');
  return fx;
}

const PASSWORD = 'correct horse battery staple';

const OAUTH = {
  signingSecret: 'c'.repeat(32),
  callbackUrlBase: 'https://api.driftstack.test/v1/auth/oauth',
  dashboardOrigin: 'https://app.driftstack.test',
  github: { clientId: 'github-test-id', clientSecret: 'github-test-secret' },
};

const githubUser = { id: 1, email: 'nobody@example.test' };

const githubFetch: typeof fetch = (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const body = /access_token$/.test(url)
    ? { access_token: 'at_live', token_type: 'bearer', scope: 'read:user' }
    : { id: githubUser.id, login: 'octo', name: 'Octo', avatar_url: null, email: githubUser.email };
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
};

function base32Decode(input: string): Buffer {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.replace(/=+$/g, '').toUpperCase()) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`bad base32 char: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.90.${Math.floor(ipCounter / 250).toString()}.${((ipCounter % 250) + 1).toString()}`;
}

async function call(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  opts: { payload?: Record<string, unknown>; bearer?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fixture().app.inject({
    method,
    url,
    remoteAddress: nextIp(),
    ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
    headers: opts.bearer === undefined ? {} : { authorization: `Bearer ${opts.bearer}` },
  });
  return {
    status: res.statusCode,
    body: res.body.length > 0 ? res.json<Record<string, unknown>>() : {},
  };
}

async function passwordAccount(email: string): Promise<{ accountId: string; session: string }> {
  const signup = await call('POST', '/v1/auth/signup', { payload: { email, password: PASSWORD } });
  const verified = await call('POST', '/v1/auth/verify-email', {
    payload: { token: signup.body.debug_token, password: PASSWORD },
  });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  const session = verified.body.session as { token: string; account_id: string };
  return { accountId: session.account_id.replace(/^acc_/, ''), session: session.token };
}

async function signInWithGithub(): Promise<Record<string, unknown>> {
  const secret = randomBytes(32).toString('base64url');
  const bindingHash = createHash('sha256').update(secret).digest('base64url');
  const start = await call('POST', '/v1/auth/oauth-client/start', {
    payload: {
      provider: 'github',
      redirect_to: 'https://app.driftstack.test/security',
      binding_hash: bindingHash,
    },
  });
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  const state = new URL(String(start.body.authorize_url)).searchParams.get('state') ?? '';
  const top = await fixture().app.inject({
    method: 'GET',
    url: `/v1/auth/oauth/github/callback?${new URLSearchParams({ code: 'idp-code', state }).toString()}`,
  });
  const location = new URL(String(top.headers.location));
  const code = new URLSearchParams(location.hash.slice(1)).get('code') ?? '';
  const redeemed = await call('POST', '/v1/auth/oauth-client/redeem', {
    payload: { code, flow_secret: secret },
  });
  expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(200);
  return redeemed.body;
}

async function linkGithub(accountId: string, sub: number, email: string): Promise<string> {
  const link = await fixture().oauthLinksRepo.insertLink({
    accountId,
    provider: 'github',
    providerSub: sub.toString(),
    providerEmail: email,
    providerName: 'Octo',
    providerAvatarUrl: null,
  });
  return `ol_${link.id}`;
}

async function links(session: string): Promise<Array<{ id: string; provider: string }>> {
  const res = await call('GET', '/v1/account/me/oauth-links', { bearer: session });
  expect(res.status).toBe(200);
  return res.body.data as Array<{ id: string; provider: string }>;
}

describe('a linked Google or GitHub sign-in can be removed, and then no longer signs in', () => {
  it(
    'CRITICAL removing the link: 204, it is gone from the list, and the same GitHub identity no longer signs in — it gets the emailed merge confirmation instead of a session',
    { timeout: 30_000 },
    async () => {
      fx = await buildTestApp({ oauthClient: { ...OAUTH, fetch: githubFetch } });
      const email = 'links-owner@driftstack.local';
      const { accountId, session } = await passwordAccount(email);
      githubUser.id = 7001;
      githubUser.email = email;
      const linkId = await linkGithub(accountId, 7001, email);

      const before = await signInWithGithub();
      expect(before.outcome).toBe('signed-in-existing-link');
      expect(typeof before.session_token).toBe('string');

      const removed = await call('DELETE', `/v1/account/me/oauth-links/${linkId}`, {
        bearer: session,
      });
      expect(removed.status, JSON.stringify(removed.body)).toBe(204);
      expect(await links(session)).toEqual([]);

      const after = await signInWithGithub();
      expect(after.outcome, 'the removed link still signs in').toBe(
        'collision-pending-verification',
      );
      expect(after.session_token).toBeUndefined();

      const again = await call('DELETE', `/v1/account/me/oauth-links/${linkId}`, {
        bearer: session,
      });
      expect(again.status).toBe(404);
    },
  );

  it(
    'the removal is told: one "Recent activity" row naming the provider, and one email to the account',
    { timeout: 30_000 },
    async () => {
      fx = await buildTestApp({ oauthClient: { ...OAUTH, fetch: githubFetch } });
      const email = 'links-told@driftstack.local';
      const { accountId, session } = await passwordAccount(email);
      const linkId = await linkGithub(accountId, 7002, 'octo-told@example.test');
      expect(
        (await call('DELETE', `/v1/account/me/oauth-links/${linkId}`, { bearer: session })).status,
      ).toBe(204);

      const audit = await call('GET', '/v1/account/audit-log?action=account.oauth_link_removed', {
        bearer: session,
      });
      expect(audit.status, JSON.stringify(audit.body)).toBe(200);
      const rows = audit.body.data as Array<{
        action: string;
        target_resource_id: string | null;
        payload: Record<string, unknown> | null;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.target_resource_id).toBe(linkId);
      expect(rows[0]?.payload?.provider).toBe('github');

      const notices = fixture().emailSends.filter((s) => s.template === 'oauth-link-removed');
      expect(notices.map((n) => [n.to, n.vars.provider])).toEqual([[email, 'github']]);
    },
  );

  it(
    'CRITICAL an account whose only way in is one GitHub link cannot remove it — a clear 409 — and the link keeps signing in; with a second link, the first can go',
    { timeout: 30_000 },
    async () => {
      fx = await buildTestApp({ oauthClient: { ...OAUTH, fetch: githubFetch } });
      githubUser.id = 7003;
      githubUser.email = 'only-github@example.test';
      const created = await signInWithGithub();
      expect(created.outcome).toBe('created-new-account');
      const session = String(created.session_token);
      const [only] = await links(session);
      if (only === undefined) throw new Error('the GitHub sign-in made no link');

      const refused = await call('DELETE', `/v1/account/me/oauth-links/${only.id}`, {
        bearer: session,
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(String(refused.body.detail)).toMatch(/only way to sign in/i);
      expect((await signInWithGithub()).outcome).toBe('signed-in-existing-link');

      const accountId = String(created.account_id);
      await linkGithub(accountId, 7004, 'second-github@example.test');
      const allowed = await call('DELETE', `/v1/account/me/oauth-links/${only.id}`, {
        bearer: session,
      });
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(204);
    },
  );

  it(
    'only a signed-in browser can remove a link: an account_owner API key is refused, another account’s link is 404, a malformed id is 400',
    { timeout: 30_000 },
    async () => {
      fx = await buildTestApp({
        oauthClient: { ...OAUTH, fetch: githubFetch },
        scopes: ['read', 'write', 'account_owner'],
      });
      const owner = await passwordAccount('links-keyholder@driftstack.local');
      const ownerLink = await linkGithub(owner.accountId, 7005, 'keyholder@example.test');
      const byKey = await call('DELETE', `/v1/account/me/oauth-links/${ownerLink}`, {
        bearer: fixture().plaintext,
      });
      expect(byKey.status).toBe(403);

      const stranger = await passwordAccount('links-stranger@driftstack.local');
      const theirs = await call('DELETE', `/v1/account/me/oauth-links/${ownerLink}`, {
        bearer: stranger.session,
      });
      expect(theirs.status).toBe(404);
      expect((await links(owner.session)).map((l) => l.id)).toEqual([ownerLink]);

      const malformed = await call('DELETE', '/v1/account/me/oauth-links/not-a-link', {
        bearer: owner.session,
      });
      expect(malformed.status).toBe(400);
    },
  );

  it('with two-factor on, removing a link needs a fresh step-up', { timeout: 60_000 }, async () => {
    fx = await buildTestApp({ oauthClient: { ...OAUTH, fetch: githubFetch } });
    const email = 'links-mfa@driftstack.local';
    const { accountId, session } = await passwordAccount(email);
    const started = await call('POST', '/v1/account/mfa/enroll', { bearer: session });
    const secret = base32Decode(String(started.body.secret_base32));
    const enrolled = await call('POST', '/v1/account/mfa/verify', {
      bearer: session,
      payload: {
        code: computeTotpCode(secret, Math.floor(Date.now() / 1000)),
        current_password: PASSWORD,
      },
    });
    expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(200);
    const linkId = await linkGithub(accountId, 7006, 'mfa-github@example.test');

    // A refreshed session has not satisfied two-factor.
    const refreshed = await call('POST', '/v1/auth/refresh', { payload: { token: session } });
    const stale = (refreshed.body.session as { token: string }).token;
    const refused = await call('DELETE', `/v1/account/me/oauth-links/${linkId}`, {
      bearer: stale,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.requires_mfa_step_up).toBe(true);

    const recovery = (enrolled.body.recovery_codes as string[])[0];
    const stepUp = await call('POST', '/v1/auth/mfa/step-up', {
      bearer: stale,
      payload: { recovery_code: recovery },
    });
    expect(stepUp.status, JSON.stringify(stepUp.body)).toBe(200);
    const removed = await call('DELETE', `/v1/account/me/oauth-links/${linkId}`, {
      bearer: stale,
    });
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);
  });
});
