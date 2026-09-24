// Security sweep 2026-09-24, findings #5 (and the auth half of #4) — mail to an
// address the caller never proved they own was bounded only per source IP.
//
// resend-verification, magic-link/request, password-reset/request and
// status/subscribe each send to a caller-supplied address, and each was limited
// only by its own per-IP bucket (3/min). Rotating source addresses sent without
// bound to one mailbox (20 IPs → 20 mails), and even ONE address reached a victim
// through three separately-bucketed routes for as long as it kept going: the
// skeptic measured 540 mails in one simulated hour, none refused.
//
// Now each of those sends is also counted per RECIPIENT — the canonical address
// (Gmail dot and +tag spellings are one mailbox) — at most 5 an hour and 10 a day
// for each kind of email, whoever asks and from wherever. The count is kept in
// the shared rate-limit store (Redis in production) and falls back to a bounded
// store inside the process while that is unreachable, so an outage does not open
// it. Requests are counted whether or not an account exists, so the refusal says
// nothing about who has an account.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (fx) await fx.cleanup();
});

const PASSWORD = 'correct horse battery staple';

/** A distinct documentation-range source address per call. */
let ipSeq = 0;
function freshIp(): string {
  ipSeq += 1;
  return `198.51.${String(Math.floor(ipSeq / 250) % 250)}.${String((ipSeq % 250) + 1)}`;
}

async function post(
  url: string,
  email: string,
  remoteAddress = freshIp(),
): Promise<{
  status: number;
  body: { detail?: string; type?: string };
  retryAfter: string | undefined;
}> {
  const res = await fx.app.inject({ method: 'POST', url, payload: { email }, remoteAddress });
  const retryAfter = res.headers['retry-after'];
  return {
    status: res.statusCode,
    body: res.json<{ detail?: string; type?: string }>(),
    retryAfter: typeof retryAfter === 'string' ? retryAfter : undefined,
  };
}

async function signUp(email: string, opts: { verify: boolean }): Promise<void> {
  const signup = await fx.app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email, password: PASSWORD },
    remoteAddress: freshIp(),
  });
  expect(signup.statusCode, signup.body).toBe(200);
  if (!opts.verify) return;
  const verify = await fx.app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    payload: { token: signup.json<{ debug_token: string }>().debug_token, password: PASSWORD },
    remoteAddress: freshIp(),
  });
  expect(verify.statusCode, verify.body).toBe(200);
}

function mailsTo(address: string, template?: string): number {
  return fx.emailSends.filter(
    (s) => s.to === address && (template === undefined || s.template === template),
  ).length;
}

const RATE_LIMITED = 'https://errors.driftstack.dev/rate-limited';

