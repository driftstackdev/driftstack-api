// A two-factor pause earned through a linked sign-in never locks the owner out of
// the other ways in.
//
// Sign-in re-audit, round 1, new defect 1 (MEDIUM). The two-factor pause (ten
// wrong codes in fifteen minutes) was keyed on the account alone and refused
// every way of signing in. So whoever controls a linked GitHub or Google account
// — the exact threat a linked-sign-in removal exists for — could keep the real
// owner out indefinitely, and the pause email told the owner "someone knows your
// password. Reset it now", which signed out their last browser:
//
//   attacker via GitHub round1: …400,400,400,400,429; lock emails=1;
//   owner reset -> 429 "Your password was changed…"; owner's old browser -> 401;
//   owner new-password login -> 429; +16min attacker round2: …429; owner login -> 429
//
// Now wrong codes count per account AND per the sign-in method that started the
// challenge: a password sign-in (a password reset hands over a password, so it
// counts there too), a sign-in link sent to the address (magic link, verify
// email), and each linked provider. A pause earned after a GitHub sign-in pauses
// only GitHub sign-ins; the owner still gets in by password (+ code), by reset,
// or by magic link. The email names the method, and for a linked provider tells
// the owner to sign in another way and remove that link — not to reset a
// password nobody took. A password-method pause still pauses password sign-ins.
//
// The Google/GitHub and two-factor sign-in paths are not wired in the
// real-database app, so this runs on `buildTestApp` (real routes, middleware and
// services, in-memory stores) with the provider injected.

import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { computeTotpCode } from '../../src/lib/mfa-totp.js';
import { createEmailService } from '../../src/services/email.js';
import { createTestLogger } from '../../src/lib/logger.js';

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
const NEW_PASSWORD = 'the owner chose a new one';

