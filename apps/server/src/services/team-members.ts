// V-298b — Team RBAC v1 service.
//
// Models a "team" as one owner-account + N member-accounts joined via
// the team_members table. Each member is itself a regular `accounts`
// row (their own login + email); team membership is a separate
// relationship. The auth path integration lives in V-298c — for
// V-298b, the service is pure (no auth-cache writes, no scope checks
// beyond what the route layer enforces at construction-time).
//
// Invite flow:
//   1. Owner (or admin team member) calls invite(inviterId, email, role).
//      Service generates a 7-day token + emails the invitee.
//   2. Invitee receives the email. They sign up (if not already a
//      Driftstack customer) and verify their email.
//   3. Invitee clicks the accept link. Service looks up the invite by
//      token-hash, asserts the invitee's account email matches, writes
//      the team_members row, marks the invite accepted.
//
// Idempotency:
//   - Re-inviting the same email = the existing pending invite gets a
//     fresh token (old token invalidated). No duplicate row.
//   - Re-accepting = the team_members row is unique-keyed (owner +
//     member); the second accept finds the row already there and
//     returns the existing membership without error.

import { generateAuthToken, tokenHash } from '../lib/auth-tokens.js';
import { BadRequestError, ConflictError, NotFoundError } from '../lib/errors.js';
import type { EmailService } from './email.js';

export type TeamRole = 'member' | 'admin';

export interface TeamMemberRow {
  id: string;
  ownerAccountId: string;
  memberAccountId: string;
  memberEmail: string;
  role: TeamRole;
  invitedAt: Date;
  acceptedAt: Date;
  invitedByAccountId: string | null;
  createdAt: Date;
}

export interface TeamInviteRow {
  id: string;
  ownerAccountId: string;
  inviteeEmail: string;
  role: TeamRole;
  inviteTokenHash: string;
  inviteExpiresAt: Date;
  invitedByAccountId: string | null;
  acceptedAt: Date | null;
  createdAt: Date;
}

export interface TeamMembersRepo {
  /** Insert or refresh a pending invite (deduped by owner + email). */
  upsertInvite(input: {
    ownerAccountId: string;
    inviteeEmail: string;
    role: TeamRole;
    inviteTokenHash: string;
    inviteExpiresAt: Date;
    invitedByAccountId: string | null;
  }): Promise<TeamInviteRow>;
  /** Token-hash lookup for the accept path. Returns null if not found. */
  findInviteByTokenHash(hash: string): Promise<TeamInviteRow | null>;
  /** Resolve an account row's email by id. Used to assert invite-email match. */
  findAccountEmail(accountId: string): Promise<string | null>;
  /** Insert team_members row; returns the inserted row OR the existing
   *  one if (owner, member) already paired. */
  upsertMembership(input: {
    ownerAccountId: string;
    memberAccountId: string;
    memberEmail: string;
    role: TeamRole;
    invitedAt: Date;
    acceptedAt: Date;
    invitedByAccountId: string | null;
  }): Promise<TeamMemberRow>;
  /** Mark invite as accepted (idempotent). */
  markInviteAccepted(inviteId: string, at: Date): Promise<void>;
  /** List confirmed members for an owner account. */
  listMembers(ownerAccountId: string): Promise<TeamMemberRow[]>;
  /** List pending (unaccepted) invites for an owner account. */
  listPendingInvites(ownerAccountId: string): Promise<TeamInviteRow[]>;
  /** Remove a member by membership id; returns true if removed. */
  removeMember(membershipId: string, ownerAccountId: string): Promise<boolean>;
}

export const TEAM_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface TeamMembersServiceConfig {
  /** Public origin of the customer-dashboard, used to build accept URLs in invite emails. */
  dashboardBaseUrl: string;
}

export class TeamMembersService {
  private readonly dashboardBaseUrl: string;

  constructor(
    private readonly repo: TeamMembersRepo,
    private readonly email: EmailService,
    config: TeamMembersServiceConfig,
  ) {
    this.dashboardBaseUrl = config.dashboardBaseUrl.replace(/\/+$/, '');
  }

