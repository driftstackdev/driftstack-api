import { describe, it, expect } from 'vitest';
import { callerCanAccessAgentSession } from '../../src/routes/agent-sessions.js';

// audit wxzlp9yiz #4 — the security boundary for every session-scoped agent route
// (GET / page-state / transcript / gui-control-key / input-event / mode /
// takeover / handback / message / DELETE / resume). Before the fix the routes
// compared ownership against ctx.account.id ONLY, so a team admin who launched a
// session UNDER the owner (X-Driftstack-Account) was locked out of their own
// launch. callerCanAccessAgentSession grants access to the session OWNER or an
// ADMIN member of it — membership comes from ctx.teams, which requireAuth resolves
// server-side, so the header can't forge it. These pin every branch unambiguously
// (an integration 404 can't distinguish "blocked" from "not found").

type Ctx = Parameters<typeof callerCanAccessAgentSession>[0];

function ctxFor(
  accountId: string,
  teams: Array<{ ownerAccountId: string; role: 'admin' | 'member' }>,
): Ctx {
  // The helper only reads ctx.account.id + ctx.teams[].{ownerAccountId,role};
  // a minimal structural stand-in is sufficient and keeps the test independent
  // of the full AccountContext shape.
  return { account: { id: accountId }, teams } as unknown as Ctx;
}

describe('callerCanAccessAgentSession (team session-access boundary, audit wxzlp9yiz #4)', () => {
  const SELF = 'acct-self';
  const OWNER = 'acct-owner';
  const OTHER = 'acct-other';

  it('SELF: the session owner can always access their own session', () => {
    expect(callerCanAccessAgentSession(ctxFor(OWNER, []), OWNER)).toBe(true);
  });

  it('ADMIN MEMBER: an admin member of the owner CAN access the owner’s session (the fix)', () => {
    const ctx = ctxFor(SELF, [{ ownerAccountId: OWNER, role: 'admin' }]);
    expect(callerCanAccessAgentSession(ctx, OWNER)).toBe(true);
  });

  it('NON-ADMIN MEMBER: a plain member of the owner can NOT access the owner’s session (admin-only)', () => {
    const ctx = ctxFor(SELF, [{ ownerAccountId: OWNER, role: 'member' }]);
    expect(callerCanAccessAgentSession(ctx, OWNER)).toBe(false);
  });

  it('NON-MEMBER: an account with no membership of the owner can NOT access the owner’s session', () => {
    expect(callerCanAccessAgentSession(ctxFor(SELF, []), OWNER)).toBe(false);
  });

  it('WRONG-OWNER ADMIN: admin of a DIFFERENT owner can NOT access this owner’s session', () => {
    const ctx = ctxFor(SELF, [{ ownerAccountId: OTHER, role: 'admin' }]);
    expect(callerCanAccessAgentSession(ctx, OWNER)).toBe(false);
  });

  it('SELF wins regardless of (empty) team list', () => {
    expect(callerCanAccessAgentSession(ctxFor(SELF, []), SELF)).toBe(true);
  });
});
