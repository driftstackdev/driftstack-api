// V-298b — in-memory TeamMembersRepo for integration tests.

import { randomUUID } from 'node:crypto';
import type {
  TeamInviteRow,
  TeamMemberRow,
  TeamMembersRepo,
  TeamRole,
} from '../../../src/services/team-members.js';

export class InMemoryTeamMembersRepo implements TeamMembersRepo {
  private readonly members: TeamMemberRow[] = [];
  private readonly invites: TeamInviteRow[] = [];
  /** Test seam — the service needs to look up account email by id. */
  private readonly accountEmails = new Map<string, string>();

  /** Seed an account-id → email mapping so the service can resolve. */
  upsertAccountEmail(accountId: string, email: string): void {
    this.accountEmails.set(accountId, email);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async upsertInvite(input: {
    ownerAccountId: string;
    inviteeEmail: string;
    role: TeamRole;
    inviteTokenHash: string;
    inviteExpiresAt: Date;
    invitedByAccountId: string | null;
  }): Promise<TeamInviteRow> {
    const existing = this.invites.find(
      (inv) =>
        inv.ownerAccountId === input.ownerAccountId &&
        inv.inviteeEmail === input.inviteeEmail &&
        inv.acceptedAt === null,
    );
    if (existing) {
      existing.inviteTokenHash = input.inviteTokenHash;
      existing.inviteExpiresAt = input.inviteExpiresAt;
      existing.role = input.role;
      existing.invitedByAccountId = input.invitedByAccountId;
      return existing;
    }
    const row: TeamInviteRow = {
      id: randomUUID(),
      ownerAccountId: input.ownerAccountId,
      inviteeEmail: input.inviteeEmail,
      role: input.role,
      inviteTokenHash: input.inviteTokenHash,
      inviteExpiresAt: input.inviteExpiresAt,
      invitedByAccountId: input.invitedByAccountId,
      acceptedAt: null,
      createdAt: new Date(),
    };
    this.invites.push(row);
    return row;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findInviteByTokenHash(hash: string): Promise<TeamInviteRow | null> {
    // SINGLE-USE — only an un-accepted invite is returned (mirrors the Drizzle
    // isNull(acceptedAt) filter); a used token can't be replayed.
    return (
      this.invites.find((inv) => inv.inviteTokenHash === hash && inv.acceptedAt === null) ?? null
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findAccountEmail(accountId: string): Promise<string | null> {
    return this.accountEmails.get(accountId) ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async upsertMembership(input: {
    ownerAccountId: string;
    memberAccountId: string;
    memberEmail: string;
    role: TeamRole;
    invitedAt: Date;
    acceptedAt: Date;
    invitedByAccountId: string | null;
  }): Promise<TeamMemberRow> {
    const existing = this.members.find(
      (m) =>
        m.ownerAccountId === input.ownerAccountId && m.memberAccountId === input.memberAccountId,
    );
    if (existing) {
      // Security fix (2026-06-30 audit) — mirror DrizzleTeamMembersRepo's
      // onConflictDoUpdate: a re-accept with a new role must actually
      // overwrite the stored role, not silently no-op (see
      // db/team-members-repo.ts upsertMembership for the full
      // rationale). acceptedAt intentionally untouched, same as the
      // Drizzle SET clause.
      existing.role = input.role;
      existing.invitedAt = input.invitedAt;
      existing.invitedByAccountId = input.invitedByAccountId;
      return existing;
    }
    const row: TeamMemberRow = {
      id: randomUUID(),
      ownerAccountId: input.ownerAccountId,
      memberAccountId: input.memberAccountId,
      memberEmail: input.memberEmail,
      role: input.role,
      invitedAt: input.invitedAt,
      acceptedAt: input.acceptedAt,
      invitedByAccountId: input.invitedByAccountId,
      createdAt: new Date(),
    };
    this.members.push(row);
    return row;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async acceptInviteAtomic(input: {
    inviteId: string;
    inviteTokenHash: string;
    memberAccountId: string;
    memberEmail: string;
    acceptedAt: Date;
  }): Promise<TeamMemberRow | null> {
    // Exact-credential CAS mirror. A replaced token, removed invite, or already
    // accepted invite returns null without creating a membership. Authority
    // fields come from the consumed row, matching the Drizzle transaction.
    const invite = this.invites.find((inv) => inv.id === input.inviteId);
    if (!invite || invite.inviteTokenHash !== input.inviteTokenHash || invite.acceptedAt !== null) {
      return null;
    }
    invite.acceptedAt = input.acceptedAt;
    const existing = this.members.find(
      (m) =>
        m.ownerAccountId === invite.ownerAccountId && m.memberAccountId === input.memberAccountId,
    );
    if (existing) {
      // Mirror upsertMembership's onConflictDoUpdate: role/invitedAt/inviter
      // refresh, acceptedAt untouched ("member since" preserved).
      existing.role = invite.role;
      existing.invitedAt = invite.createdAt;
      existing.invitedByAccountId = invite.invitedByAccountId;
      return existing;
    }
    const row: TeamMemberRow = {
      id: randomUUID(),
      ownerAccountId: invite.ownerAccountId,
      memberAccountId: input.memberAccountId,
      memberEmail: input.memberEmail,
      role: invite.role,
      invitedAt: invite.createdAt,
      acceptedAt: input.acceptedAt,
      invitedByAccountId: invite.invitedByAccountId,
      createdAt: new Date(),
    };
    this.members.push(row);
    return row;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async markInviteAccepted(inviteId: string, at: Date): Promise<void> {
    const row = this.invites.find((inv) => inv.id === inviteId);
    if (row) row.acceptedAt = at;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listMembers(ownerAccountId: string): Promise<TeamMemberRow[]> {
    return this.members.filter((m) => m.ownerAccountId === ownerAccountId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listPendingInvites(ownerAccountId: string): Promise<TeamInviteRow[]> {
    return this.invites.filter(
      (inv) => inv.ownerAccountId === ownerAccountId && inv.acceptedAt === null,
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async removeMember(membershipId: string, ownerAccountId: string): Promise<string | null> {
    const idx = this.members.findIndex(
      (m) => m.id === membershipId && m.ownerAccountId === ownerAccountId,
    );
    if (idx === -1) return null;
    const removed = this.members[idx];
    this.members.splice(idx, 1);
    return removed?.memberAccountId ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async removeMemberWithInvites(
    membershipId: string,
    ownerAccountId: string,
  ): Promise<string | null> {
    // TOCTOU fix mirror — delete the membership + that member's invites in one
    // logical step (replicates removeMember + deleteInvitesForEmail). Sequential
    // here (no real concurrency), but the atomic Drizzle sibling is what closes
    // the resurrection race in production.
    const idx = this.members.findIndex(
      (m) => m.id === membershipId && m.ownerAccountId === ownerAccountId,
    );
    if (idx === -1) return null;
    const removed = this.members[idx];
    this.members.splice(idx, 1);
    const memberAccountId = removed?.memberAccountId ?? null;
    if (memberAccountId === null) return null;
    const email = this.accountEmails.get(memberAccountId);
    if (email) {
      const norm = email.trim().toLowerCase();
      for (let i = this.invites.length - 1; i >= 0; i--) {
        const inv = this.invites[i];
        if (inv && inv.ownerAccountId === ownerAccountId && inv.inviteeEmail === norm) {
          this.invites.splice(i, 1);
        }
      }
    }
    return memberAccountId;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async deleteInvitesForEmail(ownerAccountId: string, email: string): Promise<void> {
    const norm = email.trim().toLowerCase();
    for (let i = this.invites.length - 1; i >= 0; i--) {
      const inv = this.invites[i];
      if (inv && inv.ownerAccountId === ownerAccountId && inv.inviteeEmail === norm) {
        this.invites.splice(i, 1);
      }
    }
  }

  /** Test-only — exposes raw rows for assertions. */
  getAllInvites(): readonly TeamInviteRow[] {
    return this.invites;
  }
  getAllMembers(): readonly TeamMemberRow[] {
    return this.members;
  }
}
