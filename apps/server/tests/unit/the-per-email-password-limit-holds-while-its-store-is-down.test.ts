// The per-email password limit holds while its store is down.
//
// Sign-in re-audit, round 1, new defect 4 (LOW). The per-email password limit
// (ten wrong passwords in fifteen minutes, from anywhere) lives in the short-lived
// Redis store. When that store threw, the limit let every request through, so
// during an outage guesses spread over many addresses were never refused again:
//
//   with a store that throws: 40 wrong -> 40 invalid_credentials, 0 refused;
//   then right -> session
//
// The per-IP limit already falls back to a bounded per-process store
// (middleware/ip-rate-limit.ts). The per-email limit now does the same: while the
// store throws, it counts in a bounded store inside this process, and says so in
// the log once per outage — not once per request.
//
// The service is built directly: the store is not reachable from the HTTP
// fixtures, and the per-IP limit (a route gate) is not what this is about — every
// attempt comes from its own address.

import { describe, expect, it, vi } from 'vitest';
import { createTestLogger } from '../../src/lib/logger.js';
import { RateLimitedError } from '../../src/lib/errors.js';
import { createEmailService } from '../../src/services/email.js';
import { AuthFlowError, AuthFlowsService } from '../../src/services/auth-flows.js';
import { BoundedMemoryFailureLimiterStore } from '../../src/services/account-failure-limiter.js';
import {
  InMemoryMfaChallengeStore,
  type MfaChallengeStore,
} from '../../src/services/mfa-challenge-store.js';
import { InMemoryAuthFlowsRepo } from '../integration/_helpers/in-memory-auth-flows-repo.js';

const EMAIL = 'guessed-during-an-outage@example.test';
const PASSWORD = 'the right password for this account';
const WRONG = 'a wrong guess at the password';

/** The short-lived store, with a switch that makes every call throw as Redis does when it is down. */
class SwitchableStore implements MfaChallengeStore {
  down = false;
  private readonly inner = new InMemoryMfaChallengeStore();
  private check(): void {
    if (this.down)
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), {
        code: 'ECONNREFUSED',
      });
  }
  consume(key: string): Promise<string | null> {
    this.check();
    return this.inner.consume(key);
  }
  set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.check();
    return this.inner.set(key, value, ttlSeconds);
  }
  peek(key: string): Promise<string | null> {
    this.check();
    return this.inner.peek(key);
  }
  incrAttempts(key: string, ttlSeconds: number): Promise<number> {
    this.check();
    return this.inner.incrAttempts(key, ttlSeconds);
  }
  releaseAttempt(key: string): Promise<void> {
    this.check();
    return this.inner.releaseAttempt(key);
  }
  resetAttempts(key: string): Promise<void> {
    this.check();
    return this.inner.resetAttempts(key);
  }
}

async function serviceWithAccount(): Promise<{
  service: AuthFlowsService;
  store: SwitchableStore;
  warnings: () => string[];
}> {
  const logger = createTestLogger();
  const warn = vi.spyOn(logger, 'warn');
  const store = new SwitchableStore();
  const service = new AuthFlowsService(
    new InMemoryAuthFlowsRepo(),
    createEmailService({ config: null, logger }),
    logger,
    {
      verifyEmailUrl: 'https://app.driftstack.local/verify-email',
      magicLinkUrl: 'https://app.driftstack.local/auth/magic-link',
      passwordResetUrl: 'https://app.driftstack.local/reset-password',
      exposeDebugToken: true,
    },
    null,
    null,
    null,
    store,
  );
  const signup = await service.signup({ email: EMAIL, password: PASSWORD, requestedFromIp: null });
  await service.verifyEmail({
    token: String(signup.debugToken),
    password: PASSWORD,
    issuedFromIp: null,
    userAgent: null,
  });
  const warnings = (): string[] =>
    warn.mock.calls.map((args) => (typeof args[1] === 'string' ? args[1] : String(args[0])));
  return { service, store, warnings };
}

type Outcome = 'checked' | 'refused' | 'signed-in';

async function attempt(service: AuthFlowsService, password: string, n: number): Promise<Outcome> {
  try {
    await service.login({
      email: EMAIL,
      password,
      issuedFromIp: `10.65.${Math.floor(n / 250).toString()}.${((n % 250) + 1).toString()}`,
      userAgent: null,
    });
    return 'signed-in';
  } catch (err) {
    if (err instanceof AuthFlowError && err.code === 'invalid_credentials') return 'checked';
    if (err instanceof RateLimitedError) return 'refused';
    throw err;
  }
}

function tally(outcomes: Outcome[]): Record<Outcome, number> {
  const out: Record<Outcome, number> = { checked: 0, refused: 0, 'signed-in': 0 };
  for (const o of outcomes) out[o] += 1;
  return out;
}

describe('the per-email password limit holds while its store is down', () => {
  it('CRITICAL with the store throwing, 40 wrong passwords for one email from 40 addresses: at most 10 are checked, the other 30 are refused with 429 — and then the RIGHT password is refused too', async () => {
    const { service, store } = await serviceWithAccount();
    store.down = true;
    const outcomes: Outcome[] = [];
    for (let i = 0; i < 40; i++) outcomes.push(await attempt(service, WRONG, i));
    const counts = tally(outcomes);
    expect(counts.checked).toBeLessThanOrEqual(10);
    expect(counts).toEqual({ checked: 10, refused: 30, 'signed-in': 0 });
    expect(await attempt(service, PASSWORD, 41)).toBe('refused');
  });

  it('the fallback is logged once per outage, not once per request: two outages, two warnings', async () => {
    const { service, store, warnings } = await serviceWithAccount();
    const fallbackWarnings = (): string[] =>
      warnings().filter((m) => /password sign-in limit/i.test(m) && /this process/i.test(m));

    store.down = true;
    for (let i = 0; i < 5; i++) await attempt(service, WRONG, i);
    expect(fallbackWarnings()).toHaveLength(1);

    store.down = false;
    expect(await attempt(service, WRONG, 10)).toBe('checked');
    expect(fallbackWarnings()).toHaveLength(1);

    store.down = true;
    for (let i = 0; i < 5; i++) await attempt(service, WRONG, 20 + i);
    expect(fallbackWarnings()).toHaveLength(2);
  });

  it('the per-process store is bounded: past its capacity the oldest entries go, so a flood of distinct emails cannot grow it without limit', async () => {
    const bounded = new BoundedMemoryFailureLimiterStore(3);
    for (const key of ['a', 'b', 'c', 'd']) await bounded.incrAttempts(key, 60);
    expect(bounded.size()).toBe(3);
    // 'a' was the oldest and went; 'd' is there.
    expect(await bounded.incrAttempts('a', 60)).toBe(1);
    expect(await bounded.incrAttempts('d', 60)).toBe(2);
    for (const key of ['e', 'f', 'g', 'h']) await bounded.set(key, '1', 60);
    expect(bounded.size()).toBe(6);
    expect(await bounded.peek('e')).toBeNull();
    expect(await bounded.peek('h')).toBe('1');
  });
});
