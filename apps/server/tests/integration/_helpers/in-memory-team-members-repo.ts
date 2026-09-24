// V-298b — in-memory TeamMembersRepo for integration tests.

import { randomUUID } from 'node:crypto';
import type {
  InviteUpsertOutcome,
  RemoveMemberResult,
  TeamInviteRow,
  TeamMemberRow,
  TeamMembersRepo,
  TeamRole,
  TeamRow,
} from '../../../src/services/team-members.js';

/**
 * V-1253 — every INTERFACE read hands back a SNAPSHOT, never the stored object.
 *
 * This double mutates stored rows in place (eleven sites: invite fields, membership fields,
 * `acceptedAt` stamps) and its reads used to return those very objects, so a row the caller was
 * already holding kept changing underneath it. A SELECT is a point-in-time copy; a later UPDATE
 * cannot reach into a result already returned.
 *
 * The failure is silent: a before/after comparison against this double reads "nothing changed"
 * whatever the code under test did, because `before` and `after` are one object, and the arm then
 * passes forever asserting nothing. Third and last of the three doubles in this class, after
 * V-1251 (status-subscribers) and V-1252 (oauth-links).
 *
 * `getAllInvites` / `getAllMembers` are deliberately NOT snapshotted — see the note on them.
 */
function snapRow<T extends object>(row: T): T;
function snapRow<T extends object>(row: T | undefined | null): T | null;
function snapRow<T extends object>(row: T | undefined | null): T | null {
  return row ? { ...row } : null;
}

export class InMemoryTeamMembersRepo implements TeamMembersRepo {
  private readonly members: TeamMemberRow[] = [];
  private readonly invites: TeamInviteRow[] = [];
  private readonly teams: TeamRow[] = [];
  /** Test seam — the service needs to look up account email by id. */
  private readonly accountEmails = new Map<string, string>();

  /** Seed an account-id → email mapping so the service can resolve. */
  upsertAccountEmail(accountId: string, email: string): void {
    this.accountEmails.set(accountId, email);
  }

