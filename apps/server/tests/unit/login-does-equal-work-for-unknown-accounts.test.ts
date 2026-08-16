// Login authenticates BEFORE branching on account state, so the response time
// and the error are identical whether the email is unknown, password-less
// (OAuth-only), suspended, or simply wrong — the source names this as closing a
// user-enumeration side-channel (CWE-208).
//
// The mechanism is a dummy verification on the no-account path:
//
//     if (account === null || account.passwordHash === null || …) {
//       await verifyPassword(args.password, await dummyPasswordHash());
//       throw new AuthFlowError('invalid_credentials');
//     }
//
// Deleting that line changes NO functional outcome — the same error is thrown
// either way — so nothing behavioural noticed. Measured across the whole suite,
// removing it reds exactly four arms: two content-parity pins over the source
// text, and two type-check arms (the import is orphaned). The security property
// itself, that both paths do the same work, had no test.
//
// Timing cannot be asserted directly without flakiness, so the observable used
// here is the work itself: verifyPassword is spied (wrapping the real
// implementation, not replacing it) and both paths must call it exactly once.

import { describe, expect, it, vi } from 'vitest';
import type * as AuthTokens from '../../src/lib/auth-tokens.js';

// The real implementation is kept and merely wrapped, so every other consumer
// of this module behaves exactly as it does in production.
vi.mock('../../src/lib/auth-tokens.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthTokens>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

import { verifyPassword } from '../../src/lib/auth-tokens.js';
import { createTestLogger } from '../../src/lib/logger.js';
import { createEmailService } from '../../src/services/email.js';
import { AuthFlowsService, AuthFlowError } from '../../src/services/auth-flows.js';
import { InMemoryAuthFlowsRepo } from '../integration/_helpers/in-memory-auth-flows-repo.js';

const PASSWORD = 'correct horse battery staple';

function makeService(): AuthFlowsService {
  const logger = createTestLogger();
  const email = createEmailService({ config: null, logger });
  return new AuthFlowsService(new InMemoryAuthFlowsRepo(), email, logger, {
    verifyEmailUrl: 'https://app.driftstack.local/verify-email',
    magicLinkUrl: 'https://app.driftstack.local/auth/magic-link',
    passwordResetUrl: 'https://app.driftstack.local/reset-password',
    exposeDebugToken: true,
  });
}

const spy = vi.mocked(verifyPassword);

describe('login does equal work whether or not the account exists', () => {
  it('CRITICAL an unknown email still performs a password verification', async () => {
    spy.mockClear();
    const svc = makeService();

    await expect(
      svc.login({
        email: 'no-such-account@driftstack.local',
        password: PASSWORD,
        issuedFromIp: null,
        userAgent: null,
      }),
    ).rejects.toBeInstanceOf(AuthFlowError);

    expect(
      spy,
      'the no-account path must still verify, or its response time reveals that the email is unknown',
    ).toHaveBeenCalledTimes(1);
  });

  it('CRITICAL a known email with the wrong password performs the SAME number of verifications', async () => {
    // The equalisation only means anything if both sides match. Asserting the
    // unknown-email path alone would still pass if the known path verified
    // twice, which would re-open the channel from the other direction.
    const svc = makeService();
    const signup = await svc.signup({
      email: 'known-account@driftstack.local',
      password: PASSWORD,
      requestedFromIp: null,
    });
    spy.mockClear();

    await expect(
      svc.login({
        email: signup.account.email,
        password: 'an entirely different passphrase!!',
        issuedFromIp: null,
        userAgent: null,
      }),
    ).rejects.toBeInstanceOf(AuthFlowError);

    expect(
      spy,
      'the wrong-password path verifies exactly once, like the unknown-email path',
    ).toHaveBeenCalledTimes(1);
  });
});
