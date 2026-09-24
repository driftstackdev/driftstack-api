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

import type { AccountTier } from '@driftstack/api-types';
import { generateAuthToken, tokenHash } from '../lib/auth-tokens.js';
import { canonicalOneTimeTokenUrl } from '../lib/canonical-one-time-token-url.js';
import { BadRequestError, ConflictError, NotFoundError, RateLimitedError } from '../lib/errors.js';
import type { AccountAuditService } from './account-audit.js';
import type { RevocationWebhookEmitter } from './api-keys.js';
import type { Logger } from '../lib/logger.js';
import { logLostWebhookEvent } from './webhooks.js';
import type { AuthCache } from './auth-cache.js';
import type { EmailService } from './email.js';
import { describeWait } from './recipient-email-limit.js';

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

/**
 * V-726 — outcome of an atomic member removal. `revokedApiKeyIds` are the keys
 * this member had minted on the OWNER's account, revoked in the same
 * transaction as the membership delete.
 *
 * They have to go together. A key authenticates as its `accountId` — the owner —
 * and never re-checks whether the account that minted it is still a member, so
 * deleting the membership alone left an offboarded member holding a live
 * credential with full owner authority. Doing the revocation outside the
 * transaction would be worse than useless: a failure after a committed removal
 * reports success while the credential lives on, and the obvious retry 404s on
 * the now-missing membership, so it never self-heals.
 */
export interface RemoveMemberResult {
  memberAccountId: string;
  revokedApiKeyIds: string[];
  /** The same keys with their names, for the api_key.revoked webhook + audit rows. */
  revokedApiKeys: { id: string; name: string }[];
  /** The instant the removal revoked them (one statement, one timestamp). */
  revokedAt: Date;
}

/**
 * A team as a THING, from the `teams` table (V-1611 #14, migration 0114).
 *
 * ⚠️ `slug` is nullable and stays that way. The migration's own comment records
 * why: whether team slugs become public URL components is an open product
 * decision, and minting one here would settle it silently. Nullable-unique-when-
 * set mirrors `accounts_slug_unique` exactly, so adding slugs later is additive
 * against a column that already exists.
 */
export interface TeamRow {
  id: string;
  name: string;
  slug: string | null;
  ownerAccountId: string;
  createdAt: Date;
  updatedAt: Date;
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
  /**
   * Security sweep #4/#6 — `upsertInvite` under the invite limits, decided under
   * one per-owner lock so concurrent invites serialise:
   *
   *   - `cooldown` when (owner, email) already has a live pending invite sent less
   *     than `resendCooldownMs` ago. Nothing is written: the emailed link keeps
   *     working. An invite's send time is `inviteExpiresAt - inviteTtlMs` (every
   *     send sets the expiry to send time + TTL), so no column records it.
   *   - `pending_limit` when the owner already has `maxPending` live pending
   *     invites (unaccepted, unexpired) and this one would add another. Re-sending
   *     an invite that is already live does not add one, so it is not refused.
   *     `retryAfterMs` is until the oldest of them expires.
   *   - otherwise `beforeWrite` runs (it may throw, and then nothing is written),
   *     and the invite is `upserted` exactly as `upsertInvite` would.
   */
  upsertInviteIfUnderPendingLimit(input: {
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
    /**
     * Runs after both limits pass and before anything is written — the caller's
     * last word (the per-address email limit), so a refused request changes
     * nothing and an attempt the cooldown refuses spends none of it.
     */
    beforeWrite?: () => Promise<void>;
  }): Promise<InviteUpsertOutcome>;
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
  removeMemberWithInvites(
    membershipId: string,
    ownerAccountId: string,
  ): Promise<RemoveMemberResult | null>;
  /**
   * Delete ALL invites (pending or accepted) for an (owner, invitee-email) pair.
   * Called on member removal so a removed member cannot re-join by accepting a
   * still-pending invite (e.g. one created by a role-change re-invite) — the
   * single-use accept guard only stops replay of an already-USED token, not
   * acceptance of an outstanding un-accepted one. `email` is normalized
   * (trim+lowercase) to match how inviteeEmail is stored.
   */
  deleteInvitesForEmail(ownerAccountId: string, email: string): Promise<void>;

  /** Teams this account OWNS, newest first. */
  listTeamsOwnedBy(ownerAccountId: string): Promise<TeamRow[]>;

  /**
   * Rename a team the account owns. Returns the updated row, or null when no
   * team matches BOTH the id and the owner — so a caller cannot distinguish
   * "does not exist" from "not yours", which is the whole point of the pair.
   */
  renameTeam(teamId: string, ownerAccountId: string, name: string): Promise<TeamRow | null>;
}

export const TEAM_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** What {@link TeamMembersRepo.upsertInviteIfUnderPendingLimit} decided. */
export type InviteUpsertOutcome =
  | { kind: 'upserted'; invite: TeamInviteRow }
  | { kind: 'cooldown'; retryAfterMs: number }
  | { kind: 'pending_limit'; pending: number; retryAfterMs: number };

