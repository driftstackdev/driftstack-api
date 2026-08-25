// W448.C — drift guard for apps/server/src/db/team-members-repo.ts.
// V-298c DrizzleTeamMembersRepo. Drift here either drops the
// atomic pending-invite upsert (a read-then-write sequence permits
// concurrent re-invites to create conflicting live role credentials)
// or breaks the
// onConflictDoUpdate on upsertMembership (2026-06-30, audit
// w76s5l9nb — re-accepting same invite must idempotently UPDATE the
// role, not just return the stale pre-existing row, or a role
// demotion via re-invite silently no-ops).
//
//   • V-298c framing pinned.
//   • toInviteRow: 9-field TeamInviteRow.
//   • upsertInvite: one INSERT … onConflictDoUpdate against the
//     partial unique (ownerAccountId, inviteeEmail) pending key;
//     refresh token+expiry+role+invitedByAccountId on conflict.
//   • findInviteByTokenHash + findAccountEmail: limit 1 lookups.
//   • upsertMembership: INSERT … onConflictDoUpdate on (owner,
//     member) composite, SET role/invitedAt/invitedByAccountId so a
//     re-accept actually applies a changed role (acceptedAt excluded
//     from SET — "member since" is preserved).
//   • markInviteAccepted: 1-field set acceptedAt where id=inviteId.
//   • listMembers: innerJoin accounts on member.memberAccountId =
//     accounts.id → memberEmail surface at list-time; orderBy
//     desc(createdAt).
//   • listPendingInvites: where and(ownerAccountId, isNull(acceptedAt))
//     + orderBy desc(createdAt).
//   • removeMember: delete where and(id=membershipId, ownerAccountId);
//     returns memberAccountId or null.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/team-members-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W448.C apps/server/src/db/team-members-repo.ts content parity', () => {
  const body = read(LIB);

  it("V-298c framing pinned: 'Drizzle-backed TeamMembersRepo.'", () => {
    expect(body).toMatch(/\/\/ V-298c — Drizzle-backed TeamMembersRepo\./);
  });

  // V-726 — apiKeys joins the schema imports and RemoveMemberResult the service
  // types: removeMemberWithInvites now revokes, in its own transaction, the keys
  // the departing member minted on the owner.
  it('imports: and/desc/eq/isNull from drizzle-orm; 5 service types (RemoveMemberResult + TeamInviteRow + TeamMemberRow + TeamMembersRepo + TeamRole); Database; 4 schema tables (accounts + apiKeys + teamInvites + teamMembers)', () => {
    expect(body).toMatch(/import \{ and, desc, eq, isNull \} from 'drizzle-orm';/);
    expect(body).toMatch(
      /import type \{\s*RemoveMemberResult,\s*TeamInviteRow,\s*TeamMemberRow,\s*TeamMembersRepo,\s*TeamRole,\s*\} from '\.\.\/services\/team-members\.js';/,
    );
    expect(body).toMatch(
      /import \{ accounts, apiKeys, teamInvites, teamMembers \} from '\.\/schema\.js';/,
    );
  });

  // The revocation itself. Its predicate is the whole security property: the
  // owner's account, keys attributed to THIS member, and only ones still live.
  // Losing the createdByAccountId term would revoke every key on the owner.
  it('V-726 removeMemberWithInvites revokes the departing member keys inside the same transaction', () => {
    expect(body).toMatch(
      /const revoked = await tx\s*\.update\(apiKeys\)\s*\.set\(\{ revokedAt: now \}\)\s*\.where\(\s*and\(\s*eq\(apiKeys\.accountId, ownerAccountId\),\s*eq\(apiKeys\.createdByAccountId, memberAccountId\),\s*isNull\(apiKeys\.revokedAt\),\s*\),\s*\)/,
    );
    expect(body).toMatch(
      /return \{ memberAccountId, revokedApiKeyIds: revoked\.map\(\(r\) => r\.id\) \};/,
    );
  });

  it('toInviteRow: 9-field TeamInviteRow (id + ownerAccountId + inviteeEmail + role + inviteTokenHash + inviteExpiresAt + invitedByAccountId + acceptedAt + createdAt)', () => {
    expect(body).toMatch(
      /function toInviteRow\(row: InviteDb\): TeamInviteRow \{\s*return \{\s*id: row\.id,\s*ownerAccountId: row\.ownerAccountId,\s*inviteeEmail: row\.inviteeEmail,\s*role: row\.role,\s*inviteTokenHash: row\.inviteTokenHash,\s*inviteExpiresAt: row\.inviteExpiresAt,\s*invitedByAccountId: row\.invitedByAccountId,\s*acceptedAt: row\.acceptedAt,\s*createdAt: row\.createdAt,\s*\};\s*\}/,
    );
  });

  it('upsertInvite framing pins the partial unique authority and one-statement serialization point', () => {
    expect(body).toMatch(
      /\/\/ The partial unique index permits accepted history while making the live\s*\/\/ \(owner, email\) authority singular\. One INSERT \.\.\. ON CONFLICT statement\s*\/\/ is the serialization point: concurrent mixed-role refreshes cannot both\s*\/\/ leave consumable credentials behind\./,
    );
  });

  it("upsertInvite: one 6-field INSERT + partial-key onConflictDoUpdate refreshes 4 authority fields and throws 'team_invites upsert returned no row'", () => {
    expect(body).toMatch(
      /\.insert\(teamInvites\)\s*\.values\(\{\s*ownerAccountId: input\.ownerAccountId,\s*inviteeEmail: input\.inviteeEmail,\s*role: input\.role,\s*inviteTokenHash: input\.inviteTokenHash,\s*inviteExpiresAt: input\.inviteExpiresAt,\s*invitedByAccountId: input\.invitedByAccountId,\s*\}\)/,
    );
    expect(body).toMatch(
      /\.onConflictDoUpdate\(\{\s*target: \[teamInvites\.ownerAccountId, teamInvites\.inviteeEmail\],\s*targetWhere: isNull\(teamInvites\.acceptedAt\),\s*set: \{\s*inviteTokenHash: input\.inviteTokenHash,\s*inviteExpiresAt: input\.inviteExpiresAt,\s*role: input\.role,\s*invitedByAccountId: input\.invitedByAccountId,\s*\},\s*\}\)\s*\.returning\(\);/,
    );
    expect(body).toMatch(/if \(!row\) throw new Error\('team_invites upsert returned no row'\);/);
  });

  it('findInviteByTokenHash is SINGLE-USE (isNull(acceptedAt) filter) + findAccountEmail: limit 1 lookups; findAccountEmail returns row?.email ?? null', () => {
    // Single-use guard (Fable auth re-audit 2026-07-02): an accepted invite
    // token must never be returned, so a used token can't be replayed to
    // re-join a team / re-escalate a role.
    expect(body).toMatch(
      /async findInviteByTokenHash\(hash: string\): Promise<TeamInviteRow \| null> \{[\s\S]*?\.where\(and\(eq\(teamInvites\.inviteTokenHash, hash\), isNull\(teamInvites\.acceptedAt\)\)\)\s*\.limit\(1\);\s*return row \? toInviteRow\(row\) : null;\s*\}/,
    );
    expect(body).toMatch(
      /async findAccountEmail\(accountId: string\): Promise<string \| null> \{\s*const \[row\] = await this\.database\.db\s*\.select\(\{ email: accounts\.email \}\)\s*\.from\(accounts\)\s*\.where\(eq\(accounts\.id, accountId\)\)\s*\.limit\(1\);\s*return row\?\.email \?\? null;\s*\}/,
    );
  });

  it("upsertMembership: INSERT 6-field values + onConflictDoUpdate target=[ownerAccountId, memberAccountId] composite, SET role/invitedAt/invitedByAccountId (acceptedAt excluded — preserves 'member since'); .returning() always yields a row; throws 'team_members upsert produced no row'", () => {
    // 2026-06-30 (audit w76s5l9nb, security) — was onConflictDoNothing + a
    // SELECT-fallback that silently discarded the new role on a re-accept, so
    // an owner demoting an 'admin' team member to 'member' via re-invite
    // silently no-op'd (the member kept full admin write access —
    // effectiveAccountIdForWrite gates real elevated access on this exact
    // column). DO UPDATE actually applies the new role on conflict.
    expect(body).toMatch(
      /\.onConflictDoUpdate\(\{\s*target: \[teamMembers\.ownerAccountId, teamMembers\.memberAccountId\],\s*set: \{\s*role: input\.role,\s*invitedAt: input\.invitedAt,\s*invitedByAccountId: input\.invitedByAccountId,\s*\},\s*\}\)\s*\.returning\(\);/,
    );
    // acceptedAt is intentionally NOT in the SET clause (stays "member since").
    expect(body).not.toMatch(/set: \{[\s\S]{0,200}acceptedAt: input\.acceptedAt/);
    expect(body).toMatch(/if \(!row\) throw new Error\('team_members upsert produced no row'\);/);
  });

  it('acceptInviteAtomic: consumes exact id+token hash while pending, then sources membership authority from the consumed row', () => {
    expect(body).toMatch(
      /eq\(teamInvites\.id, input\.inviteId\),\s*eq\(teamInvites\.inviteTokenHash, input\.inviteTokenHash\),\s*isNull\(teamInvites\.acceptedAt\),/,
    );
    expect(body).toMatch(/if \(!consumed\) return null;/);
    expect(body).toMatch(/ownerAccountId: consumed\.ownerAccountId,/);
    expect(body).toMatch(/role: consumed\.role,/);
    expect(body).toMatch(/invitedAt: consumed\.createdAt,/);
    expect(body).toMatch(/invitedByAccountId: consumed\.invitedByAccountId,/);
  });

  it('markInviteAccepted: 1-field set acceptedAt where id=inviteId', () => {
    expect(body).toMatch(
      /async markInviteAccepted\(inviteId: string, at: Date\): Promise<void> \{\s*await this\.database\.db\s*\.update\(teamInvites\)\s*\.set\(\{ acceptedAt: at \}\)\s*\.where\(eq\(teamInvites\.id, inviteId\)\);\s*\}/,
    );
  });

  it('listMembers framing pinned: innerJoin accounts on memberAccountId to surface memberEmail at list-time; orderBy desc(createdAt)', () => {
    expect(body).toMatch(
      /\/\/ Join accounts to surface member email at list-time\. The shape\s*\/\/ matches in-memory repo's TeamMemberRow with memberEmail filled\./,
    );
    expect(body).toMatch(
      /\.innerJoin\(accounts, eq\(accounts\.id, teamMembers\.memberAccountId\)\)\s*\.where\(eq\(teamMembers\.ownerAccountId, ownerAccountId\)\)\s*\.orderBy\(desc\(teamMembers\.createdAt\)\);/,
    );
  });

  it('listPendingInvites: where and(ownerAccountId, isNull(acceptedAt)) + orderBy desc(createdAt)', () => {
    expect(body).toMatch(
      /async listPendingInvites\(ownerAccountId: string\): Promise<TeamInviteRow\[\]> \{\s*const rows = await this\.database\.db\s*\.select\(\)\s*\.from\(teamInvites\)\s*\.where\(and\(eq\(teamInvites\.ownerAccountId, ownerAccountId\), isNull\(teamInvites\.acceptedAt\)\)\)\s*\.orderBy\(desc\(teamInvites\.createdAt\)\);/,
    );
  });

  it('removeMember: delete where and(id=membershipId, ownerAccountId) + returning {memberAccountId}; returns result[0]?.memberAccountId ?? null on success, null on no-row', () => {
    expect(body).toMatch(
      /async removeMember\(membershipId: string, ownerAccountId: string\): Promise<string \| null> \{\s*const result = await this\.database\.db\s*\.delete\(teamMembers\)\s*\.where\(and\(eq\(teamMembers\.id, membershipId\), eq\(teamMembers\.ownerAccountId, ownerAccountId\)\)\)\s*\.returning\(\{ memberAccountId: teamMembers\.memberAccountId \}\);\s*return result\.length > 0 \? \(result\[0\]\?\.memberAccountId \?\? null\) : null;\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