  /**
   * Invite an email to join the calling owner's team. Generates a
   * 7-day token + sends the invite email. Idempotent: re-inviting the
   * same email replaces the existing pending invite with a fresh
   * token (the old token becomes invalid immediately).
   */
  async invite(input: {
    ownerAccountId: string;
    invitedByAccountId: string;
    inviteeEmail: string;
    role?: TeamRole;
  }): Promise<{ accepted: true }> {
    const normalized = input.inviteeEmail.trim().toLowerCase();
    if (!normalized || !normalized.includes('@')) {
      throw new BadRequestError('Invalid invitee email.');
    }
    const role: TeamRole = input.role ?? 'member';
    const plaintext = generateAuthToken();
    const inviteTokenHash = tokenHash(plaintext);
    const inviteExpiresAt = new Date(Date.now() + TEAM_INVITE_TTL_MS);

    await this.repo.upsertInvite({
      ownerAccountId: input.ownerAccountId,
      inviteeEmail: normalized,
      role,
      inviteTokenHash,
      inviteExpiresAt,
      invitedByAccountId: input.invitedByAccountId,
    });

    const acceptLink = `${this.dashboardBaseUrl}/team/accept?token=${encodeURIComponent(plaintext)}`;
    await this.email.sendTeamInvite({
      to: normalized,
      acceptLink,
      expiresAt: inviteExpiresAt,
      role,
    });
    return { accepted: true };
  }

  /**
   * Accept a pending invite. The accepting account's email MUST match
   * the invite's invitee email — prevents accidentally accepting an
   * invite addressed to someone else even if they shared the URL.
   */
  async accept(input: {
    plaintextToken: string;
    acceptingAccountId: string;
  }): Promise<{ membership: TeamMemberRow }> {
    const hash = tokenHash(input.plaintextToken);
    const invite = await this.repo.findInviteByTokenHash(hash);
    if (!invite) {
      throw new NotFoundError('Invite not found or already used.');
    }
    if (invite.inviteExpiresAt < new Date()) {
      throw new BadRequestError('Invite has expired. Ask the team to send a fresh invite.');
    }
    const acceptingEmail = await this.repo.findAccountEmail(input.acceptingAccountId);
    if (!acceptingEmail) {
      throw new NotFoundError('Accepting account not found.');
    }
    if (acceptingEmail.trim().toLowerCase() !== invite.inviteeEmail) {
      throw new ConflictError(
        'The signed-in account does not match the invitee email. Sign in with the address the invite was sent to, or ask for a fresh invite.',
      );
    }
    const now = new Date();
    const membership = await this.repo.upsertMembership({
      ownerAccountId: invite.ownerAccountId,
      memberAccountId: input.acceptingAccountId,
      memberEmail: acceptingEmail,
      role: invite.role,
      invitedAt: invite.createdAt,
      acceptedAt: now,
      invitedByAccountId: invite.invitedByAccountId,
    });
    await this.repo.markInviteAccepted(invite.id, now);
    return { membership };
  }

  /** All confirmed team members for an owner account. */
  async listMembers(ownerAccountId: string): Promise<TeamMemberRow[]> {
    return this.repo.listMembers(ownerAccountId);
  }

  /** All pending (unaccepted, unexpired) invites for an owner account. */
  async listPendingInvites(ownerAccountId: string): Promise<TeamInviteRow[]> {
    const all = await this.repo.listPendingInvites(ownerAccountId);
    const now = new Date();
    return all.filter((inv) => inv.acceptedAt === null && inv.inviteExpiresAt >= now);
  }

  /** Remove a member from the team. Returns true if removed; false if
   *  membership not found or owned by a different account. */
  async removeMember(input: { membershipId: string; ownerAccountId: string }): Promise<boolean> {
    return this.repo.removeMember(input.membershipId, input.ownerAccountId);
  }
}
