// V-298c — Drizzle-backed TeamMembersRepo.

import { and, desc, eq, isNull } from 'drizzle-orm';
import type {
  TeamInviteRow,
  TeamMemberRow,
  TeamMembersRepo,
  TeamRole,
} from '../services/team-members.js';
import type { Database } from './client.js';
import { accounts, teamInvites, teamMembers } from './schema.js';

type InviteDb = typeof teamInvites.$inferSelect;
type MemberDb = typeof teamMembers.$inferSelect;

function toInviteRow(row: InviteDb): TeamInviteRow {
  return {
    id: row.id,
    ownerAccountId: row.ownerAccountId,
    inviteeEmail: row.inviteeEmail,
    role: row.role,
    inviteTokenHash: row.inviteTokenHash,
    inviteExpiresAt: row.inviteExpiresAt,
    invitedByAccountId: row.invitedByAccountId,
    acceptedAt: row.acceptedAt,
    createdAt: row.createdAt,
  };
}

export class DrizzleTeamMembersRepo implements TeamMembersRepo {
  constructor(private readonly database: Database) {}

  async upsertInvite(input: {
    ownerAccountId: string;
    inviteeEmail: string;
    role: TeamRole;
    inviteTokenHash: string;
    inviteExpiresAt: Date;
    invitedByAccountId: string | null;
  }): Promise<TeamInviteRow> {
    // The partial unique index permits accepted history while making the live
    // (owner, email) authority singular. One INSERT ... ON CONFLICT statement
    // is the serialization point: concurrent mixed-role refreshes cannot both
    // leave consumable credentials behind.
    const [row] = await this.database.db
      .insert(teamInvites)
      .values({
        ownerAccountId: input.ownerAccountId,
        inviteeEmail: input.inviteeEmail,
        role: input.role,
        inviteTokenHash: input.inviteTokenHash,
        inviteExpiresAt: input.inviteExpiresAt,
        invitedByAccountId: input.invitedByAccountId,
      })
      .onConflictDoUpdate({
        target: [teamInvites.ownerAccountId, teamInvites.inviteeEmail],
        targetWhere: isNull(teamInvites.acceptedAt),
        set: {
          inviteTokenHash: input.inviteTokenHash,
          inviteExpiresAt: input.inviteExpiresAt,
          role: input.role,
          invitedByAccountId: input.invitedByAccountId,
        },
      })
      .returning();
    if (!row) throw new Error('team_invites upsert returned no row');
    return toInviteRow(row);
  }

  async findInviteByTokenHash(hash: string): Promise<TeamInviteRow | null> {
    // SINGLE-USE: only an UN-accepted invite is returned. Without the
    // isNull(acceptedAt) filter an already-accepted invite token could be
    // REPLAYED to re-join a team after removal, or to re-escalate a role after
    // a demote (accept() had no acceptedAt guard, markInviteAccepted leaves the
    // row + token valid until the original 7-day expiry, and removeMember didn't
    // touch invites). Filtering here makes accept()'s existing not-found path
    // ("Invite not found or already used.") fire on any replay of a used token.
    // (Fable auth re-audit 2026-07-02.)
    const [row] = await this.database.db
      .select()
      .from(teamInvites)
      .where(and(eq(teamInvites.inviteTokenHash, hash), isNull(teamInvites.acceptedAt)))
      .limit(1);
    return row ? toInviteRow(row) : null;
  }

  async findAccountEmail(accountId: string): Promise<string | null> {
    const [row] = await this.database.db
      .select({ email: accounts.email })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    return row?.email ?? null;
  }