describe('one mailbox gets a bounded number of sign-in, reset, verification and status emails, whoever asks', () => {
  it('CRITICAL resend-verification from 20 source addresses sends at most 5 verification emails to one unverified mailbox; the rest are refused 429', async () => {
    fx = await buildTestApp();
    const victim = 'victim-unverified@example.test';
    await signUp(victim, { verify: false });
    const afterSignup = mailsTo(victim, 'signup-verification');
    expect(afterSignup).toBe(1);

    const statuses: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      statuses.push((await post('/v1/auth/resend-verification', victim)).status);
    }
    expect(mailsTo(victim, 'signup-verification') - afterSignup, 'verification mails sent').toBe(5);
    expect(statuses).toEqual([...Array<number>(5).fill(200), ...Array<number>(15).fill(429)]);
  });

  it('CRITICAL status/subscribe from 20 source addresses sends at most 5 confirmations to an address that has no account', async () => {
    fx = await buildTestApp();
    const victim = 'stranger@example.test';
    const statuses: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      statuses.push((await post('/v1/status/subscribe', victim)).status);
    }
    expect(mailsTo(victim, 'status-subscription-confirmation')).toBe(5);
    expect(statuses).toEqual([...Array<number>(5).fill(202), ...Array<number>(15).fill(429)]);
  });

  it('CRITICAL the limit does not reveal whether an account exists: a registered and an unregistered address are answered identically, request for request', async () => {
    fx = await buildTestApp();
    const registered = 'has-account@example.test';
    const unregistered = 'no-account@example.test';
    await signUp(registered, { verify: true });

    for (const url of ['/v1/auth/magic-link/request', '/v1/auth/password-reset/request']) {
      const seen: Array<
        { status: number; detail: string | undefined; type: string | undefined }[]
      > = [];
      for (const address of [registered, unregistered]) {
        const answers: { status: number; detail: string | undefined; type: string | undefined }[] =
          [];
        for (let i = 0; i < 8; i += 1) {
          const r = await post(url, address);
          answers.push({
            status: r.status,
            detail: r.status === 429 ? r.body.detail : undefined,
            type: r.status === 429 ? r.body.type : undefined,
          });
        }
        seen.push(answers);
      }
      expect(
        seen[0]!.map((a) => a.status),
        url,
      ).toEqual([...Array<number>(5).fill(200), ...Array<number>(3).fill(429)]);
      expect(seen[1], `${url}: the unregistered address was answered differently`).toEqual(seen[0]);
    }
    // Mail went only where an account exists.
    expect(mailsTo(unregistered)).toBe(0);
    expect(mailsTo(registered, 'signup-verification')).toBeGreaterThanOrEqual(5);
  });

  it('CRITICAL one source address working magic-link, password-reset and status/subscribe at the per-IP pace for a simulated hour sends at most 15 mails (was 540), and at most 30 in a day', async () => {
    fx = await buildTestApp();
    const victim = 'paced-victim@example.test';
    await signUp(victim, { verify: true });
    const before = mailsTo(victim);
    const ip = '203.0.113.77';
    const urls = [
      '/v1/auth/magic-link/request',
      '/v1/auth/password-reset/request',
      '/v1/status/subscribe',
    ];

    vi.useFakeTimers({ toFake: ['Date'] });
    let now = Date.parse('2026-09-24T09:00:00.000Z');
    vi.setSystemTime(now);
    // One hour at exactly the per-IP refill rate (one request per route every 20s).
    for (let step = 0; step < 180; step += 1) {
      for (const url of urls) await post(url, victim, ip);
      now += 20_000;
      vi.setSystemTime(now);
    }
    expect(mailsTo(victim) - before, 'mails in the first hour').toBe(15);

    // The rest of a day, an hour at a time.
    for (let hour = 1; hour < 24; hour += 1) {
      for (let i = 0; i < 6; i += 1) {
        for (const url of urls) await post(url, victim, ip);
        now += 20_000;
        vi.setSystemTime(now);
      }
      now += 60 * 60 * 1000;
      vi.setSystemTime(now);
    }
    expect(mailsTo(victim) - before, 'mails in one day').toBe(30);
  });

  it('CRITICAL Gmail dot and +tag spellings of one mailbox share its limit', async () => {
    fx = await buildTestApp();
    await signUp('first.last@gmail.com', { verify: true });
    const spellings = [
      'firstlast@gmail.com',
      'First.Last+a@Gmail.com',
      'f.irstlast+b@gmail.com',
      'first.last@gmail.com',
      'FIRSTLAST+c@gmail.com',
      'fi.rst.last@gmail.com',
      'firstl.ast+d@gmail.com',
    ];
    const statuses: number[] = [];
    for (const spelling of spellings) {
      statuses.push((await post('/v1/auth/magic-link/request', spelling)).status);
    }
    expect(statuses).toEqual([...Array<number>(5).fill(200), 429, 429]);
    expect(mailsTo('first.last@gmail.com', 'signup-verification')).toBe(5 + 1);
  });

  it('CRITICAL the limit keeps counting while the shared store is unreachable — it moves to a bounded store inside the process instead of letting every send through', async () => {
    fx = await buildTestApp();
    vi.spyOn(fx.rateLimitStore, 'consumeSlidingWindow').mockRejectedValue(
      new Error('connect ECONNREFUSED 127.0.0.1:6379'),
    );
    const victim = 'outage-victim@example.test';
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      statuses.push((await post('/v1/status/subscribe', victim)).status);
    }
    expect(mailsTo(victim, 'status-subscription-confirmation')).toBe(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
  });

  it('the refusal says what happened and when to try again, as a rate-limited problem with Retry-After', async () => {
    fx = await buildTestApp();
    const victim = 'copy-check@example.test';
    await signUp(victim, { verify: false });
    const cases: Array<[string, RegExp]> = [
      [
        '/v1/auth/resend-verification',
        /^Too many verification emails have been requested for this address\. Try again in 60 minutes\.$/,
      ],
      [
        '/v1/auth/magic-link/request',
        /^Too many sign-in links have been requested for this address\. Try again in 60 minutes\.$/,
      ],
      [
        '/v1/auth/password-reset/request',
        /^Too many password reset emails have been requested for this address\. Try again in 60 minutes\.$/,
      ],
      [
        '/v1/status/subscribe',
        /^Too many confirmation emails have been requested for this address\. Try again in 60 minutes\.$/,
      ],
    ];
    for (const [url, copy] of cases) {
      for (let i = 0; i < 5; i += 1) {
        expect((await post(url, victim)).status, url).toBeLessThan(300);
      }
      const refused = await post(url, victim);
      expect(refused.status, url).toBe(429);
      expect(refused.body.type).toBe(RATE_LIMITED);
      expect(refused.body.detail, url).toMatch(copy);
      expect(Number(refused.retryAfter), `${url} Retry-After`).toBeGreaterThan(3500);
      expect(Number(refused.retryAfter), `${url} Retry-After`).toBeLessThanOrEqual(3600);
    }
  });
});
