// End-to-end integration test: X-Driftstack-Account team-RBAC
// header behavior. When a team member calls with the OWNER's
// account-id in the header, READ endpoints route to the owner's
// resources. Drift on the routing would either fail-open (any user
// reads any account) or fail-closed (legitimate team-reads break).

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('X-Driftstack-Account team-RBAC header end-to-end', () => {
  it('X-Driftstack-Account pointing at a non-existent account → 403 or 404 (NOT 200 — fail-closed)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': 'acc_99999999-9999-4999-8999-999999999999',
      },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('CRITICAL X-Driftstack-Account pointing at a non-member account → 403. V-1043: this asserted only `statusCode < 500`, with no lower bound, so a 200 satisfied it — the arm written to prove the header fails closed would have passed a server that granted the impersonation. Its sibling above carries both bounds; this one lost the lower half. `resolveEffectiveAccount` refuses a non-membership with ForbiddenError, so the exact answer is assertable.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    // We don't seed a team-member relationship, so any
    // X-Driftstack-Account header that's not the caller's own
    // account must fail-closed.
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': 'acc_00000000-0000-4000-8000-000000000002',
      },
    });
    expect(res.statusCode, 'acting as an account you are not a member of').toBe(403);
    expect(res.json<{ type?: string }>().type, 'the RFC 7807 type for a refusal').toBe(
      'https://errors.driftstack.dev/forbidden',
    );
  });

  // V-1332 — the escalation the arm above cannot see.
  //
  // That one seeds NO membership, and says so: with `ctx.teams` empty, every
  // header but the caller's own is refused by the emptiness alone. So it proves
  // a stranger is refused, not that membership is CHECKED AGAINST THE REQUESTED
  // ACCOUNT — and those are different properties the moment the caller belongs
  // to any team at all.
  //
  // Measured rather than assumed: making the resolver accept any membership for
  // any requested account — one member of one team able to act as any account —
  // failed exactly ONE test in the whole node project, and that one is a
  // source-text pin matching the literal return statement. Nothing observed the
  // impersonation. This is the arm that does.
  it('CRITICAL a member of ONE team still cannot act as a DIFFERENT account. Membership must be checked against the account the header names, not merely be present — a caller who belongs to some team is exactly the caller for whom "has a membership" and "has THIS membership" come apart, and every real customer with a team is that caller.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });

    const OWNER_ID = '00000000-0000-4000-8000-00000000e001';
    const STRANGER_ID = '00000000-0000-4000-8000-00000000e002';

    // The caller is a genuine admin of OWNER's team…
    fx.authRepo.upsertAccount({
      id: OWNER_ID,
      email: 'team-owner@example.test',
      name: 'Team Owner',
      tier: 'api_builder',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: '00000000-0000-4000-8000-00000000e003',
        ownerAccountId: OWNER_ID,
        role: 'admin',
      },
    ]);

    // …acting as OWNER is legitimate, which is what makes the next call a
    // genuine escalation attempt rather than a malformed request.
    const allowed = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${OWNER_ID}`,
      },
    });
    expect(allowed.statusCode, 'fixture precondition: acting as the real owner works').toBe(200);

    // …but a THIRD account they hold no membership in must still be refused.
    const refused = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${STRANGER_ID}`,
      },
    });
    expect(refused.statusCode, 'a team member acted as an account they are not a member of').toBe(
      403,
    );
    expect(refused.json<{ type?: string }>().type, 'the RFC 7807 type for a refusal').toBe(
      'https://errors.driftstack.dev/forbidden',
    );
  });

  // V-1335 — the owner-vanished branch, which no test had ever executed.
  //
  // Seven copies of this refusal exist across the route layer (profiles x2,
  // admin x2, agent-sessions x2, profile-snapshots), each guarding the window
  // between the auth cache loading a membership and the handler reading the
  // owner row. Coverage says none of the seven had run. A membership is cached,
  // the owner account is deleted, and the next call from that member arrives
  // holding a valid membership for an account that is gone.
  //
  // Reaching it needs a fixture that is correct in every other respect: the
  // membership must resolve, the role must be admin, and the body must parse —
  // otherwise an earlier guard answers and the arm measures a different refusal.
  it('CRITICAL a member acting for an owner whose account has been DELETED is refused, not served against a half-resolved account. The membership is still valid and still cached; only the owner row is gone. Measured, not assumed: with the guard disabled the handler reads `owner.id` off null and the caller gets a 500 — indistinguishable from a server fault — on a request whose cause is knowable and whose correct answer is a 403 naming it.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });

    // A membership pointing at an account that was never created — the state a
    // cached membership is in for the moment after its owner is deleted.
    const GHOST_ID = '00000000-0000-4000-8000-00000000f001';
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: '00000000-0000-4000-8000-00000000f002',
        ownerAccountId: GHOST_ID,
        role: 'admin',
      },
    ]);

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/profiles/prof_00000000-0000-4000-8000-00000000f003/clone`,
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${GHOST_ID}`,
      },
      payload: {},
    });

    expect(res.statusCode, 'acting for a deleted owner must be refused').toBe(403);
    expect(
      res.json<{ detail?: string }>().detail,
      'and the refusal names the vanished owner rather than a generic denial',
    ).toContain('Owner account no longer exists');
  });

  it('X-Driftstack-Account with malformed acc_-prefixed UUID → 4xx (NOT 500)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': 'not-a-valid-acc-id',
      },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it("X-Driftstack-Account with caller's OWN account-id → 200 (self-scope is valid)", async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    // First GET /v1/account/me to learn our own account_id
    const meRes = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const meBody = meRes.json<{ id?: string }>();
    expect(meBody.id).toBeDefined();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': meBody.id ?? '',
      },
    });
    expect(res.statusCode).toBe(200);
  });
});
