// W407.B — drift guard for apps/server/src/services/team-members.ts.
// V-298b Team RBAC v1: owner-account + N member-accounts via
// team_members table; invite flow with 7-day token + email-match
// invariant on accept. Drift here either breaks the email-match
// (URL-share attack: invitee A shares link with B who accepts) or
// scrambles V-326b auth-cache invalidation (membership lag past
// 30s TTL).
//
//   • V-298b framing pinned: team model, separate auth path
//     integration in V-298c, service is pure (no auth-cache writes
//     beyond invalidation, no scope checks beyond route layer).
//   • TEAM_INVITE_TTL_MS = 7 days.
//   • Invite flow framing: 3-step (invite → signup-verify-invitee
//     → accept).
//   • Idempotency framing: re-invite = fresh token (old invalid);
//     re-accept = unique-keyed team_members row (no error).
//   • TeamRole 2-literal union (member | admin).
//   • TeamMemberRow: 9 fields; TeamInviteRow: 9 fields with
//     acceptedAt nullable.
//   • V-326b authCache.invalidateAccount on accept + removeMember
//     (so cached AccountContext rebuilds teams[]); best-effort
//     swallow (stale → safe default "no team grants" + 30s TTL
//     self-heals).
//   • invite: normalize email lowercase + @-check; BadRequestError
//     on invalid; default role = 'member'.
//   • accept: token-hash lookup; expired → BadRequestError; email
//     mismatch → ConflictError (URL-share defence); idempotent
//     row + markInviteAccepted.
//   • listPendingInvites: filters acceptedAt===null AND
//     inviteExpiresAt >= now.
//   • V-298f account-audit: 3-action union (team.member_invited /
//     invite_accepted / member_removed) try/catch swallow.
//   • dashboardBaseUrl trailing-slash stripped at construction.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/team-members.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W407.B apps/server/src/services/team-members.ts content parity', () => {
  const body = read(LIB);

  it('V-298b framing pinned: team model + V-298c auth path integration deferred + service is pure', () => {
    expect(body).toMatch(/V-298b — Team RBAC v1 service\./);
    expect(body).toMatch(
      /Models a "team" as one owner-account \+ N member-accounts joined via\s*\n?\s*\/\/\s*the team_members table\. Each member is itself a regular `accounts`\s*\n?\s*\/\/\s*row \(their own login \+ email\); team membership is a separate\s*\n?\s*\/\/\s*relationship\./,
    );
    expect(body).toMatch(
      /The auth path integration lives in V-298c — for\s*\n?\s*\/\/\s*V-298b, the service is pure \(no auth-cache writes, no scope checks\s*\n?\s*\/\/\s*beyond what the route layer enforces at construction-time\)\./,
    );
  });

  it('Invite flow framing pinned: 3-step + 7-day token + email-match invariant', () => {
    expect(body).toMatch(
      /1\. Owner \(or admin team member\) calls invite\(inviterId, email, role\)\.\s*\n?\s*\/\/\s*Service generates a 7-day token \+ emails the invitee\./,
    );
    expect(body).toMatch(
      /3\. Invitee clicks the accept link\. Service looks up the invite by\s*\n?\s*\/\/\s*token-hash, asserts the invitee's account email matches, writes\s*\n?\s*\/\/\s*the team_members row, marks the invite accepted\./,
    );
  });

  it('Idempotency framing pinned: re-invite refreshes token; re-accept is no-op via unique-keyed (owner+member)', () => {
    expect(body).toMatch(
      /Re-inviting the same email = the existing pending invite gets a\s*\n?\s*\/\/\s*fresh token \(old token invalidated\)\. No duplicate row\./,
    );
    expect(body).toMatch(
      /Re-accepting = the team_members row is unique-keyed \(owner \+\s*\n?\s*\/\/\s*member\); the second accept finds the row already there and\s*\n?\s*\/\/\s*returns the existing membership without error\./,
    );
  });

  it('TEAM_INVITE_TTL_MS = 7 days; TeamRole 2-literal union (member|admin)', () => {
    expect(body).toMatch(
      /export const TEAM_INVITE_TTL_MS = 7 \* 24 \* 60 \* 60 \* 1000; \/\/ 7 days/,
    );
    expect(body).toMatch(/export type TeamRole = 'member' \| 'admin';/);
  });

  it('TeamMemberRow: 9 fields (id/ownerAccountId/memberAccountId/memberEmail/role/invitedAt/acceptedAt/invitedByAccountId nullable/createdAt)', () => {
    expect(body).toMatch(/export interface TeamMemberRow \{/);
    expect(body).toMatch(/ownerAccountId: string;/);
    expect(body).toMatch(/memberAccountId: string;/);
    expect(body).toMatch(/memberEmail: string;/);
    expect(body).toMatch(/role: TeamRole;/);
    expect(body).toMatch(/invitedAt: Date;/);
    expect(body).toMatch(/acceptedAt: Date;/);
    expect(body).toMatch(/invitedByAccountId: string \| null;/);
  });

  it('TeamInviteRow: 9 fields with acceptedAt nullable + inviteTokenHash + inviteExpiresAt + inviteeEmail', () => {
    expect(body).toMatch(/export interface TeamInviteRow \{/);
    expect(body).toMatch(/inviteeEmail: string;/);
    expect(body).toMatch(/inviteTokenHash: string;/);
    expect(body).toMatch(/inviteExpiresAt: Date;/);
    expect(body).toMatch(/acceptedAt: Date \| null;/);
  });

  it('V-326b authCache.invalidateAccount: best-effort framing + 30s TTL self-heal', () => {
    expect(body).toMatch(
      /V-326b — optional auth cache\. When wired, accept \/ removeMember\s*\n?\s*\*\s*bump the affected member account's auth version so cached\s*\n?\s*\*\s*AccountContext entries miss on the next request and rebuild\s*\n?\s*\*\s*with the updated teams\[\]\. Without it, membership changes only\s*\n?\s*\*\s*take effect after the 30s cache TTL elapses\./,
    );
    expect(body).toMatch(
      /V-326b — best-effort cache invalidation\. Failures swallowed:\s*\n?\s*\*\s*stale teams\[\] degrades to "no team grants" \(safe default\), and\s*\n?\s*\*\s*the next 30s TTL expiry self-heals\./,
    );
    expect(body).toMatch(
      /private async invalidateAuthCache\(memberAccountId: string\): Promise<void> \{\s*\n?\s*if \(!this\.authCache\) return;\s*\n?\s*try \{\s*\n?\s*await this\.authCache\.invalidateAccount\(memberAccountId\);\s*\n?\s*\} catch \{\s*\n?\s*\/\* swallow \*\//,
    );
  });

  it("invite: normalize email lowercase + @-check → BadRequestError; default role='member'; generateAuthToken + 7-day TTL + sendTeamInvite + team.member_invited audit", () => {
    expect(body).toMatch(/const normalized = input\.inviteeEmail\.trim\(\)\.toLowerCase\(\);/);
    expect(body).toMatch(
      /if \(!normalized \|\| !normalized\.includes\('@'\)\) \{\s*\n?\s*throw new BadRequestError\('Invalid invitee email\.'\);/,
    );
    expect(body).toMatch(/const role: TeamRole = input\.role \?\? 'member';/);
    expect(body).toMatch(
      /const inviteExpiresAt = new Date\(Date\.now\(\) \+ TEAM_INVITE_TTL_MS\);/,
    );
    expect(body).toMatch(
      /const acceptLink = `\$\{this\.dashboardBaseUrl\}\/team\/accept\?token=\$\{encodeURIComponent\(plaintext\)\}`;/,
    );
    expect(body).toMatch(
      /action: 'team\.member_invited',\s*\n?\s*targetResourceId: null,\s*\n?\s*payload: \{ invitee_email: normalized, role \},/,
    );
  });

  it('accept: token-hash lookup → NotFoundError if missing; expired → BadRequestError; email mismatch → ConflictError (URL-share defence); idempotent upsertMembership + markInviteAccepted + invalidateAuthCache', () => {
    expect(body).toMatch(
      /The accepting account's email MUST match\s*\n?\s*\*\s*the invite's invitee email — prevents accidentally accepting an\s*\n?\s*\*\s*invite addressed to someone else even if they shared the URL\./,
    );
    expect(body).toMatch(
      /if \(!invite\) \{\s*\n?\s*throw new NotFoundError\('Invite not found or already used\.'\);/,
    );
    expect(body).toMatch(
      /if \(invite\.inviteExpiresAt < new Date\(\)\) \{\s*\n?\s*throw new BadRequestError\('Invite has expired\. Ask the team to send a fresh invite\.'\);/,
    );
    expect(body).toMatch(
      /if \(acceptingEmail\.trim\(\)\.toLowerCase\(\) !== invite\.inviteeEmail\) \{\s*\n?\s*throw new ConflictError\(\s*\n?\s*'The signed-in account does not match the invitee email\. Sign in with the address the invite was sent to, or ask for a fresh invite\.',/,
    );
    expect(body).toMatch(/await this\.invalidateAuthCache\(input\.acceptingAccountId\);/);
    expect(body).toMatch(
      /action: 'team\.invite_accepted',\s*\n?\s*targetResourceId: `mem_\$\{membership\.id\}`,/,
    );
  });

  it('listPendingInvites: filter acceptedAt===null AND inviteExpiresAt >= now', () => {
    expect(body).toMatch(
      /return all\.filter\(\(inv\) => inv\.acceptedAt === null && inv\.inviteExpiresAt >= now\);/,
    );
  });

  it('removeMember: returns false when removeMember repo returns null (membership not-found / wrong-owner); on success: invalidateAuthCache + team.member_removed audit', () => {
    expect(body).toMatch(
      /\/\*\*\s*\n?\s*\*\s*Remove a member by membership id\. Returns the removed member's\s*\n?\s*\*\s*account id when the row was found \+ deleted \(so the caller can\s*\n?\s*\*\s*invalidate that member's auth cache\); null when the row was not\s*\n?\s*\*\s*found or owned by a different account\./,
    );
    // Removal atomically drops the membership AND cancels the member's
    // OUTSTANDING invites in one transaction (TOCTOU fix 2026-07-10; also
    // stops the re-join-via-pending-invite path from the Fable auth re-audit
    // 2026-07-02). removeMemberWithInvites is the single atomic call — a
    // just-removed member can't resurrect their seat via an accept-in-flight.
    expect(body).toMatch(
      /async removeMember\(input: \{ membershipId: string; ownerAccountId: string \}\): Promise<boolean> \{[\s\S]+?const removedMemberAccountId = await this\.repo\.removeMemberWithInvites\(\s*\n?\s*input\.membershipId,\s*\n?\s*input\.ownerAccountId,\s*\n?\s*\);[\s\S]+?if \(removedMemberAccountId === null\) return false;[\s\S]+?await this\.invalidateAuthCache\(removedMemberAccountId\);/,
    );
    expect(body).toMatch(
      /action: 'team\.member_removed',\s*\n?\s*targetResourceId: `mem_\$\{input\.membershipId\}`,/,
    );
  });

  it('TeamMembersRepo: 8-method interface (upsertInvite / findInviteByTokenHash / findAccountEmail / upsertMembership / markInviteAccepted / listMembers / listPendingInvites / removeMember returning accountId|null / deleteInvitesForEmail)', () => {
    expect(body).toMatch(/export interface TeamMembersRepo \{/);
    expect(body).toMatch(
      /deleteInvitesForEmail\(ownerAccountId: string, email: string\): Promise<void>;/,
    );
    expect(body).toMatch(/upsertInvite\(input: \{/);
    expect(body).toMatch(/findInviteByTokenHash\(hash: string\): Promise<TeamInviteRow \| null>;/);
    expect(body).toMatch(/findAccountEmail\(accountId: string\): Promise<string \| null>;/);
    expect(body).toMatch(/upsertMembership\(input: \{/);
    expect(body).toMatch(/markInviteAccepted\(inviteId: string, at: Date\): Promise<void>;/);
    expect(body).toMatch(/listMembers\(ownerAccountId: string\): Promise<TeamMemberRow\[\]>;/);
    expect(body).toMatch(
      /listPendingInvites\(ownerAccountId: string\): Promise<TeamInviteRow\[\]>;/,
    );
    expect(body).toMatch(
      /removeMember\(membershipId: string, ownerAccountId: string\): Promise<string \| null>;/,
    );
  });

  it('Constructor: dashboardBaseUrl trailing-slash stripped at construction', () => {
    expect(body).toMatch(
      /this\.dashboardBaseUrl = config\.dashboardBaseUrl\.replace\(\/\\\/\+\$\/, ''\);/,
    );
  });

  it('imports: generateAuthToken + tokenHash + BadRequest/Conflict/NotFound errors + AccountAuditService + AuthCache + EmailService types', () => {
    expect(body).toMatch(
      /import \{ generateAuthToken, tokenHash \} from '\.\.\/lib\/auth-tokens\.js';/,
    );
    expect(body).toMatch(
      /import \{ BadRequestError, ConflictError, NotFoundError \} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(/import type \{ AccountAuditService \} from '\.\/account-audit\.js';/);
    expect(body).toMatch(/import type \{ AuthCache \} from '\.\/auth-cache\.js';/);
    expect(body).toMatch(/import type \{ EmailService \} from '\.\/email\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