  /**
   * Security sweep #4/#6 — mirrors DrizzleTeamMembersRepo.upsertInviteIfUnderPendingLimit:
   * the same cooldown (send time = expiry − TTL), the same live-pending count
   * (unaccepted AND unexpired), the same exemption for re-sending a live invite,
   * then `upsertInvite`. Sequential, so no lock is needed here; the Drizzle method's
   * lock is exercised against Postgres.
   */
  async upsertInviteIfUnderPendingLimit(input: {
    ownerAccountId: string;
    inviteeEmail: string;
    role: TeamRole;
    inviteTokenHash: string;
    inviteExpiresAt: Date;
    invitedByAccountId: string | null;
    maxPending: number;
    resendCooldownMs: number;
    inviteTtlMs: number;
    now: Date;
    beforeWrite?: () => Promise<void>;
  }): Promise<InviteUpsertOutcome> {
    const nowMs = input.now.getTime();
    const current = this.invites.find(
      (inv) =>
        inv.ownerAccountId === input.ownerAccountId &&
        inv.inviteeEmail === input.inviteeEmail &&
        inv.acceptedAt === null,
    );
    const replacesLive = current !== undefined && current.inviteExpiresAt.getTime() > nowMs;
    if (current !== undefined && replacesLive) {
      const retryAfterMs =
        current.inviteExpiresAt.getTime() - input.inviteTtlMs + input.resendCooldownMs - nowMs;
      if (retryAfterMs > 0) return { kind: 'cooldown', retryAfterMs };
    }
    if (!replacesLive) {
      const live = this.invites.filter(
        (inv) =>
          inv.ownerAccountId === input.ownerAccountId &&
          inv.acceptedAt === null &&
          inv.inviteExpiresAt.getTime() > nowMs,
      );
      if (live.length >= input.maxPending) {
        const oldest = Math.min(...live.map((inv) => inv.inviteExpiresAt.getTime()));
        return {
          kind: 'pending_limit',
          pending: live.length,
          retryAfterMs: Math.max(1, oldest - nowMs),
        };
      }
    }
    if (input.beforeWrite !== undefined) await input.beforeWrite();
    return { kind: 'upserted', invite: await this.upsertInvite(input) };
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
      return snapRow(existing);
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
    return snapRow(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findInviteByTokenHash(hash: string): Promise<TeamInviteRow | null> {
    // SINGLE-USE — only an un-accepted invite is returned (mirrors the Drizzle
    // isNull(acceptedAt) filter); a used token can't be replayed.
    return snapRow(
      this.invites.find((inv) => inv.inviteTokenHash === hash && inv.acceptedAt === null),
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
      return snapRow(existing);
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
    return snapRow(row);
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
      // V-1278 — memberEmail is NOT a `team_members` column. Production never stores it: the
      // Drizzle path returns `attachMemberEmail(row, input.memberEmail)`, so the address on the
      // returned row is always the one the CALLER presented. This fixture kept the address the
      // membership was created with, so re-accepting an invite after the member changed their
      // email handed back the old address — the stale one, from the one path where the caller has
      // just told the repo the current one.
      return snapRow({ ...existing, memberEmail: input.memberEmail });
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
    return snapRow(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async markInviteAccepted(inviteId: string, at: Date): Promise<void> {
    const row = this.invites.find((inv) => inv.id === inviteId);
    if (row) row.acceptedAt = at;
  }

  /** Seed a team so the rename/list paths have something to act on. */
  seedTeam(team: TeamRow): void {
    this.teams.push({ ...team });
  }

  listTeamsOwnedBy(ownerAccountId: string): Promise<TeamRow[]> {
    // Mirrors DrizzleTeamMembersRepo's ORDER BY created_at DESC, for the reason
    // listMembers does: write order here is the REVERSE of what the customer is
    // shown, so an unsorted double lets a test assert the list upside down.
    return Promise.resolve(
      this.teams
        .filter((t) => t.ownerAccountId === ownerAccountId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((t) => snapRow(t)),
    );
  }

  renameTeam(teamId: string, ownerAccountId: string, name: string): Promise<TeamRow | null> {
    const found = this.teams.find((t) => t.id === teamId && t.ownerAccountId === ownerAccountId);
    if (!found) return Promise.resolve(null);
    found.name = name;
    found.updatedAt = new Date();
    return Promise.resolve(snapRow(found));
  }

  // ⚠️ Not `async`, and the reason is a trap worth leaving written down.
  // `listMembers` carried an `eslint-disable-next-line require-await` directly
  // above it. Inserting a new method BETWEEN the directive and this one silently
  // re-pointed the suppression at the inserted method — which is synchronous and
  // never needed it — and this method started failing lint having not changed.
  //
  // `eslint-disable-next-line` binds to whatever line follows it, so inserting
  // after one moves it. Both are now plain Promise-returning methods and neither
  // needs the directive.
  listMembers(ownerAccountId: string): Promise<TeamMemberRow[]> {
    // V-1209 — mirrors DrizzleTeamMembersRepo's `ORDER BY created_at DESC`. Write order is not
    // merely a different order here, it is the REVERSE one, so a unit test asserting this list
    // was asserting it upside down relative to what the customer is shown.
    return Promise.resolve(
      this.members
        .filter((m) => m.ownerAccountId === ownerAccountId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((m) => snapRow(m)),
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listPendingInvites(ownerAccountId: string): Promise<TeamInviteRow[]> {
    // V-1209 — mirrors `ORDER BY created_at DESC`, same reversal as listMembers above.
    return this.invites
      .filter((inv) => inv.ownerAccountId === ownerAccountId && inv.acceptedAt === null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((inv) => snapRow(inv));
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
  ): Promise<RemoveMemberResult | null> {
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
    // V-726 — mirror the Drizzle sibling: revoke the keys this member minted on
    // the owner's account. The real atomicity lives in the transaction there;
    // this twin only has to agree on WHICH keys are revoked.
    const revokedApiKeys: { id: string; name: string }[] = [];
    for (const key of this.mintedApiKeys) {
      if (
        key.accountId === ownerAccountId &&
        key.createdByAccountId === memberAccountId &&
        !key.revoked
      ) {
        key.revoked = true;
        revokedApiKeys.push({ id: key.id, name: key.name ?? key.id });
      }
    }
    return {
      memberAccountId,
      revokedApiKeyIds: revokedApiKeys.map((k) => k.id),
      revokedApiKeys,
      revokedAt: new Date(),
    };
  }

  /**
   * V-726 — stand-in for the api_keys rows a member minted on the owner's
   * account, so a test can prove removal revokes them without a real database.
   */
  readonly mintedApiKeys: {
    id: string;
    accountId: string;
    createdByAccountId: string | null;
    revoked: boolean;
    name?: string;
  }[] = [];

  /**
   * V-1268 — no caller today, and kept deliberately. It is the ONLY writer of `mintedApiKeys`,
   * which `removeMemberWithInvites` reads, so deleting it would not remove dead code — it would
   * make live code unreachable and silently change what that method can return. Measured, not
   * assumed: a dead-surface scan flagged it, and following the read is what distinguished a
   * dead seam from the sole entry point to a live one.
   */
  seedMintedApiKey(input: {
    id: string;
    accountId: string;
    createdByAccountId: string | null;
    name?: string;
  }): void {
    this.mintedApiKeys.push({ ...input, revoked: false });
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

  /**
   * Test-only — exposes raw rows for assertions.
   *
   * V-1253 — deliberately NOT snapshotted, unlike every interface read above. These are not on
   * `TeamMembersRepo`, so they model nothing in production, and fixtures use them to ARRANGE state
   * as well as to assert. Handing back copies would send those arrange-phase writes into throwaway
   * objects, which is exactly how V-1251 turned two unrelated tests red. The snapshot rule belongs
   * to the interface; this is a hatch into the fixture's own state.
   */
  getAllInvites(): readonly TeamInviteRow[] {
    return this.invites;
  }
  getAllMembers(): readonly TeamMemberRow[] {
    return this.members;
  }
}
