// Sign a buildTestApp fixture's own account in as a browser session.
//
// The owner tools that reveal or change platform secrets, prices and rate cards
// refuse an API key (security sweep #17): they need a signed-in session with a
// fresh second factor. A suite that drives them as the owner therefore signs the
// fixture account in and uses the session bearer instead of `fx.plaintext`. The
// fixture's MfaService has nothing enrolled, so the step-up gate lets the session
// through — the gate itself is proved in
// the-owner-tools-need-a-signed-in-session-and-a-fresh-second-factor.test.ts.

import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../../../src/services/auth-cache.js';
import type { TestAppFixture } from './build-test-app.js';

/** Returns the session's bearer token. The session carries the staff scope when the
 *  fixture's account is on its staff list, exactly as a real sign-in would. */
export async function signInTheFixtureAccount(fx: TestAppFixture): Promise<string> {
  const account = await fx.authRepo.getAccount(fx.accountId);
  if (account === null) throw new Error('the fixture account is missing from its auth store');
  // Web sessions are issued against the sign-in store, which buildTestApp does not
  // seed with the fixture's account; mirror it there first.
  fx.authFlowsRepo.seedAccount({
    id: account.id,
    email: account.email,
    name: account.name,
    passwordHash: null,
    emailVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    tier: account.tier,
    status: account.status,
    authEpoch: 0,
    createdAt: account.createdAt,
  });
  const token = `wsess_${randomBytes(24).toString('hex')}`;
  const session = await fx.authFlowsRepo.insertWebSession({
    accountId: account.id,
    tokenHash: sha256Hex(token),
    authEpoch: 0,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    issuedFromIp: null,
    userAgent: null,
  });
  if (session === null) throw new Error('the fixture account could not be signed in');
  return token;
}
