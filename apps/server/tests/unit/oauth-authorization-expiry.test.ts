// V-1343 — an authorization that expired before anyone approved it is refused.
//
// The OAuth consent flow has two steps with a gap between them: `authorize()` records a pending
// authorization, a human then looks at a consent screen, and `approveAuthorization()` turns it into
// a code. `CODE_TTL_SECONDS` bounds that gap — a consent screen left open past it must not still
// mint a code.
//
// Coverage over every throw site in `apps/server/src` put this branch in the never-executed set
// (`services/oauth.ts:564`). Its sibling one line up — an authorization_id that does not resolve at
// all — is exercised; the one that distinguishes "no such authorization" from "this authorization is
// too old" was not. Those are different refusals: the first says the id is wrong, the second says the
// id was right and the window closed, and only the second bounds how long an abandoned consent
// screen stays live.
//
// Driven against the service with an injected clock rather than through the route, because the
// alternative is waiting five real minutes — the timing-dependent kind of test this repo treats as a
// defect rather than a cost.

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { InMemoryOAuthStore, OAuthService } from '../../src/services/oauth.js';

/** Five minutes, mirroring `CODE_TTL_SECONDS` in the service. */
const CODE_TTL_MS = 5 * 60 * 1000;

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** A service whose clock the test moves, and the pending authorization it just recorded. */
async function pendingAuthorization(): Promise<{
  svc: OAuthService;
  authorizationId: string;
  advance: (ms: number) => void;
}> {
  let now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const svc = new OAuthService(new InMemoryOAuthStore(), () => now);
  const reg = await svc.registerClient({
    label: 'ConsentScreenApp',
    redirect_uris: ['https://app.example/cb'],
  });
  const authorize = await svc.authorize({
    client_id: reg.client_id,
    redirect_uri: 'https://app.example/cb',
    state: 'st_' + 'x'.repeat(20),
    code_challenge: s256('v'.repeat(64)),
    code_challenge_method: 'S256',
    scope: ['read:sessions'],
  });
  return {
    svc,
    authorizationId: authorize.authorization_id,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('an OAuth authorization that expired before approval', () => {
  it('CRITICAL a consent screen approved INSIDE the window still works. Without this the refusal arm below is satisfied by a service that refuses every approval, which would look like a passing expiry check and be a broken consent flow.', async () => {
    const { svc, authorizationId, advance } = await pendingAuthorization();
    advance(CODE_TTL_MS - 1000);

    const approval = await svc.approveAuthorization({
      authorization_id: authorizationId,
      account_id: 'acc_test',
    });
    expect(approval.code, 'an approval inside the window mints a code').toBeTruthy();
  });

  it('CRITICAL a consent screen approved AFTER the window is refused, and refused as an expiry rather than as an unknown id. A screen left open overnight must not still mint a code; the branch that says so had never executed, and the one beside it — an authorization_id that resolves to nothing — cannot stand in for it, because it answers a different question.', async () => {
    const { svc, authorizationId, advance } = await pendingAuthorization();
    advance(CODE_TTL_MS + 1000);

    await expect(
      svc.approveAuthorization({ authorization_id: authorizationId, account_id: 'acc_test' }),
    ).rejects.toThrow(/authorization expired before approval/);
  });

  it('CRITICAL the refusal carries the OAuth error code the spec assigns it, so a client sees a protocol error rather than an opaque failure', async () => {
    const { svc, authorizationId, advance } = await pendingAuthorization();
    advance(CODE_TTL_MS + 1000);

    await expect(
      svc.approveAuthorization({ authorization_id: authorizationId, account_id: 'acc_test' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
