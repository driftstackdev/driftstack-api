// An account whose two-factor code is guessed wrong ten times stops taking codes
// for fifteen minutes.
//
// Sign-in audit, finding 2 (HIGH). The MFA sign-in challenge allowed five wrong
// codes per challenge and was otherwise throttled per IP address only — and every
// fresh password sign-in mints a new challenge. With a leaked password and many
// addresses, the six-digit code falls to brute force (about 28 minutes to even
// odds from 1,000 addresses):
//
//   MFA-BRUTE  20 wrong codes from 4 IPs; 5th login=200; correct code on 5th
//              challenge -> 200 session=true
//
// Now the account carries its own count, like step-up does: ten wrong codes in
// fifteen minutes, across any number of challenges, and the account takes no new
// challenge and no code for fifteen minutes (429 + Retry-After). The owner gets
// one email and "Recent activity" one row. The five-per-challenge and per-IP
// limits stay.
//
// Finding 8 (LOW) rides along: the challenge route used to answer every refusal
// with the same generic detail, so a typo, an address mismatch and "this sign-in
// is used up" all read "Token is invalid, expired, or already used." — and the
// dashboard left the customer typing into a dead challenge. The service's own
// messages are customer-safe and now reach the customer.
//
// The MFA sign-in path is not wired in the real-database app, so this runs on
// `buildTestApp`: real routes, middleware and services, in-memory stores.

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

const EMAIL = 'mfa-guessed@driftstack.local';
const PASSWORD = 'correct horse battery staple';

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

interface Answer {
  status: number;
  body: Record<string, unknown>;
  retryAfter: string | undefined;
  bucket: string | undefined;
}

async function post(
  url: string,
  payload: Record<string, unknown>,
  ip: string,
  bearer?: string,
): Promise<Answer> {
  const res = await fixture().app.inject({
    method: 'POST',
    url,
    payload,
    remoteAddress: ip,
    headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
  });
  const retryAfter = res.headers['retry-after'];
  const bucket = res.headers['x-ratelimit-bucket'];
  return {
    status: res.statusCode,
    body: res.body.length > 0 ? res.json<Record<string, unknown>>() : {},
    retryAfter: typeof retryAfter === 'string' ? retryAfter : undefined,
    bucket: typeof bucket === 'string' ? bucket : undefined,
  };
}

/** Signup, verify, enrol TOTP. Returns the secret and the enrolling session. */
async function enrolledAccount(): Promise<{ secret: Buffer; session: string }> {
  const setupIp = '10.70.0.1';
  const signup = await post('/v1/auth/signup', { email: EMAIL, password: PASSWORD }, setupIp);
  const verified = await post(
    '/v1/auth/verify-email',
    { token: signup.body.debug_token, password: PASSWORD },
    setupIp,
  );
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  const session = (verified.body.session as { token: string }).token;
  const enroll = await post('/v1/account/mfa/enroll', {}, setupIp, session);
  expect(enroll.status).toBe(200);
  const secret = base32Decode(String(enroll.body.secret_base32));
  const done = await post(
    '/v1/account/mfa/verify',
    { code: computeTotpCode(secret, Math.floor(Date.now() / 1000)), current_password: PASSWORD },
    setupIp,
    session,
  );
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return { secret, session };
}

/** A code that is certainly wrong right now: the right one, shifted. */
function wrongCode(secret: Buffer): string {
  const right = computeTotpCode(secret, Math.floor(Date.now() / 1000));
  return ((Number(right) + 500_000) % 1_000_000).toString().padStart(6, '0');
}

async function challengeFrom(ip: string): Promise<Answer> {
  return post('/v1/auth/login', { email: EMAIL, password: PASSWORD }, ip);
}

function expectPaused(answer: Answer): void {
  expect(answer.status, JSON.stringify(answer.body)).toBe(429);
  const seconds = Number(answer.retryAfter);
  expect(Number.isInteger(seconds), `Retry-After ${String(answer.retryAfter)}`).toBe(true);
  expect(seconds).toBeGreaterThan(0);
  expect(seconds).toBeLessThanOrEqual(15 * 60);
  expect(answer.body.session).toBeUndefined();
  expect(answer.body.challenge_token).toBeUndefined();
}

