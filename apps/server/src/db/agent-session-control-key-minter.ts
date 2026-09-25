// Security sweep #2 — the columns that record who minted a session's GUI control
// key (migration 0142), the live read of that minter behind every control-key use,
// and the clear that runs inside every revocation of a minting credential or
// membership.
//
// Its own module, importing only the schema, because three repositories that have
// nothing else to do with agent sessions call the clear from inside their own
// transactions (api keys, team members, auth flows), and none of them should pull
// in the agent-sessions repository and its transcript encryption to do it.

import { and, eq, gt, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { GuiControlKeyMinter } from '../lib/agent-session-control-key.js';
import type { Database } from './client.js';
import { accounts, agentSessions, apiKeys, teamMembers, webSessions } from './schema.js';

/** The four minter columns, as one write: all four set, or all four NULL. */
export function mintedByColumns(mintedBy: GuiControlKeyMinter | null | undefined): {
  guiControlKeyMintedByAccountId: string | null;
  guiControlKeyMintedByApiKeyId: string | null;
  guiControlKeyMintedByWebSessionId: string | null;
  guiControlKeyMintedByMembershipId: string | null;
} {
  return {
    guiControlKeyMintedByAccountId: mintedBy?.accountId ?? null,
    guiControlKeyMintedByApiKeyId: mintedBy?.apiKeyId ?? null,
    guiControlKeyMintedByWebSessionId: mintedBy?.webSessionId ?? null,
    guiControlKeyMintedByMembershipId: mintedBy?.membershipId ?? null,
  };
}

/** A cleared key: no ciphertext, no expiry, no minter. */
export const CLEARED_GUI_CONTROL_KEY = {
  guiControlKeyCiphertext: null,
  guiControlKeyExpiresAt: null,
  ...mintedByColumns(null),
} as const;

type AgentSessionsDb = Database['db'];
/** A transaction on the app database, as `db.transaction` hands it to its body. */
export type AgentSessionsTx = Parameters<Parameters<AgentSessionsDb['transaction']>[0]>[0];

/**
 * Security sweep #2 — the live re-check behind every control-key use
 * (DrizzleAgentSessionsRepo.isGuiControlKeyMinterLive). Two indexed reads at most,
 * in parallel: the minting credential joined to its account, and (for a team
 * member) the membership joined to the owner.
 *
 *   · an API key (device keys and OAuth grants included): the row exists on the
 *     minter's account, is not revoked and not expired;
 *   · a web session: the row exists on the minter's account, is not revoked or
 *     expired, and was minted at the account's CURRENT auth epoch — the join the
 *     bearer path uses, so a password change ends it here too;
 *   · either way the minter's account is active;
 *   · a membership: it still exists, joins this member to this owner, holds the
 *     admin role, and the owner is active. With no membership the minter must be
 *     the owner.
 */
export async function guiControlKeyMinterIsLive(
  db: AgentSessionsDb,
  args: { minter: GuiControlKeyMinter; ownerAccountId: string; now: Date },
): Promise<boolean> {
  const { minter, ownerAccountId, now } = args;
  if (minter.membershipId === null && minter.accountId !== ownerAccountId) return false;
  const credential = async (): Promise<boolean> => {
    if (minter.apiKeyId !== null && minter.webSessionId === null) {
      const rows = await db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .innerJoin(accounts, eq(accounts.id, apiKeys.accountId))
        .where(
          and(
            eq(apiKeys.id, minter.apiKeyId),
            eq(apiKeys.accountId, minter.accountId),
            isNull(apiKeys.revokedAt),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
            eq(accounts.status, 'active'),
          ),
        )
        .limit(1);
      return rows.length === 1;
    }
    if (minter.webSessionId !== null && minter.apiKeyId === null) {
      const rows = await db
        .select({ id: webSessions.id })
        .from(webSessions)
        .innerJoin(
          accounts,
          and(
            eq(accounts.id, webSessions.accountId),
            eq(accounts.authEpoch, webSessions.authEpoch),
          ),
        )
        .where(
          and(
            eq(webSessions.id, minter.webSessionId),
            eq(webSessions.accountId, minter.accountId),
            isNull(webSessions.revokedAt),
            gt(webSessions.expiresAt, now),
            eq(accounts.status, 'active'),
          ),
        )
        .limit(1);
      return rows.length === 1;
    }
    // Neither credential, or both: not a minter this check can vouch for.
    return false;
  };
  const membership = async (): Promise<boolean> => {
    if (minter.membershipId === null) return true;
    const rows = await db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .innerJoin(accounts, eq(accounts.id, teamMembers.ownerAccountId))
      .where(
        and(
          eq(teamMembers.id, minter.membershipId),
          eq(teamMembers.ownerAccountId, ownerAccountId),
          eq(teamMembers.memberAccountId, minter.accountId),
          eq(teamMembers.role, 'admin'),
          eq(accounts.status, 'active'),
        ),
      )
      .limit(1);
    return rows.length === 1;
  };
  const [credentialLive, membershipLive] = await Promise.all([credential(), membership()]);
  return credentialLive && membershipLive;
}

/**
 * Security sweep #2 — clear every stored gui_control_key minted by one of these
 * credentials or through one of these team memberships. Called INSIDE the
 * transaction that revokes the credential or deletes the membership, so a
 * committed revocation never leaves a key it minted in place:
 *
 *   · api-keys-repo `revokeApiKeyAtomic` — a revoked API key (a customer revoke,
 *     a staff revoke, an account-termination reclaim, a desktop device key revoked
 *     from the dashboard);
 *   · team-members-repo `removeMemberWithInvites` — the removed membership, and
 *     every key the member minted on the owner's account that the removal revoked;
 *   · auth-flows-repo `revokeCredentialsAfterPasswordReset` — the desktop device
 *     keys and web sessions a password reset revokes.
 *
 * Scoped to ACTIVE sessions, which the partial `agent_sessions_active_idx` serves,
 * so a revocation never scans the closed-session history. A key on a closed session
 * is refused at its next use anyway: every control-key gate re-checks the minter
 * live (lib/agent-session-control-key.ts) and clears what it refuses. Returns the
 * number of sessions cleared.
 */
export async function clearGuiControlKeysMintedBy(
  executor: AgentSessionsDb | AgentSessionsTx,
  minted: {
    apiKeyIds?: readonly string[];
    webSessionIds?: readonly string[];
    membershipIds?: readonly string[];
  },
  at: Date,
): Promise<number> {
  const matches: SQL[] = [];
  if (minted.apiKeyIds !== undefined && minted.apiKeyIds.length > 0) {
    matches.push(inArray(agentSessions.guiControlKeyMintedByApiKeyId, [...minted.apiKeyIds]));
  }
  if (minted.webSessionIds !== undefined && minted.webSessionIds.length > 0) {
    matches.push(
      inArray(agentSessions.guiControlKeyMintedByWebSessionId, [...minted.webSessionIds]),
    );
  }
  if (minted.membershipIds !== undefined && minted.membershipIds.length > 0) {
    matches.push(
      inArray(agentSessions.guiControlKeyMintedByMembershipId, [...minted.membershipIds]),
    );
  }
  if (matches.length === 0) return 0;
  const cleared = await executor
    .update(agentSessions)
    .set({ ...CLEARED_GUI_CONTROL_KEY, updatedAt: at })
    .where(and(eq(agentSessions.status, 'active'), or(...matches)))
    .returning({ id: agentSessions.id });
  return cleared.length;
}