/**
 * Security sweep #6 — at most this many invites waiting to be accepted per team.
 * An invite stops counting when it is accepted or expires (7 days after it was
 * sent). There is no route to withdraw one yet, so the cap is set well above a
 * real team's burst of invitations.
 */
export const MAX_PENDING_TEAM_INVITES = 20;

/**
 * Security sweep #4/#6 — re-inviting an address inside this long after its last
 * invite email is refused and sends nothing (the link already sent still works).
 */
export const TEAM_INVITE_RESEND_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Security sweep #6 — the plans that include teammates. The pricing page says
 * "On a paid plan, invite teammates", and that is the whole of the published seat
 * rule: `TIER_FEATURES` carries no seat count. So every paid plan may invite and
 * the free plan may not. (docs/architecture/team-roles-taxonomy.md sketches
 * per-plan seat counts; none is published or enforced, and choosing them is a
 * packaging decision, not this gate's.)
 */
export function tierIncludesTeammates(tier: AccountTier): boolean {
  return tier !== 'free';
}

/** The refusal a plan without teammates gets. */
export const TEAMMATES_NOT_ON_PLAN =
  'Inviting teammates is available on paid plans. Upgrade your plan to invite people to your account.';

export interface TeamMembersServiceConfig {
  /** Public origin of the customer-dashboard, used to build accept URLs in invite emails. */
  dashboardBaseUrl: string;
  /** Test seam: the clock invites are sent and limited by. Defaults to the wall clock. */
  now?: () => Date;
}

export class TeamMembersService {
  private readonly dashboardBaseUrl: string;
  private readonly now: () => Date;

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
    /** Team-keys follow-up — the owner's api_key.revoked webhook for every key a
     *  removal revokes (webhooks/events.md: sent "regardless of who initiated the
     *  revocation"). Optional like the others; best-effort. */
    private readonly webhooks: RevocationWebhookEmitter | null = null,
    /** Webhooks audit #5 — where a lost `api_key.revoked` is reported. */
    private readonly logger: Logger | null = null,
  ) {
    this.dashboardBaseUrl = config.dashboardBaseUrl.replace(/\/+$/, '');
    this.now = config.now ?? (() => new Date());
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

  /** Best-effort eviction of one revoked key's cached context; same rules as above. */
  private async invalidateKeyCache(keyId: string): Promise<void> {
    if (!this.authCache) return;
    try {
      await this.authCache.invalidateKey(keyId);
    } catch {
      /* swallow */
    }
  }

  /** Teams the caller owns. */
  async listTeams(ownerAccountId: string): Promise<TeamRow[]> {
    return this.repo.listTeamsOwnedBy(ownerAccountId);
  }

  /**
   * Rename a team the caller owns.
   *
   * ⛔ Returns null rather than throwing when the team is not the caller's. The
   * route turns that into a 404, deliberately the SAME answer an unknown id
   * gets: distinguishing them would let anyone probe which team ids exist by
   * reading the status code.
   *
   * The audit row is best-effort and its failure never fails the rename, which
   * matches every other mutation on this service. It carries the previous name —
   * an audit entry saying only "renamed" cannot answer the one question anybody
   * asks of it.
   */
  async renameTeam(input: {
    teamId: string;
    ownerAccountId: string;
    actorAccountId: string;
    name: string;
  }): Promise<TeamRow | null> {
    const before = (await this.repo.listTeamsOwnedBy(input.ownerAccountId)).find(
      (t) => t.id === input.teamId,
    );
    const updated = await this.repo.renameTeam(input.teamId, input.ownerAccountId, input.name);
    if (updated === null) return null;
    if (this.accountAudit) {
      try {
        await this.accountAudit.record({
          accountId: input.ownerAccountId,
          actorType: 'customer',
          actorAccountId: input.actorAccountId,
          actorKeyId: null,
          action: 'team.updated',
          targetResourceId: updated.id,
          payload: { previous_name: before?.name ?? null, name: updated.name },
        });
      } catch {
        /* swallow */
      }
    }
    return updated;
  }

  /**
   * Invite an email to join the calling owner's team. Generates a
   * 7-day token + sends the invite email. Idempotent: re-inviting the
   * same email replaces the existing pending invite with a fresh
   * token (the old token becomes invalid immediately).
   *
   * Security sweep #4/#6 — except inside {@link TEAM_INVITE_RESEND_COOLDOWN_MS} of
   * the last invite email to that address, when it is refused (429) and nothing
   * changes; and a team already holding {@link MAX_PENDING_TEAM_INVITES} invites
   * waiting is refused a new one (429). Both are decided in the repository under
   * one lock. The plan gate and the per-address limit run at the route.
   */
  async invite(input: {
    ownerAccountId: string;
    invitedByAccountId: string;
    inviteeEmail: string;
    role?: TeamRole;
    /**
     * Security sweep #4 — runs once the team's own limits pass and before the
     * invite is written or sent; throwing refuses the invite with nothing changed.
     * The route passes the per-address email limit here.
     */
    beforeSend?: () => Promise<void>;
  }): Promise<{ accepted: true }> {
    const normalized = input.inviteeEmail.trim().toLowerCase();
    if (!normalized || !normalized.includes('@')) {
      throw new BadRequestError('Invalid invitee email.');
    }
    const role: TeamRole = input.role ?? 'member';
    const plaintext = generateAuthToken();
    const inviteTokenHash = tokenHash(plaintext);
    const now = this.now();
    const inviteExpiresAt = new Date(now.getTime() + TEAM_INVITE_TTL_MS);

    const outcome = await this.repo.upsertInviteIfUnderPendingLimit({
      ownerAccountId: input.ownerAccountId,
      inviteeEmail: normalized,
      role,
      inviteTokenHash,
      inviteExpiresAt,
      invitedByAccountId: input.invitedByAccountId,
      maxPending: MAX_PENDING_TEAM_INVITES,
      resendCooldownMs: TEAM_INVITE_RESEND_COOLDOWN_MS,
      inviteTtlMs: TEAM_INVITE_TTL_MS,
      now,
      ...(input.beforeSend !== undefined ? { beforeWrite: input.beforeSend } : {}),
    });
    if (outcome.kind === 'cooldown') {
      const cooldownMinutes = Math.round(TEAM_INVITE_RESEND_COOLDOWN_MS / 60_000);
      throw new RateLimitedError(
        Math.max(1, Math.ceil(outcome.retryAfterMs / 1000)),
        `An invite was emailed to this address less than ${cooldownMinutes.toString()} minutes ago. You can send it again in ${describeWait(outcome.retryAfterMs)}.`,
      );
    }
    if (outcome.kind === 'pending_limit') {
      throw new RateLimitedError(
        Math.max(1, Math.ceil(outcome.retryAfterMs / 1000)),
        `Your team has ${outcome.pending.toString()} invites waiting to be accepted, the most allowed at once. Try again when one is accepted, or in ${describeWait(outcome.retryAfterMs)}, when the oldest expires.`,
      );
    }

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
    // V-726 — the same transaction also revokes every live key this member
    // minted on the owner's account (see RemoveMemberResult for why it cannot be
    // a separate step).
    const removed = await this.repo.removeMemberWithInvites(
      input.membershipId,
      input.ownerAccountId,
    );
    if (removed === null) return false;
    const removedMemberAccountId = removed.memberAccountId;
    await this.invalidateAuthCache(removedMemberAccountId);
    // The revoked keys live on the OWNER's account, so the member's invalidation
    // above does not touch their cache entries. Evict each one, as a direct revoke
    // does (ApiKeysService.revokeChecked). A positive cache hit already re-reads the
    // key row and refuses a revoked one, so this is not what stops the key working;
    // it keeps the cache from holding a dead credential until its TTL.
    for (const keyId of removed.revokedApiKeyIds) {
      await this.invalidateKeyCache(keyId);
    }
    // Team-keys follow-up — each key the removal revoked is a revocation like any
    // other: the owner's systems hear of it through api_key.revoked, and the audit
    // log carries one api_key.revoked row per key, as a direct revoke writes
    // (ApiKeysService.revokeChecked; same payload). The team.member_removed row
    // below still lists them together. Best-effort: the keys are already revoked.
    const revokedAtIso = removed.revokedAt.toISOString();
    for (const key of removed.revokedApiKeys) {
      if (this.webhooks) {
        try {
          await this.webhooks.enqueueEvent(input.ownerAccountId, 'api_key.revoked', {
            api_key_id: `key_${key.id}`,
            name: key.name,
            revoked_at: revokedAtIso,
          });
        } catch (err) {
          // Best-effort — the keys are revoked either way — but never silent.
          logLostWebhookEvent(this.logger, {
            component: 'team-members',
            accountId: input.ownerAccountId,
            eventType: 'api_key.revoked',
            err,
            context: { api_key_id: key.id, membership_id: input.membershipId },
          });
        }
      }
      if (this.accountAudit) {
        try {
          await this.accountAudit.record({
            accountId: input.ownerAccountId,
            actorType: 'customer',
            actorAccountId: input.ownerAccountId,
            actorKeyId: null,
            action: 'api_key.revoked',
            targetResourceId: `key_${key.id}`,
            payload: { name: key.name, revoked_at: revokedAtIso },
          });
        } catch {
          /* swallow */
        }
      }
    }
    if (this.accountAudit) {
      try {
        await this.accountAudit.record({
          accountId: input.ownerAccountId,
          actorType: 'customer',
          actorAccountId: input.ownerAccountId,
          actorKeyId: null,
          action: 'team.member_removed',
          targetResourceId: `mem_${input.membershipId}`,
          // V-726 — record WHICH credentials the removal revoked. An offboarding
          // that silently invalidates keys the owner's systems were using needs
          // to be answerable afterwards from the audit log alone.
          payload: { revoked_api_key_ids: removed.revokedApiKeyIds },
        });
      } catch {
        /* swallow */
      }
    }
    return true;
  }
}
