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

  it('imports: and/desc/eq/isNull from drizzle-orm; 4 service types (TeamInviteRow + TeamMemberRow + TeamMembersRepo + TeamRole); Database; 3 schema tables (accounts + teamInvites + teamMembers)', () => {
    expect(body).toMatch(/import \{ and, desc, eq, isNull \} from 'drizzle-orm';/);
    expect(body).toMatch(
      /import type \{\s*\n?\s*TeamInviteRow,\s*\n?\s*TeamMemberRow,\s*\n?\s*TeamMembersRepo,\s*\n?\s*TeamRole,\s*\n?\s*\} from '\.\.\/services\/team-members\.js';/,
    );
    expect(body).toMatch(/import \{ accounts, teamInvites, teamMembers \} from '\.\/schema\.js';/);
  });

  it('toInviteRow: 9-field TeamInviteRow (id + ownerAccountId + inviteeEmail + role + inviteTokenHash + inviteExpiresAt + invitedByAccountId + acceptedAt + createdAt)', () => {
    expect(body).toMatch(
      /function toInviteRow\(row: InviteDb\): TeamInviteRow \{\s*\n?\s*return \{\s*\n?\s*id: row\.id,\s*\n?\s*ownerAccountId: row\.ownerAccountId,\s*\n?\s*inviteeEmail: row\.inviteeEmail,\s*\n?\s*role: row\.role,\s*\n?\s*inviteTokenHash: row\.inviteTokenHash,\s*\n?\s*inviteExpiresAt: row\.inviteExpiresAt,\s*\n?\s*invitedByAccountId: row\.invitedByAccountId,\s*\n?\s*acceptedAt: row\.acceptedAt,\s*\n?\s*createdAt: row\.createdAt,\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('upsertInvite framing pins the partial unique authority and one-statement serialization point', () => {
    expect(body).toMatch(
      /\/\/ The partial unique index permits accepted history while making the live\s*\n?\s*\/\/ \(owner, email\) authority singular\. One INSERT \.\.\. ON CONFLICT statement\s*\n?\s*\/\/ is the serialization point: concurrent mixed-role refreshes cannot both\s*\n?\s*\/\/ leave consumable credentials behind\./,
    );
  });

  it("upsertInvite: one 6-field INSERT + partial-key onConflictDoUpdate refreshes 4 authority fields and throws 'team_invites upsert returned no row'", () => {
    expect(body).toMatch(
      /\.insert\(teamInvites\)\s*\n?\s*\.values\(\{\s*\n?\s*ownerAccountId: input\.ownerAccountId,\s*\n?\s*inviteeEmail: input\.inviteeEmail,\s*\n?\s*role: input\.role,\s*\n?\s*inviteTokenHash: input\.inviteTokenHash,\s*\n?\s*inviteExpiresAt: input\.inviteExpiresAt,\s*\n?\s*invitedByAccountId: input\.invitedByAccountId,\s*\n?\s*\}\)/,
    );
    expect(body).toMatch(
      /\.onConflictDoUpdate\(\{\s*\n?\s*target: \[teamInvites\.ownerAccountId, teamInvites\.inviteeEmail\],\s*\n?\s*targetWhere: isNull\(teamInvites\.acceptedAt\),\s*\n?\s*set: \{\s*\n?\s*inviteTokenHash: input\.inviteTokenHash,\s*\n?\s*inviteExpiresAt: input\.inviteExpiresAt,\s*\n?\s*role: input\.role,\s*\n?\s*invitedByAccountId: input\.invitedByAccountId,\s*\n?\s*\},\s*\n?\s*\}\)\s*\n?\s*\.returning\(\);/,
    );
    expect(body).toMatch(/if \(!row\) throw new Error\('team_invites upsert returned no row'\);/);
  });

  it('findInviteByTokenHash is SINGLE-USE (isNull(acceptedAt) filter) + findAccountEmail: limit 1 lookups; findAccountEmail returns row?.email ?? null', () => {
    // Single-use guard (Fable auth re-audit 2026-07-02): an accepted invite
    // token must never be returned, so a used token can't be replayed to
    // re-join a team / re-escalate a role.
    expect(body).toMatch(
      /async findInviteByTokenHash\(hash: string\): Promise<TeamInviteRow \| null> \{[\s\S]*?\.where\(and\(eq\(teamInvites\.inviteTokenHash, hash\), isNull\(teamInvites\.acceptedAt\)\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*return row \? toInviteRow\(row\) : null;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /async findAccountEmail\(accountId: string\): Promise<string \| null> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.select\(\{ email: accounts\.email \}\)\s*\n?\s*\.from\(accounts\)\s*\n?\s*\.where\(eq\(accounts\.id, accountId\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*return row\?\.email \?\? null;\s*\n?\s*\}/,
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
      /\.onConflictDoUpdate\(\{\s*\n?\s*target: \[teamMembers\.ownerAccountId, teamMembers\.memberAccountId\],\s*\n?\s*set: \{\s*\n?\s*role: input\.role,\s*\n?\s*invitedAt: input\.invitedAt,\s*\n?\s*invitedByAccountId: input\.invitedByAccountId,\s*\n?\s*\},\s*\n?\s*\}\)\s*\n?\s*\.returning\(\);/,
    );
    // acceptedAt is intentionally NOT in the SET clause (stays "member since").
    expect(body).not.toMatch(/set: \{[\s\S]{0,200}acceptedAt: input\.acceptedAt/);
    expect(body).toMatch(/if \(!row\) throw new Error\('team_members upsert produced no row'\);/);
  });

  it('markInviteAccepted: 1-field set acceptedAt where id=inviteId', () => {
    expect(body).toMatch(
      /async markInviteAccepted\(inviteId: string, at: Date\): Promise<void> \{\s*\n?\s*await this\.database\.db\s*\n?\s*\.update\(teamInvites\)\s*\n?\s*\.set\(\{ acceptedAt: at \}\)\s*\n?\s*\.where\(eq\(teamInvites\.id, inviteId\)\);\s*\n?\s*\}/,
    );
  });

  it('listMembers framing pinned: innerJoin accounts on memberAccountId to surface memberEmail at list-time; orderBy desc(createdAt)', () => {
    expect(body).toMatch(
      /\/\/ Join accounts to surface member email at list-time\. The shape\s*\n?\s*\/\/ matches in-memory repo's TeamMemberRow with memberEmail filled\./,
    );
    expect(body).toMatch(
      /\.innerJoin\(accounts, eq\(accounts\.id, teamMembers\.memberAccountId\)\)\s*\n?\s*\.where\(eq\(teamMembers\.ownerAccountId, ownerAccountId\)\)\s*\n?\s*\.orderBy\(desc\(teamMembers\.createdAt\)\);/,
    );
  });

  it('listPendingInvites: where and(ownerAccountId, isNull(acceptedAt)) + orderBy desc(createdAt)', () => {
    expect(body).toMatch(
      /async listPendingInvites\(ownerAccountId: string\): Promise<TeamInviteRow\[\]> \{\s*\n?\s*const rows = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(teamInvites\)\s*\n?\s*\.where\(and\(eq\(teamInvites\.ownerAccountId, ownerAccountId\), isNull\(teamInvites\.acceptedAt\)\)\)\s*\n?\s*\.orderBy\(desc\(teamInvites\.createdAt\)\);/,
    );
  });

  it('removeMember: delete where and(id=membershipId, ownerAccountId) + returning {memberAccountId}; returns result[0]?.memberAccountId ?? null on success, null on no-row', () => {
    expect(body).toMatch(
      /async removeMember\(membershipId: string, ownerAccountId: string\): Promise<string \| null> \{\s*\n?\s*const result = await this\.database\.db\s*\n?\s*\.delete\(teamMembers\)\s*\n?\s*\.where\(and\(eq\(teamMembers\.id, membershipId\), eq\(teamMembers\.ownerAccountId, ownerAccountId\)\)\)\s*\n?\s*\.returning\(\{ memberAccountId: teamMembers\.memberAccountId \}\);\s*\n?\s*return result\.length > 0 \? \(result\[0\]\?\.memberAccountId \?\? null\) : null;\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