  async upsertMembership(input: {
    ownerAccountId: string;
    memberAccountId: string;
    memberEmail: string;
    role: TeamRole;
    invitedAt: Date;
    acceptedAt: Date;
    invitedByAccountId: string | null;
  }): Promise<TeamMemberRow> {
    // Security fix (2026-06-30 audit) — ON CONFLICT (owner, member) DO
    // UPDATE, not DO NOTHING. Re-inviting + re-accepting an existing
    // member with a DIFFERENT role is the only documented role-change
    // mechanism (see team-members.ts module doc); with DO NOTHING the
    // INSERT was skipped entirely on conflict and the pre-existing row
    // (with the OLD role) was returned unchanged, so an owner demoting
    // an 'admin' member to 'member' silently no-op'd — the member kept
    // full admin write access (effectiveAccountIdForWrite in
    // sessions.ts/profiles.ts/webhooks.ts gates on this exact column).
    // DO UPDATE always returns the affected row via .returning(), so
    // the SELECT-on-conflict fallback is no longer needed. acceptedAt
    // is intentionally NOT in the SET clause — it stays the original
    // accept timestamp ("member since"); only role/invitedAt/inviter
    // refresh on a re-accept.
    const [row] = await this.database.db
      .insert(teamMembers)
      .values({
        ownerAccountId: input.ownerAccountId,
        memberAccountId: input.memberAccountId,
        role: input.role,
        invitedAt: input.invitedAt,
        acceptedAt: input.acceptedAt,
        invitedByAccountId: input.invitedByAccountId,
      })
      .onConflictDoUpdate({
        target: [teamMembers.ownerAccountId, teamMembers.memberAccountId],
        set: {
          role: input.role,
          invitedAt: input.invitedAt,
          invitedByAccountId: input.invitedByAccountId,
        },
      })
      .returning();
    if (!row) throw new Error('team_members upsert produced no row');
    return this.attachMemberEmail(row, input.memberEmail);
  }

  async acceptInviteAtomic(input: {
    inviteId: string;
    inviteTokenHash: string;
    memberAccountId: string;
    memberEmail: string;
    acceptedAt: Date;
  }): Promise<TeamMemberRow | null> {
    // Compare-and-swap the exact presented credential, then source owner, role,
    // invite time, and inviter from the consumed database row. A concurrent
    // re-invite that replaces the hash makes the stale accept miss; a concurrent
    // remove that deletes the row also makes it miss. The row mutation remains
    // the shared serialization point for both races.
    return this.database.db.transaction(async (tx) => {
      const [consumed] = await tx
        .update(teamInvites)
        .set({ acceptedAt: input.acceptedAt })
        .where(
          and(
            eq(teamInvites.id, input.inviteId),
            eq(teamInvites.inviteTokenHash, input.inviteTokenHash),
            isNull(teamInvites.acceptedAt),
          ),
        )
        .returning();
      if (!consumed) return null;
      const [row] = await tx
        .insert(teamMembers)
        .values({
          ownerAccountId: consumed.ownerAccountId,
          memberAccountId: input.memberAccountId,
          role: consumed.role,
          invitedAt: consumed.createdAt,
          acceptedAt: input.acceptedAt,
          invitedByAccountId: consumed.invitedByAccountId,
        })
        .onConflictDoUpdate({
          target: [teamMembers.ownerAccountId, teamMembers.memberAccountId],
          set: {
            role: consumed.role,
            invitedAt: consumed.createdAt,
            invitedByAccountId: consumed.invitedByAccountId,
          },
        })
        .returning();
      if (!row) throw new Error('team_members upsert produced no row');
      return this.attachMemberEmail(row, input.memberEmail);
    });
  }

  async markInviteAccepted(inviteId: string, at: Date): Promise<void> {
    await this.database.db
      .update(teamInvites)
      .set({ acceptedAt: at })
      .where(eq(teamInvites.id, inviteId));
  }