describe('an account whose two-factor code is guessed wrong ten times stops taking codes for fifteen minutes', () => {
  it(
    'CRITICAL ten wrong codes across three challenges from three addresses: the CORRECT code on a still-live challenge is then refused, and a correct password gets no new challenge — both 429 with Retry-After',
    { timeout: 60_000 },
    async () => {
      fx = await buildTestApp();
      const { secret } = await enrolledAccount();

      // Challenge 1: five wrong codes use it up.
      const first = await challengeFrom('10.70.1.1');
      expect(first.status).toBe(200);
      for (let i = 0; i < 5; i++) {
        const wrong = await post(
          '/v1/auth/mfa/challenge',
          { challenge_token: first.body.challenge_token, code: wrongCode(secret) },
          '10.70.1.1',
        );
        expect(wrong.status).toBe(400);
      }
      // Challenge 2: four wrong codes — still live (nine wrong so far).
      const second = await challengeFrom('10.70.2.1');
      expect(second.status).toBe(200);
      for (let i = 0; i < 4; i++) {
        const wrong = await post(
          '/v1/auth/mfa/challenge',
          { challenge_token: second.body.challenge_token, code: wrongCode(secret) },
          '10.70.2.1',
        );
        expect(wrong.status).toBe(400);
      }
      // Challenge 3: the tenth wrong code — answered with the pause itself.
      const third = await challengeFrom('10.70.3.1');
      expect(third.status).toBe(200);
      const tenth = await post(
        '/v1/auth/mfa/challenge',
        { challenge_token: third.body.challenge_token, code: wrongCode(secret) },
        '10.70.3.1',
      );
      expectPaused(tenth);
      expect(String(tenth.body.detail)).toMatch(/paused/);

      // The right code on challenge 2, which the per-challenge limit alone would admit.
      const right = await post(
        '/v1/auth/mfa/challenge',
        {
          challenge_token: second.body.challenge_token,
          code: computeTotpCode(secret, Math.floor(Date.now() / 1000)),
        },
        '10.70.2.1',
      );
      expectPaused(right);
      expectPaused(await challengeFrom('10.70.4.1'));
    },
  );

  it(
    'CRITICAL the owner is told once — one email saying someone has the password, one "Recent activity" row — however many more attempts follow',
    { timeout: 60_000 },
    async () => {
      fx = await buildTestApp();
      const { secret, session } = await enrolledAccount();
      for (let round = 0; round < 2; round++) {
        const ip = `10.71.${round.toString()}.1`;
        const challenge = await challengeFrom(ip);
        for (let i = 0; i < 5; i++) {
          await post(
            '/v1/auth/mfa/challenge',
            { challenge_token: challenge.body.challenge_token, code: wrongCode(secret) },
            ip,
          );
        }
      }
      for (let i = 0; i < 3; i++)
        expectPaused(await challengeFrom(`10.71.9.${(i + 1).toString()}`));

      const notices = fixture().emailSends.filter((s) => s.template === 'mfa-sign-in-locked');
      expect(notices).toHaveLength(1);
      expect(notices[0]?.to).toBe(EMAIL);
      expect(String(notices[0]?.vars.resetUrl)).toMatch(/\/forgot-password\/?$/);

      const audit = await fixture().app.inject({
        method: 'GET',
        url: '/v1/account/audit-log?action=account.mfa_sign_in_locked',
        headers: { authorization: `Bearer ${session}` },
      });
      expect(audit.statusCode, audit.body).toBe(200);
      const rows = audit.json<{ data: Array<{ action: string; actor_type: string }> }>().data;
      expect(rows.map((r) => [r.action, r.actor_type])).toEqual([
        ['account.mfa_sign_in_locked', 'system'],
      ]);
    },
  );

  it(
    'after fifteen minutes the account takes a challenge and the right code again',
    { timeout: 60_000 },
    async () => {
      fx = await buildTestApp();
      const { secret } = await enrolledAccount();
      for (let round = 0; round < 2; round++) {
        const ip = `10.72.${round.toString()}.1`;
        const challenge = await challengeFrom(ip);
        for (let i = 0; i < 5; i++) {
          await post(
            '/v1/auth/mfa/challenge',
            { challenge_token: challenge.body.challenge_token, code: wrongCode(secret) },
            ip,
          );
        }
      }
      expectPaused(await challengeFrom('10.72.5.1'));

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 16 * 60 * 1000);
      const again = await challengeFrom('10.72.6.1');
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      const ok = await post(
        '/v1/auth/mfa/challenge',
        {
          challenge_token: again.body.challenge_token,
          code: computeTotpCode(secret, Math.floor(Date.now() / 1000)),
        },
        '10.72.6.1',
      );
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(typeof (ok.body.session as { token?: unknown }).token).toBe('string');
    },
  );

  it(
    'the five-per-challenge limit stays, and its refusals say what happened (finding 8): a wrong code says to try again, the fifth says to sign in again, the used-up challenge says it is gone',
    { timeout: 60_000 },
    async () => {
      fx = await buildTestApp();
      const { secret } = await enrolledAccount();
      const ip = '10.73.0.1';
      const challenge = await challengeFrom(ip);
      const details: unknown[] = [];
      for (let i = 0; i < 5; i++) {
        const wrong = await post(
          '/v1/auth/mfa/challenge',
          { challenge_token: challenge.body.challenge_token, code: wrongCode(secret) },
          ip,
        );
        expect(wrong.status).toBe(400);
        details.push(wrong.body.detail);
      }
      expect(details.slice(0, 4)).toEqual(
        Array(4).fill('Code is invalid. Try again or use a recovery code.'),
      );
      expect(details[4]).toBe('Too many incorrect codes for this sign-in. Sign in again to retry.');

      const afterwards = await post(
        '/v1/auth/mfa/challenge',
        {
          challenge_token: challenge.body.challenge_token,
          code: computeTotpCode(secret, Math.floor(Date.now() / 1000)),
        },
        ip,
      );
      expect(afterwards.status).toBe(400);
      expect(afterwards.body.detail).toBe('Challenge token is unknown or expired. Sign in again.');

      const elsewhere = await challengeFrom('10.73.1.1');
      const wrongAddress = await post(
        '/v1/auth/mfa/challenge',
        {
          challenge_token: elsewhere.body.challenge_token,
          code: computeTotpCode(secret, Math.floor(Date.now() / 1000)),
        },
        '10.73.2.2',
      );
      expect(wrongAddress.status).toBe(400);
      expect(wrongAddress.body.detail).toBe(
        'Challenge token was issued from a different IP. Sign in again.',
      );
    },
  );

  it('the per-IP limit stays: the eleventh challenge submission from one address is refused by the address’s bucket', async () => {
    fx = await buildTestApp();
    const ip = '10.74.0.1';
    for (let i = 0; i < 10; i++) {
      const res = await post(
        '/v1/auth/mfa/challenge',
        { challenge_token: `unknown-${i.toString()}`, code: '123456' },
        ip,
      );
      expect(res.status).toBe(400);
    }
    const eleventh = await post(
      '/v1/auth/mfa/challenge',
      { challenge_token: 'unknown-11', code: '123456' },
      ip,
    );
    expect(eleventh.status).toBe(429);
    expect(eleventh.bucket).toBe('auth-ip:login');
  });
});
