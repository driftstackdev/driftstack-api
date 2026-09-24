// Turning on two-factor needs the current password, or a sign-in from the last
// ten minutes.
//
// Sign-in audit, finding 4 (MEDIUM). Enrolling the first factor needed only a
// bearer web session. Enrolment also advances the account's auth epoch, which
// signs every other browser out — so a stolen session could enrol the attacker's
// authenticator, keep the recovery codes, sign the owner out, and leave the
// owner's password reset ending in an MFA challenge the owner cannot answer:
//
//   MFA-ENROLL-LOCKOUT  enroll with bare session -> 200; owner's browser
//                       afterwards -> 401; owner's password reset -> 200
//                       mfa_required=true session=false
//
// Now completing the first enrolment needs proof of a recent sign-in: the current
// password when the account has one; for an account with no password (created by
// Google or GitHub sign-in), a sign-in within the last ten minutes. A refreshed
// session keeps the time of the sign-in it came from, so refreshing a stolen
// session does not make it fresh. Wrong passwords here are limited, and the
// account is emailed whenever a factor is enrolled. The epoch advance that signs
// the other browsers out stays.
//
// MFA enrolment and Google/GitHub sign-in are not wired in the real-database app,
// so this runs on `buildTestApp`: real routes, middleware and services, in-memory
// stores.

import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { computeTotpCode } from '../../src/lib/mfa-totp.js';

let fx: TestAppFixture | null = null;

afterEach(async () => {
  vi.useRealTimers();
  if (fx) await fx.cleanup();
  fx = null;
});

function fixture(): TestAppFixture {
  if (fx === null) throw new Error('fixture not built');
  return fx;
}

const PASSWORD = 'correct horse battery staple';

const OAUTH = {
  signingSecret: 'b'.repeat(32),
  callbackUrlBase: 'https://api.driftstack.test/v1/auth/oauth',
  dashboardOrigin: 'https://app.driftstack.test',
  github: { clientId: 'github-test-id', clientSecret: 'github-test-secret' },
};

/** The GitHub identity the injected provider answers with, settable per test. */
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
  return `10.80.${Math.floor(ipCounter / 250).toString()}.${((ipCounter % 250) + 1).toString()}`;
}

async function call(
  method: 'GET' | 'POST',
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

/** A verified password account; returns a session from its verification. */
async function passwordAccount(email: string): Promise<string> {
  const signup = await call('POST', '/v1/auth/signup', { payload: { email, password: PASSWORD } });
  const verified = await call('POST', '/v1/auth/verify-email', {
    payload: { token: signup.body.debug_token, password: PASSWORD },
  });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  return (verified.body.session as { token: string }).token;
}

async function login(email: string): Promise<string> {
  const res = await call('POST', '/v1/auth/login', { payload: { email, password: PASSWORD } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.session as { token: string }).token;
}

/** A GitHub sign-in, start to /redeem, as the dashboard performs it. */
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

/** POST /enroll then /verify with a live code and whatever proof is given. */
async function enrol(
  session: string,
  proof: { current_password?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const started = await call('POST', '/v1/account/mfa/enroll', { bearer: session });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const secret = base32Decode(String(started.body.secret_base32));
  return call('POST', '/v1/account/mfa/verify', {
    bearer: session,
    payload: { code: computeTotpCode(secret, Math.floor(Date.now() / 1000)), ...proof },
  });
}

async function enrolled(session: string): Promise<boolean> {
  const status = await call('GET', '/v1/account/mfa', { bearer: session });
  return status.body.enrolled === true;
}

function enrolmentNotices(to: string): number {
  return fixture().emailSends.filter((s) => s.template === 'mfa-enrolled' && s.to === to).length;
}

describe('turning on two-factor needs the current password, or a sign-in from the last ten minutes', () => {
  it(
    'CRITICAL a session alone cannot enrol a factor on a password account — refused without the password and with a wrong one, and nothing is enrolled',
    { timeout: 30_000 },
    async () => {
      fx = await buildTestApp();
      const email = 'stolen-session@driftstack.local';
      const session = await passwordAccount(email);

      const bare = await enrol(session);
      expect(bare.status, JSON.stringify(bare.body)).toBe(403);
      expect(bare.body.current_password_required).toBe(true);
      expect(bare.body.recovery_codes).toBeUndefined();

      const wrong = await enrol(session, { current_password: 'a guess at the password' });
      expect(wrong.status).toBe(403);
      expect(wrong.body.current_password_required).toBe(true);

      expect(await enrolled(session)).toBe(false);
      expect(enrolmentNotices(email)).toBe(0);
    },
  );

  it(
    'with the current password it enrols; the account is emailed once; the other browsers are signed out as before',
    { timeout: 30_000 },
    async () => {
      fx = await buildTestApp();
      const email = 'owner-enrols@driftstack.local';
      const session = await passwordAccount(email);
      const otherBrowser = await login(email);

      const done = await enrol(session, { current_password: PASSWORD });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body.recovery_codes).toHaveLength(10);
      expect(await enrolled(session)).toBe(true);
      expect(enrolmentNotices(email)).toBe(1);
      expect((await call('GET', '/v1/whoami', { bearer: otherBrowser })).status).toBe(401);
    },
  );

  it(
    'wrong passwords here are limited: after five in fifteen minutes even the right one is refused with 429',
    { timeout: 60_000 },
    async () => {
      fx = await buildTestApp();
      const session = await passwordAccount('password-guesser@driftstack.local');
      for (let i = 0; i < 5; i++) {
        const wrong = await enrol(session, { current_password: `guess number ${i.toString()}` });
        expect(wrong.status, `guess ${String(i + 1)}`).toBe(403);
      }
      const right = await enrol(session, { current_password: PASSWORD });
      expect(right.status, JSON.stringify(right.body)).toBe(429);
      expect(await enrolled(session)).toBe(false);
    },
  );

  it(
    'CRITICAL an account with no password (created by GitHub sign-in) enrols from a sign-in within ten minutes, and is refused from an older one — even after the session was refreshed',
    { timeout: 60_000 },
    async () => {
      fx = await buildTestApp({ oauthClient: { ...OAUTH, fetch: githubFetch } });

      githubUser.id = 5001;
      githubUser.email = 'fresh-github@example.test';
      const fresh = await signInWithGithub();
      expect(fresh.outcome).toBe('created-new-account');
      const freshSession = String(fresh.session_token);
      const ok = await enrol(freshSession);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(enrolmentNotices('fresh-github@example.test')).toBe(1);

      githubUser.id = 5002;
      githubUser.email = 'stale-github@example.test';
      const stale = await signInWithGithub();
      expect(stale.outcome).toBe('created-new-account');

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      const refreshed = await call('POST', '/v1/auth/refresh', {
        payload: { token: String(stale.session_token) },
      });
      expect(refreshed.status).toBe(200);
      const refreshedSession = (refreshed.body.session as { token: string }).token;

      const refused = await enrol(refreshedSession);
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(refused.body.reauthentication_required).toBe(true);
      expect(String(refused.body.detail)).toMatch(/sign in again/i);
      expect(await enrolled(refreshedSession)).toBe(false);
    },
  );
});
