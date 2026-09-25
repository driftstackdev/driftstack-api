// The integration test app's stand-in for `guiControlKeyMinterIsLive` in
// src/db/agent-session-control-key-minter.ts, which DrizzleAgentSessionsRepo
// .isGuiControlKeyMinterLive runs (security sweep #2): whether the principal that
// minted a session's control key may still act on the owner's session.
//
// The Drizzle read joins the api_keys, web_sessions, accounts and team_members
// rows directly. The in-memory agent-sessions repository holds none of them, so this
// reads the fixture's own credential stores — the same ones the fixture's bearer
// authentication reads — and applies the same rules, clause for clause:
//
//   · an API key: the row exists on the minter's account, not revoked, not expired;
//   · a web session: the row exists on the minter's account, not revoked, not expired,
//     and at the account's current auth epoch;
//   · the minter's account is active;
//   · a membership: it exists, joins this member to this owner as admin, and the owner
//     is active (findTeamMemberships already drops inactive owners); with no
//     membership the minter must BE the owner.

import type { GuiControlKeyMinterCheck } from '../../../src/services/agent-sessions.js';
import type { AuthFlowsRepo } from '../../../src/services/auth-flows.js';
import type { InMemoryAuthRepo } from './in-memory-auth-repo.js';

export function inMemoryGuiControlKeyMinterCheck(deps: {
  authRepo: Pick<InMemoryAuthRepo, 'findApiKeyById' | 'peekAccount' | 'findTeamMemberships'>;
  authFlowsRepo: Pick<AuthFlowsRepo, 'findWebSessionByIdForAccount' | 'findAccountById'>;
}): GuiControlKeyMinterCheck {
  return async ({ minter, ownerAccountId, now }) => {
    if (minter.membershipId === null && minter.accountId !== ownerAccountId) return false;

    const account = await deps.authRepo.peekAccount(minter.accountId);
    if (account === null || account.status !== 'active') return false;

    if (minter.apiKeyId !== null && minter.webSessionId === null) {
      const key = await deps.authRepo.findApiKeyById(minter.apiKeyId);
      if (
        key === null ||
        key.accountId !== minter.accountId ||
        key.revokedAt !== null ||
        (key.expiresAt !== null && key.expiresAt.getTime() <= now.getTime())
      ) {
        return false;
      }
    } else if (minter.webSessionId !== null && minter.apiKeyId === null) {
      const [session, flowAccount] = await Promise.all([
        deps.authFlowsRepo.findWebSessionByIdForAccount(minter.webSessionId, minter.accountId),
        deps.authFlowsRepo.findAccountById(minter.accountId),
      ]);
      if (
        session === null ||
        flowAccount === null ||
        session.revokedAt !== null ||
        session.expiresAt.getTime() <= now.getTime() ||
        session.authEpoch !== flowAccount.authEpoch
      ) {
        return false;
      }
    } else {
      return false;
    }

    if (minter.membershipId !== null) {
      const teams = await deps.authRepo.findTeamMemberships(minter.accountId);
      return teams.some(
        (t) =>
          t.membershipId === minter.membershipId &&
          t.ownerAccountId === ownerAccountId &&
          t.role === 'admin',
      );
    }
    return true;
  };
}