const OAUTH = {
  signingSecret: 'd'.repeat(32),
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

// Every request from its own address unless a step needs the same one (a
// challenge is bound to the address it was issued to), so the per-IP gates never
// decide an outcome here.
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.93.${Math.floor(ipCounter / 250).toString()}.${((ipCounter % 250) + 1).toString()}`;
}

interface Answer {
  status: number;
  body: Record<string, unknown>;
  retryAfter: string | undefined;
}

async function call(
  method: 'GET' | 'POST',
  url: string,
  opts: { payload?: Record<string, unknown>; bearer?: string; ip?: string } = {},
): Promise<Answer> {
  const res = await fixture().app.inject({
    method,
    url,
    remoteAddress: opts.ip ?? nextIp(),
    ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
    headers: opts.bearer === undefined ? {} : { authorization: `Bearer ${opts.bearer}` },
  });
  const retryAfter = res.headers['retry-after'];
  return {
    status: res.statusCode,
    body: res.body.length > 0 ? res.json<Record<string, unknown>>() : {},
    retryAfter: typeof retryAfter === 'string' ? retryAfter : undefined,
  };
}

function nowCode(secret: Buffer): string {
  return computeTotpCode(secret, Math.floor(Date.now() / 1000));
}

/** A code that is certainly wrong right now: the right one, shifted. */
function wrongCode(secret: Buffer): string {
  return ((Number(nowCode(secret)) + 500_000) % 1_000_000).toString().padStart(6, '0');
}

interface Owner {
  email: string;
  accountId: string;
  secret: Buffer;
}

/** Password account, verified, two-factor on, with GitHub identity `sub` linked. */
async function ownerWithGithubLink(email: string, sub: number): Promise<Owner> {
  const signup = await call('POST', '/v1/auth/signup', { payload: { email, password: PASSWORD } });
  const verified = await call('POST', '/v1/auth/verify-email', {
    payload: { token: signup.body.debug_token, password: PASSWORD },
  });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  const session = verified.body.session as { token: string; account_id: string };
  const enroll = await call('POST', '/v1/account/mfa/enroll', { bearer: session.token });
  expect(enroll.status).toBe(200);
  const secret = base32Decode(String(enroll.body.secret_base32));
  const done = await call('POST', '/v1/account/mfa/verify', {
    bearer: session.token,
    payload: { code: nowCode(secret), current_password: PASSWORD },
  });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  const accountId = session.account_id.replace(/^acc_/, '');
  await fixture().oauthLinksRepo.insertLink({
    accountId,
    provider: 'github',
    providerSub: sub.toString(),
    providerEmail: email,
    providerName: 'Octo',
    providerAvatarUrl: null,
  });
  githubUser.id = sub;
  githubUser.email = email;
  return { email, accountId, secret };
}

/** One GitHub sign-in, redeemed from `ip`. The whole redeem answer. */
async function githubSignIn(ip: string): Promise<Answer> {
  const flowSecret = randomBytes(32).toString('base64url');
  const bindingHash = createHash('sha256').update(flowSecret).digest('base64url');
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
    remoteAddress: nextIp(),
  });
  const location = new URL(String(top.headers.location));
  const code = new URLSearchParams(location.hash.slice(1)).get('code') ?? '';
  return call('POST', '/v1/auth/oauth-client/redeem', {
    payload: { code, flow_secret: flowSecret },
    ip,
  });
}

function challengeCode(token: unknown, code: string, ip: string): Promise<Answer> {
  return call('POST', '/v1/auth/mfa/challenge', {
    payload: { challenge_token: token, code },
    ip,
  });
}

/**
 * Ten wrong codes on challenges started by `start` — five, four, then the tenth.
 * Returns the answer to the tenth.
 */
async function tenWrongCodes(
  owner: Owner,
  start: (ip: string) => Promise<Answer>,
): Promise<Answer> {
  let last: Answer | null = null;
  for (const wrongOnThisChallenge of [5, 4, 1]) {
    const ip = nextIp();
    const started = await start(ip);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.mfa_required).toBe(true);
    for (let i = 0; i < wrongOnThisChallenge; i++) {
      last = await challengeCode(started.body.challenge_token, wrongCode(owner.secret), ip);
    }
  }
  if (last === null) throw new Error('no code was sent');
  return last;
}

function passwordSignIn(email: string, password: string): (ip: string) => Promise<Answer> {
  return (ip) => call('POST', '/v1/auth/login', { payload: { email, password }, ip });
}

function expectPaused(answer: Answer): void {
  expect(answer.status, JSON.stringify(answer.body)).toBe(429);
  const seconds = Number(answer.retryAfter);
  expect(Number.isInteger(seconds), `Retry-After ${String(answer.retryAfter)}`).toBe(true);
  expect(seconds).toBeGreaterThan(0);
  expect(seconds).toBeLessThanOrEqual(15 * 60);
  expect(answer.body.session).toBeUndefined();
  expect(answer.body.session_token).toBeUndefined();
  expect(answer.body.challenge_token).toBeUndefined();
}

/**
 * The clock the test app reads, held still and moved by hand. A TOTP code is
 * accepted once, so each sign-in below moves to the next 30-second step first.
 */
function holdTheClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now());
}

function moveTheClock(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

/** Start with `start`, finish with the right code: the owner is signed in. */
async function signsIn(owner: Owner, start: (ip: string) => Promise<Answer>): Promise<string> {
  moveTheClock(31_000);
  const ip = nextIp();
  const started = await start(ip);
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  expect(started.body.mfa_required).toBe(true);
  const done = await challengeCode(started.body.challenge_token, nowCode(owner.secret), ip);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  const token = (done.body.session as { token?: unknown } | undefined)?.token;
  expect(typeof token).toBe('string');
  return String(token);
}

function magicLinkSignIn(email: string): (ip: string) => Promise<Answer> {
  return async (ip) => {
    const requested = await call('POST', '/v1/auth/magic-link/request', { payload: { email } });
    expect(requested.status).toBe(200);
    return call('POST', '/v1/auth/magic-link/consume', {
      payload: { token: requested.body.debug_token },
      ip,
    });
  };
}

describe('a two-factor pause earned through a linked sign-in never locks the owner out of the other ways in', () => {
  it(
    "CRITICAL the re-audit's scenario: an attacker holding the linked GitHub account pauses GitHub sign-in; the owner resets the password — not refused — and signs in with the new password and a code; after the pause lapses and the attacker pauses GitHub again, the owner still signs in",
    { timeout: 90_000 },
    async () => {
      fx = await buildTestApp({ oauthClient: { ...OAUTH, fetch: githubFetch } });
      holdTheClock();
      const owner = await ownerWithGithubLink('github-held@driftstack.local', 9101);

      const tenth = await tenWrongCodes(owner, githubSignIn);
      expectPaused(tenth);
      expect(String(tenth.body.detail)).toMatch(/GitHub/);
      expectPaused(await githubSignIn(nextIp()));

      // The owner follows the email: reset. The reset itself is not refused, and
      // its own two-factor step is not the paused one.
      const requested = await call('POST', '/v1/auth/password-reset/request', {
        payload: { email: owner.email },
      });
      const resetIp = nextIp();
      const reset = await call('POST', '/v1/auth/password-reset/confirm', {
        payload: { token: requested.body.debug_token, new_password: NEW_PASSWORD },
        ip: resetIp,
      });
      expect(reset.status, JSON.stringify(reset.body)).toBe(200);
      expect(reset.body.mfa_required).toBe(true);

      // …and signs in with the new password and a code.
      await signsIn(owner, passwordSignIn(owner.email, NEW_PASSWORD));
      // A magic link works too.
      await signsIn(owner, magicLinkSignIn(owner.email));

      // The pause lapses; the attacker spends another ten codes through GitHub.
      moveTheClock(16 * 60 * 1000);
      expectPaused(await tenWrongCodes(owner, githubSignIn));
      await signsIn(owner, passwordSignIn(owner.email, NEW_PASSWORD));
    },
  );

  it(
    'CRITICAL a password-method pause still pauses password sign-ins — and only them: GitHub and magic-link sign-ins still get their challenge',
    { timeout: 90_000 },
    async () => {
      fx = await buildTestApp({ oauthClient: { ...OAUTH, fetch: githubFetch } });
      holdTheClock();
      const owner = await ownerWithGithubLink('password-known@driftstack.local', 9102);

      const tenth = await tenWrongCodes(owner, passwordSignIn(owner.email, PASSWORD));
      expectPaused(tenth);
      expect(tenth.body.detail).toMatch(
        /^Too many incorrect two-factor codes for this account\. Two-factor sign-in is paused — try again in \d+ minutes?\.$/,
      );
      expectPaused(await passwordSignIn(owner.email, PASSWORD)(nextIp()));

      await signsIn(owner, githubSignIn);
      await signsIn(owner, magicLinkSignIn(owner.email));
      expectPaused(await passwordSignIn(owner.email, PASSWORD)(nextIp()));
    },
  );

  it(
    'one email and one "Recent activity" row per pause, per method — each naming the method that was used',
    { timeout: 90_000 },
    async () => {
      fx = await buildTestApp({ oauthClient: { ...OAUTH, fetch: githubFetch } });
      holdTheClock();
      const owner = await ownerWithGithubLink('told-twice@driftstack.local', 9103);

      expectPaused(await tenWrongCodes(owner, githubSignIn));
      expectPaused(await githubSignIn(nextIp()));
      expectPaused(await tenWrongCodes(owner, passwordSignIn(owner.email, PASSWORD)));
      expectPaused(await passwordSignIn(owner.email, PASSWORD)(nextIp()));

      const notices = fixture().emailSends.filter((s) => s.template === 'mfa-sign-in-locked');
      expect(notices.map((n) => [n.to, n.vars.method])).toEqual([
        [owner.email, 'github'],
        [owner.email, 'password'],
      ]);
      expect(String(notices[0]?.vars.securityUrl)).toMatch(/\/security\/?$/);
      expect(String(notices[1]?.vars.resetUrl)).toMatch(/\/forgot-password\/?$/);

      const session = await signsIn(owner, magicLinkSignIn(owner.email));
      const audit = await call('GET', '/v1/account/audit-log?action=account.mfa_sign_in_locked', {
        bearer: session,
      });
      expect(audit.status, JSON.stringify(audit.body)).toBe(200);
      const rows = audit.body.data as Array<{
        actor_type: string;
        payload: Record<string, unknown> | null;
      }>;
      expect(rows.map((r) => [r.actor_type, r.payload?.method]).sort()).toEqual([
        ['system', 'github'],
        ['system', 'password'],
      ]);
    },
  );

  it('the pause email says what happened for the method used: a linked sign-in is removed from Security after signing in another way, a password is reset', async () => {
    const sent: Array<{ Subject: string; TextBody: string; HtmlBody: string }> = [];
    const email = createEmailService({
      config: {
        apiToken: 't',
        from: 'noreply@driftstack.test',
        replyTo: 'support@driftstack.test',
      },
      logger: createTestLogger(),
      client: {
        sendEmail: (input) => {
          sent.push(input);
          return Promise.resolve({});
        },
      },
    });
    const common = {
      to: 'owner@example.test',
      pausedUntil: new Date('2026-09-24T12:34:56Z'),
      resetUrl: 'https://app.driftstack.test/forgot-password',
      securityUrl: 'https://app.driftstack.test/security',
    };
    await email.sendMfaSignInLocked({ ...common, method: 'github' });
    await email.sendMfaSignInLocked({ ...common, method: 'password' });
    await email.sendMfaSignInLocked({ ...common, method: 'email_link' });
    const [github, password, emailLink] = sent;

    expect(github?.TextBody).toMatch(/signed in to your Driftstack account with GitHub/);
    expect(github?.TextBody).toMatch(/Remove the GitHub sign-in/i);
    expect(github?.TextBody).toMatch(/sign in another way/i);
    expect(github?.TextBody).toContain(common.securityUrl);
    expect(github?.TextBody).not.toMatch(/knows your password|reset/i);
    expect(github?.HtmlBody).toContain(`href="${common.securityUrl}"`);

    expect(password?.TextBody).toMatch(/with the right password/);
    expect(password?.TextBody).toMatch(/someone knows your password\. Reset it now/);
    expect(password?.TextBody).toContain(common.resetUrl);

    expect(emailLink?.TextBody).toMatch(/with a sign-in link sent to this address/);
    expect(emailLink?.TextBody).not.toMatch(/knows your password/);
    for (const m of sent) expect(m.TextBody).toContain('September 24, 2026 at 12:34 UTC');
  });
});
