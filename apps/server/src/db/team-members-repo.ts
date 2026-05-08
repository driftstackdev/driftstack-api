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
    // Look for an existing pending invite (not yet accepted) for the
    // (owner, email) pair. If found, refresh the token + expiry.
    // Otherwise insert a new row.
    const [existing] = await this.database.db
      .select()
      .from(teamInvites)
      .where(
        and(
          eq(teamInvites.ownerAccountId, input.ownerAccountId),
          eq(teamInvites.inviteeEmail, input.inviteeEmail),
          isNull(teamInvites.acceptedAt),
        ),
      )
      .limit(1);

    if (existing) {
      const [updated] = await this.database.db
        .update(teamInvites)
        .set({
          inviteTokenHash: input.inviteTokenHash,
          inviteExpiresAt: input.inviteExpiresAt,
          role: input.role,
          invitedByAccountId: input.invitedByAccountId,
        })
        .where(eq(teamInvites.id, existing.id))
        .returning();
      if (!updated) throw new Error('team_invites refresh returned no row');
      return toInviteRow(updated);
    }

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
      .returning();
    if (!row) throw new Error('team_invites insert returned no row');
    return toInviteRow(row);
  }

  async findInviteByTokenHash(hash: string): Promise<TeamInviteRow | null> {
    const [row] = await this.database.db
      .select()
      .from(teamInvites)
      .where(eq(teamInvites.inviteTokenHash, hash))
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
    // Use ON CONFLICT (owner, member) DO NOTHING via INSERT ...
    // .returning() — falls through to a SELECT on conflict so we
    // always return a TeamMemberRow.
    const [inserted] = await this.database.db
      .insert(teamMembers)
      .values({
        ownerAccountId: input.ownerAccountId,
        memberAccountId: input.memberAccountId,
        role: input.role,
        invitedAt: input.invitedAt,
        acceptedAt: input.acceptedAt,
        invitedByAccountId: input.invitedByAccountId,
      })
      .onConflictDoNothing({
        target: [teamMembers.ownerAccountId, teamMembers.memberAccountId],
      })
      .returning();
    const row =
      inserted ??
      (
        await this.database.db
          .select()
          .from(teamMembers)
          .where(
            and(
              eq(teamMembers.ownerAccountId, input.ownerAccountId),
              eq(teamMembers.memberAccountId, input.memberAccountId),
            ),
          )
          .limit(1)
      )[0];
    if (!row) throw new Error('team_members upsert produced no row');
    return this.attachMemberEmail(row, input.memberEmail);
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

  async removeMember(membershipId: string, ownerAccountId: string): Promise<boolean> {
    const result = await this.database.db
      .delete(teamMembers)
      .where(and(eq(teamMembers.id, membershipId), eq(teamMembers.ownerAccountId, ownerAccountId)))
      .returning({ id: teamMembers.id });
    return result.length > 0;
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
