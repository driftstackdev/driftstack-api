// V-1395 — a stored MFA challenge payload that does not parse is removed, not retried.
//
// `parseMfaChallengePayload` guards the payload the challenge store holds between the
// password step and the code step. Branch coverage put ALL FIVE of its type checks in the
// never-taken set, plus the shape check above them: no test had ever handed
// `completeMfaChallenge` a stored payload it could not parse.
//
// The consumer's own comment says what the null return is for:
//
//   "Corrupt state can never become a valid customer retry. Remove it so malformed Redis
//    data fails closed as a stable auth error instead of a repeatable 500 or a verifier
//    call with an invalid account identity."
//
// Both halves of that matter and neither was exercised:
//
//   • the CONSUME. Without it the corrupt entry survives its whole TTL and every retry
//     hits the same failure — the "repeatable" case the comment names.
//   • the PARSE itself. `payload.account_id` is what the code verifier is called with, so a
//     payload missing it would put `undefined` where an account id belongs.
//
// The store is not reachable from the HTTP fixture, so the service is built directly with a
// challenge store under test control. Nothing here needs a real account: every arm refuses
// before the verifier is consulted, which is the property.

import { describe, expect, it } from 'vitest';
import { createTestLogger } from '../../src/lib/logger.js';
import { createEmailService } from '../../src/services/email.js';
import { AuthFlowsService, AuthFlowError } from '../../src/services/auth-flows.js';
import type { MfaChallengeStore } from '../../src/services/mfa-challenge-store.js';
import type { MfaService } from '../../src/services/mfa.js';
import { InMemoryAuthFlowsRepo } from '../integration/_helpers/in-memory-auth-flows-repo.js';

const TOKEN = 'challenge-token-under-test';
const SOURCE_IP = '203.0.113.7';

/** Records what the service did to the store, which is the half the comment cares about. */
class RecordingChallengeStore implements MfaChallengeStore {
  readonly consumed: string[] = [];
  constructor(private readonly stored: string | null) {}

  peek(_key: string): Promise<string | null> {
    return Promise.resolve(this.stored);
  }

  consume(key: string): Promise<string | null> {
    this.consumed.push(key);
    return Promise.resolve(this.stored);
  }

  set(_key: string, _value: string, _ttlSeconds: number): Promise<void> {
    return Promise.resolve();
  }

  incrAttempts(_key: string, _ttlSeconds: number): Promise<number> {
    return Promise.resolve(1);
  }

  releaseAttempt(_key: string): Promise<void> {
    return Promise.resolve();
  }
}

function serviceWith(stored: string | null): {
  service: AuthFlowsService;
  store: RecordingChallengeStore;
} {
  const logger = createTestLogger();
  const email = createEmailService({ config: null, logger });
  const store = new RecordingChallengeStore(stored);
  // The verifier must never be reached by the arms below; if one ever does, this throws
  // rather than quietly returning a refusal that reads like the guard working.
  const mfa = {
    verifyCode: () => {
      throw new Error('the code verifier was reached with a payload that should have been refused');
    },
  } as unknown as MfaService;

  const service = new AuthFlowsService(
    new InMemoryAuthFlowsRepo(),
    email,
    logger,
    {
      verifyEmailUrl: 'https://app.driftstack.local/verify-email',
      magicLinkUrl: 'https://app.driftstack.local/auth/magic-link',
      passwordResetUrl: 'https://app.driftstack.local/reset-password',
      exposeDebugToken: true,
    },
    null,
    null,
    mfa,
    store,
  );
  return { service, store };
}

const wellFormed = JSON.stringify({
  account_id: 'acc-1',
  email: 'user@example.test',
  source_ip: SOURCE_IP,
  issued_at: 1_767_225_600,
  issued_user_agent: 'Mozilla/5.0',
});

describe('a stored MFA challenge payload that does not parse fails closed', () => {
  it.each([
    ['not JSON at all', 'not-json'],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['a JSON string', '"just-a-string"'],
    [
      'no account_id',
      JSON.stringify({ email: 'u@e.test', source_ip: null, issued_at: 1, issued_user_agent: null }),
    ],
    [
      'an empty account_id',
      JSON.stringify({
        account_id: '',
        email: 'u@e.test',
        source_ip: null,
        issued_at: 1,
        issued_user_agent: null,
      }),
    ],
    [
      'no email',
      JSON.stringify({
        account_id: 'acc-1',
        source_ip: null,
        issued_at: 1,
        issued_user_agent: null,
      }),
    ],
    [
      'a numeric source_ip',
      JSON.stringify({
        account_id: 'acc-1',
        email: 'u@e.test',
        source_ip: 7,
        issued_at: 1,
        issued_user_agent: null,
      }),
    ],
    [
      'a string issued_at',
      JSON.stringify({
        account_id: 'acc-1',
        email: 'u@e.test',
        source_ip: null,
        issued_at: '1',
        issued_user_agent: null,
      }),
    ],
    [
      'an issued_at that is not finite',
      `{"account_id":"acc-1","email":"u@e.test","source_ip":null,"issued_at":1e999,"issued_user_agent":null}`,
    ],
    [
      'a numeric issued_user_agent',
      JSON.stringify({
        account_id: 'acc-1',
        email: 'u@e.test',
        source_ip: null,
        issued_at: 1,
        issued_user_agent: 7,
      }),
    ],
  ])(
    'CRITICAL a payload with %s is refused AND the corrupt entry is consumed, so a retry cannot hit it again. Leaving it in place would make one bad write a repeatable failure for the whole TTL.',
    async (_label, stored) => {
      const { service, store } = serviceWith(stored);

      await expect(
        service.completeMfaChallenge({
          challengeToken: TOKEN,
          code: '123456',
          sourceIp: SOURCE_IP,
          userAgent: null,
        }),
      ).rejects.toBeInstanceOf(AuthFlowError);

      expect(
        store.consumed,
        'the corrupt entry must be removed, not left to be retried',
      ).toHaveLength(1);
    },
  );

  it('CRITICAL a WELL-FORMED payload is not consumed by the parse path — an IP mismatch refuses without destroying the challenge, so the legitimate customer can retry from the right address. Without this the arms above are satisfied by a method that consumes on every failure.', async () => {
    const { service, store } = serviceWith(wellFormed);

    await expect(
      service.completeMfaChallenge({
        challengeToken: TOKEN,
        code: '123456',
        sourceIp: '198.51.100.9', // a different address than the payload was issued from
        userAgent: null,
      }),
    ).rejects.toThrow(/issued from a different IP/);

    expect(store.consumed, 'a well-formed payload must survive an IP refusal').toHaveLength(0);
  });
});
