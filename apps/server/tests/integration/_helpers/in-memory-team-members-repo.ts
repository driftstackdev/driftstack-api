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
    return this.invites.find((inv) => inv.inviteTokenHash === hash) ?? null;
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
    if (existing) return existing;
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

  /** Test-only — exposes raw rows for assertions. */
  getAllInvites(): readonly TeamInviteRow[] {
    return this.invites;
  }
  getAllMembers(): readonly TeamMemberRow[] {
    return this.members;
  }
}