  async listMembers(ownerAccountId: string): Promise<TeamMemberRow[]> {
    // Join accounts to surface member email at list-time. The shape
    // matches in-memory repo's TeamMemberRow with memberEmail filled.
    const rows = await this.database.db
      .select({
        id: teamMembers.id,
        ownerAccountId: teamMembers.ownerAccountId,
        memberAccountId: teamMembers.memberAccountId,
        memberEmail: accounts.email,
        role: teamMembers.role,
        invitedAt: teamMembers.invitedAt,
        acceptedAt: teamMembers.acceptedAt,
        invitedByAccountId: teamMembers.invitedByAccountId,
        createdAt: teamMembers.createdAt,
      })
      .from(teamMembers)
      .innerJoin(accounts, eq(accounts.id, teamMembers.memberAccountId))
      .where(eq(teamMembers.ownerAccountId, ownerAccountId))
      .orderBy(desc(teamMembers.createdAt));
    return rows;
  }

  async listPendingInvites(ownerAccountId: string): Promise<TeamInviteRow[]> {
    const rows = await this.database.db
      .select()
      .from(teamInvites)
      .where(and(eq(teamInvites.ownerAccountId, ownerAccountId), isNull(teamInvites.acceptedAt)))
      .orderBy(desc(teamInvites.createdAt));
    return rows.map(toInviteRow);
  }

  async removeMember(membershipId: string, ownerAccountId: string): Promise<string | null> {
    const result = await this.database.db
      .delete(teamMembers)
      .where(and(eq(teamMembers.id, membershipId), eq(teamMembers.ownerAccountId, ownerAccountId)))
      .returning({ memberAccountId: teamMembers.memberAccountId });
    return result.length > 0 ? (result[0]?.memberAccountId ?? null) : null;
  }

  async removeMemberWithInvites(
    membershipId: string,
    ownerAccountId: string,
  ): Promise<string | null> {
    // TOCTOU fix (2026-07-10 audit) — delete the membership AND cancel that
    // member's invites in one transaction, so a concurrent acceptInviteAtomic
    // can't slip its membership upsert between the membership delete and the
    // invite delete. The invite delete + the accept's CAS on the same invite
    // row serialize, so a just-removed member can't resurrect their seat. Same
    // owner-scoped WHERE as removeMember (id + ownerAccountId); same normalized
    // (owner, email) predicate as deleteInvitesForEmail.
    return this.database.db.transaction(async (tx) => {
      const result = await tx
        .delete(teamMembers)
        .where(
          and(eq(teamMembers.id, membershipId), eq(teamMembers.ownerAccountId, ownerAccountId)),
        )
        .returning({ memberAccountId: teamMembers.memberAccountId });
      const memberAccountId = result.length > 0 ? (result[0]?.memberAccountId ?? null) : null;
      if (memberAccountId === null) return null;
      const [account] = await tx
        .select({ email: accounts.email })
        .from(accounts)
        .where(eq(accounts.id, memberAccountId))
        .limit(1);
      if (account?.email) {
        await tx
          .delete(teamInvites)
          .where(
            and(
              eq(teamInvites.ownerAccountId, ownerAccountId),
              eq(teamInvites.inviteeEmail, account.email.trim().toLowerCase()),
            ),
          );
      }
      return memberAccountId;
    });
  }

  async deleteInvitesForEmail(ownerAccountId: string, email: string): Promise<void> {
    await this.database.db
      .delete(teamInvites)
      .where(
        and(
          eq(teamInvites.ownerAccountId, ownerAccountId),
          eq(teamInvites.inviteeEmail, email.trim().toLowerCase()),
        ),
      );
  }

  /** Helper — when an upsertMembership returns just the team_members row,
   *  we still need memberEmail to populate the TeamMemberRow shape. The
   *  caller already has it (passed in input.memberEmail). */
  private attachMemberEmail(row: MemberDb, memberEmail: string): TeamMemberRow {
    return {
      id: row.id,
      ownerAccountId: row.ownerAccountId,
      memberAccountId: row.memberAccountId,
      memberEmail,
      role: row.role,
      invitedAt: row.invitedAt,
      acceptedAt: row.acceptedAt,
      invitedByAccountId: row.invitedByAccountId,
      createdAt: row.createdAt,
    };
  }
}
