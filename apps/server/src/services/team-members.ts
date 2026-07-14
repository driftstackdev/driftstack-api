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
import { canonicalOneTimeTokenUrl } from '../lib/canonical-one-time-token-url.js';
import { BadRequestError, ConflictError, NotFoundError } from '../lib/errors.js';
import type { AccountAuditService } from './account-audit.js';
import type { AuthCache } from './auth-cache.js';
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
  /**
   * ATOMIC accept. Compare-and-swap the exact invite id + presented token hash
   * while it is still unaccepted, then source membership authority from that
   * consumed row and upsert in ONE transaction. A concurrent re-invite makes
   * an old token miss instead of applying its stale role; a concurrent removal
   * makes the same CAS miss instead of allowing membership resurrection.
   * Returns null on every loser path with no membership side effect.
   */
  acceptInviteAtomic(input: {
    inviteId: string;
    inviteTokenHash: string;
    memberAccountId: string;
    memberEmail: string;
    acceptedAt: Date;
  }): Promise<TeamMemberRow | null>;
  /** Mark invite as accepted (idempotent). */
  markInviteAccepted(inviteId: string, at: Date): Promise<void>;
  /** List confirmed members for an owner account. */
  listMembers(ownerAccountId: string): Promise<TeamMemberRow[]>;
  /** List pending (unaccepted) invites for an owner account. */
  listPendingInvites(ownerAccountId: string): Promise<TeamInviteRow[]>;
  /**
   * Remove a member by membership id. Returns the removed member's
   * account id when the row was found + deleted (so the caller can
   * invalidate that member's auth cache); null when the row was not
   * found or owned by a different account.
   */
  removeMember(membershipId: string, ownerAccountId: string): Promise<string | null>;
  /**
   * ATOMIC removal — TOCTOU fix (2026-07-10). Delete the membership AND that
   * member's invites in ONE transaction, so an accept-in-flight can't slip its
   * upsert between the membership delete and the invite delete. Returns the
   * removed member's account id (for auth-cache invalidation), or null when the
   * membership was not found / owned by a different account. Both the membership
   * delete and the invite delete serialize against a concurrent
   * acceptInviteAtomic on the shared invite row.
   */
  removeMemberWithInvites(membershipId: string, ownerAccountId: string): Promise<string | null>;
  /**
   * Delete ALL invites (pending or accepted) for an (owner, invitee-email) pair.
   * Called on member removal so a removed member cannot re-join by accepting a
   * still-pending invite (e.g. one created by a role-change re-invite) — the
   * single-use accept guard only stops replay of an already-USED token, not
   * acceptance of an outstanding un-accepted one. `email` is normalized
   * (trim+lowercase) to match how inviteeEmail is stored.
   */
  deleteInvitesForEmail(ownerAccountId: string, email: string): Promise<void>;
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
    /** V-298f — optional account-audit emitter. When wired, invite /
     *  accept / remove emit customer-audit-log entries (best-effort;
     *  failures never break the underlying operation). */
    private readonly accountAudit: AccountAuditService | null = null,
    /** V-326b — optional auth cache. When wired, accept / removeMember
     *  bump the affected member account's auth version so cached
     *  AccountContext entries miss on the next request and rebuild
     *  with the updated teams[]. Without it, membership changes only
     *  take effect after the 30s cache TTL elapses. */
    private readonly authCache: AuthCache | null = null,
  ) {
    this.dashboardBaseUrl = config.dashboardBaseUrl.replace(/\/+$/, '');
  }

  /**
   * V-326b — best-effort cache invalidation. Failures swallowed:
   * stale teams[] degrades to "no team grants" (safe default), and
   * the next 30s TTL expiry self-heals. We never fail the calling
   * operation just because Redis is unhappy.
   */
  private async invalidateAuthCache(memberAccountId: string): Promise<void> {
    if (!this.authCache) return;
    try {
      await this.authCache.invalidateAccount(memberAccountId);
    } catch {
      /* swallow */
    }
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

    const acceptLink = canonicalOneTimeTokenUrl(`${this.dashboardBaseUrl}/team/accept`, plaintext);
    await this.email.sendTeamInvite({
      to: normalized,
      acceptLink,
      expiresAt: inviteExpiresAt,
      role,
    });
    if (this.accountAudit) {
      try {
        await this.accountAudit.record({
          accountId: input.ownerAccountId,
          actorType: 'customer',
          actorAccountId: input.invitedByAccountId,
          actorKeyId: null,
          action: 'team.member_invited',
          targetResourceId: null,
          payload: { invitee_email: normalized, role },
        });
      } catch {
        /* swallow */
      }
    }
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
    // Atomically consume the exact presented token (CAS on id + hash + still
    // unaccepted) AND upsert the membership in one transaction. Binding the
    // hash prevents an invalidated old link from winning with its stale role
    // after a concurrent re-invite; the repository sources authority fields
    // from the row returned by the CAS, not this earlier snapshot. The same
    // row mutation still serializes against concurrent member removal.
    const membership = await this.repo.acceptInviteAtomic({
      inviteId: invite.id,
      inviteTokenHash: hash,
      memberAccountId: input.acceptingAccountId,
      memberEmail: acceptingEmail,
      acceptedAt: now,
    });
    if (membership === null) {
      throw new NotFoundError('Invite not found or already used.');
    }
    await this.invalidateAuthCache(input.acceptingAccountId);
    if (this.accountAudit) {
      try {
        await this.accountAudit.record({
          accountId: invite.ownerAccountId,
          actorType: 'customer',
          actorAccountId: input.acceptingAccountId,
          actorKeyId: null,
          action: 'team.invite_accepted',
          targetResourceId: `mem_${membership.id}`,
          payload: { invitee_email: invite.inviteeEmail, role: invite.role },
        });
      } catch {
        /* swallow */
      }
    }
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
    // Delete the membership AND cancel any outstanding invites for the removed
    // member in ONE atomic transaction (TOCTOU fix 2026-07-10). This both stops
    // a re-join via a still-pending invite (e.g. one created by a role-change
    // re-invite before the removal — the single-use accept guard only blocks
    // REPLAY of a used token, Fable auth re-audit 2026-07-02) AND closes the
    // membership-resurrection race: an accept that read the invite before this
    // removal can no longer slip its membership upsert between the membership
    // delete and the invite delete, because both delete statements and the
    // accept's compare-and-swap consume of the same invite row now serialize.
    const removedMemberAccountId = await this.repo.removeMemberWithInvites(
      input.membershipId,
      input.ownerAccountId,
    );
    if (removedMemberAccountId === null) return false;
    await this.invalidateAuthCache(removedMemberAccountId);
    if (this.accountAudit) {
      try {
        await this.accountAudit.record({
          accountId: input.ownerAccountId,
          actorType: 'customer',
          actorAccountId: input.ownerAccountId,
          actorKeyId: null,
          action: 'team.member_removed',
          targetResourceId: `mem_${input.membershipId}`,
          payload: {},
        });
      } catch {
        /* swallow */
      }
    }
    return true;
  }
}
