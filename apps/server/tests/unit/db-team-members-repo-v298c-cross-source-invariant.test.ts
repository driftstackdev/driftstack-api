// W1000 — db/team-members-repo V-298c cross-source invariant. Three-
// hundred-twenty-sixth in the drift-guard series. Milestone wave.
// Pins the apps/server/src/db/team-members-repo.ts Drizzle team-
// members repo primitive:
//
//   V-298c anchor — 'V-298c — Drizzle-backed TeamMembersRepo'.
//
//   DrizzleTeamMembersRepo 7-method surface — upsertInvite +
//     findInviteByTokenHash + findAccountEmail + upsertMembership +
//     markInviteAccepted + listMembers + listPendingInvites +
//     removeMember.
//
//   upsertInvite framing — the partial unique pending key is the live
//   authority and one INSERT ... ON CONFLICT is its serialization point.
//
//   upsertInvite conflict target — (ownerAccountId, inviteeEmail)
//   WHERE acceptedAt IS NULL, matching the schema's partial index.
//
//   upsertInvite refresh sets 4 fields — inviteTokenHash +
//   inviteExpiresAt + role + invitedByAccountId.
//
//   acceptInviteAtomic exact-token CAS — id + inviteTokenHash +
//   acceptedAt IS NULL; authority sourced from the consumed row.
//
//   upsertMembership framing — 'Use ON CONFLICT (owner, member) DO
//   NOTHING via INSERT ... .returning() — falls through to a SELECT
//   on conflict so we always return a TeamMemberRow'.
//
//   upsertMembership onConflictDoNothing target — [ownerAccountId,
//   memberAccountId] compound key.
//
//   upsertMembership conflict-fallthrough SELECT to retrieve existing
//   row.
//
//   listMembers innerJoin accounts on memberAccountId + 9-field
//   projection (includes memberEmail from accounts.email).
//
//   listPendingInvites filter — and(eq(ownerAccountId), isNull
//   (acceptedAt)) + orderBy desc(createdAt).
//
//   removeMember scoped delete — and(eq(id), eq(ownerAccountId)) +
//   returning({memberAccountId}) so V-326 auth-cache invalidation
//   has the freed memberId.
//
//   markInviteAccepted single-field UPDATE — acceptedAt only.
//
//   toInviteRow 9-field mapper + attachMemberEmail helper +
//   memberEmail is caller-supplied (not from DB) on upsertMembership.
//
// stays in lockstep across apps/server/src/db/team-members-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1000 db/team-members-repo V-298c cross-source invariant', () => {
  // ─── V-298c anchor ───────────────────────────────────────────

  it("CRITICAL apps/server/src/db/team-members-repo.ts header pins V-298c — 'V-298c — Drizzle-backed TeamMembersRepo'. The V-298c anchor is the team-members-repo provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/team-members-repo.ts'));
    expect(p).toMatch(/\/\/ V-298c — Drizzle-backed TeamMembersRepo\./);
    expect(p).toMatch(/export class DrizzleTeamMembersRepo implements TeamMembersRepo \{/);
  });

  // ─── 8-method surface ────────────────────────────────────────

  it('CRITICAL 8-method surface — upsertInvite + findInviteByTokenHash + findAccountEmail + upsertMembership + markInviteAccepted + listMembers + listPendingInvites + removeMember. The 8-method TeamMembersRepo covers V-298c invite + membership lifecycle.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/team-members-repo.ts'));
    expect(p).toMatch(/async upsertInvite\(input: \{/);
    expect(p).toMatch(
      /async findInviteByTokenHash\(hash: string\): Promise<TeamInviteRow \| null> \{/,
    );
    expect(p).toMatch(/async findAccountEmail\(accountId: string\): Promise<string \| null> \{/);
    expect(p).toMatch(/async upsertMembership\(input: \{/);
    expect(p).toMatch(/async markInviteAccepted\(inviteId: string, at: Date\): Promise<void> \{/);
    expect(p).toMatch(/async listMembers\(ownerAccountId: string\): Promise<TeamMemberRow\[\]> \{/);
    expect(p).toMatch(
      /async listPendingInvites\(ownerAccountId: string\): Promise<TeamInviteRow\[\]> \{/,
    );
    expect(p).toMatch(
      /async removeMember\(membershipId: string, ownerAccountId: string\): Promise<string \| null> \{/,
    );
  });

  // ─── upsertInvite framing ────────────────────────────────────

  it('CRITICAL upsertInvite framing — partial unique live authority plus one-statement serialization prevents conflicting concurrent role credentials.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/team-members-repo.ts'));
    expect(p).toMatch(
      /\/\/ The partial unique index permits accepted history while making the live/,
    );
    expect(p).toMatch(
      /\/\/ \(owner, email\) authority singular\. One INSERT \.\.\. ON CONFLICT statement/,
    );
    expect(p).toMatch(
      /\/\/ is the serialization point: concurrent mixed-role refreshes cannot both/,
    );
  });

  it('CRITICAL upsertInvite conflict target — composite owner/email plus acceptedAt IS NULL partial predicate matches the singular pending authority index.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/team-members-repo.ts'));
    expect(p).toMatch(/target: \[teamInvites\.ownerAccountId, teamInvites\.inviteeEmail\],/);
    expect(p).toMatch(/targetWhere: isNull\(teamInvites\.acceptedAt\),/);
  });

  it('CRITICAL upsertInvite refresh 4-field set — inviteTokenHash + inviteExpiresAt + role + invitedByAccountId. The 4-field refresh is the V-298c reinvite contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/team-members-repo.ts'));
    expect(p).toMatch(/inviteTokenHash: input\.inviteTokenHash,/);
    expect(p).toMatch(/inviteExpiresAt: input\.inviteExpiresAt,/);
    expect(p).toMatch(/role: input\.role,/);
    expect(p).toMatch(/invitedByAccountId: input\.invitedByAccountId,/);
    expect(p).toMatch(/if \(!row\) throw new Error\('team_invites upsert returned no row'\);/);
  });

  it('CRITICAL acceptInviteAtomic exact-token CAS and consumed-row authority prevent a replaced old role from being accepted.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/team-members-repo.ts'));
    expect(p).toMatch(/eq\(teamInvites\.id, input\.inviteId\),/);
    expect(p).toMatch(/eq\(teamInvites\.inviteTokenHash, input\.inviteTokenHash\),/);
    expect(p).toMatch(/isNull\(teamInvites\.acceptedAt\),/);
    expect(p).toMatch(/ownerAccountId: consumed\.ownerAccountId,/);
    expect(p).toMatch(/role: consumed\.role,/);
  });

  // ─── upsertMembership onConflictDoUpdate (security fix 2026-06-30) ──

  it("CRITICAL upsertMembership framing — 'Security fix (2026-06-30 audit) — ON CONFLICT (owner, member) DO UPDATE, not DO NOTHING' — with DO NOTHING the pre-existing row (with the OLD role) was returned unchanged, so an owner demoting an 'admin' member silently no-op'd (effectiveAccountIdForWrite gates real elevated access on this column). The DO-UPDATE design ensures a re-accept actually applies the new role.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/team-members-repo.ts'));
    expect(p).toMatch(
      /\/\/ Security fix \(2026-06-30 audit\) — ON CONFLICT \(owner, member\) DO\s*\n\s*\/\/ UPDATE, not DO NOTHING\./,
    );
    expect(p).toMatch(/silently no-op'd — the member kept/);
    expect(p).toMatch(/\/\/ the SELECT-on-conflict fallback is no longer needed\./);
  });

  it('CRITICAL upsertMembership conflict target is [ownerAccountId, memberAccountId] compound, DO UPDATE sets role/invitedAt/invitedByAccountId. The compound-key conflict matches the (owner, member) UNIQUE index; DO UPDATE (not DO NOTHING) actually applies a changed role on re-accept.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/team-members-repo.ts'));
    expect(p).toMatch(/\.onConflictDoUpdate\(\{/);
    expect(p).toMatch(/target: \[teamMembers\.ownerAccountId, teamMembers\.memberAccountId\],/);
    expect(p).toMatch(/set: \{\s*\n\s*role: input\.role,/);
  });

  it("CRITICAL upsertMembership .returning() always yields the affected row — 'if (!row) throw new Error(...)'. DO UPDATE means there is no more conflict-fallthrough SELECT branch to maintain (removed alongside the security fix).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/team-members-repo.ts'));
    expect(p).toMatch(/const \[row\] = await this\.database\.db/);
    expect(p).toMatch(/if \(!row\) throw new Error\('team_members upsert produced no row'\);/);
    // The old SELECT-on-conflict fallback branch is gone — `inserted ??` no
    // longer appears in this method.
    expect(p).not.toMatch(/inserted \?\?/);
  });

  // ─── listMembers innerJoin accounts ──────────────────────────

  it("CRITICAL listMembers innerJoin accounts on memberAccountId — 'Join accounts to surface member email at list-time. The shape matches in-memory repo's TeamMemberRow with memberEmail filled'. The join keeps memberEmail in the response without an N+1 lookup.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/team-members-repo.ts'));
    expect(p).toMatch(/\/\/ Join accounts to surface member email at list-time\. The shape/);
    expect(p).toMatch(/\/\/ matches in-memory repo's TeamMemberRow with memberEmail filled\./);
    expect(p).toMatch(/\.innerJoin\(accounts, eq\(accounts\.id, teamMembers\.memberAccountId\)\)/);
  });

  it('CRITICAL listMembers 9-field projection — id + ownerAccountId + memberAccountId + memberEmail (from accounts) + role + invitedAt + acceptedAt + invitedByAccountId + createdAt + orderBy desc(createdAt). The 9-field projection matches the TeamMemberRow service shape.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/team-members-repo.ts'));
    expect(p).toMatch(/id: teamMembers\.id,/);
    expect(p).toMatch(/ownerAccountId: teamMembers\.ownerAccountId,/);
    expect(p).toMatch(/memberAccountId: teamMembers\.memberAccountId,/);
    expect(p).toMatch(/memberEmail: accounts\.email,/);
    expect(p).toMatch(/role: teamMembers\.role,/);
    expect(p).toMatch(/invitedAt: teamMembers\.invitedAt,/);
    expect(p).toMatch(/acceptedAt: teamMembers\.acceptedAt,/);
    expect(p).toMatch(/invitedByAccountId: teamMembers\.invitedByAccountId,/);
    expect(p).toMatch(/createdAt: teamMembers\.createdAt,/);
    expect(p).toMatch(/\.orderBy\(desc\(teamMembers\.createdAt\)\);/);
  });

  // ─── listPendingInvites ──────────────────────────────────────

  it('CRITICAL listPendingInvites filter — and(eq(ownerAccountId), isNull(acceptedAt)) + orderBy desc(createdAt). The (owner, pending) filter scopes to outstanding invites only.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/team-members-repo.ts'));
    expect(p).toMatch(
      /\.where\(and\(eq\(teamInvites\.ownerAccountId, ownerAccountId\), isNull\(teamInvites\.acceptedAt\)\)\)/,
    );
    expect(p).toMatch(/\.orderBy\(desc\(teamInvites\.createdAt\)\);/);
  });

  // ─── removeMember scoped delete + V-326 cache hint ───────────

  it('CRITICAL removeMember scoped delete — and(eq(id), eq(ownerAccountId)) + returning({memberAccountId}). The owner-scoped guard prevents cross-tenant deletion; the returning() gives the auth-cache invalidator the freed memberId (V-326).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/team-members-repo.ts'));
    expect(p).toMatch(/\.delete\(teamMembers\)/);
    expect(p).toMatch(
      /\.where\(and\(eq\(teamMembers\.id, membershipId\), eq\(teamMembers\.ownerAccountId, ownerAccountId\)\)\)/,
    );
    expect(p).toMatch(/\.returning\(\{ memberAccountId: teamMembers\.memberAccountId \}\);/);
    expect(p).toMatch(
      /return result\.length > 0 \? \(result\[0\]\?\.memberAccountId \?\? null\) : null;/,
    );
  });

  // ─── markInviteAccepted ──────────────────────────────────────

  it("CRITICAL markInviteAccepted single-field UPDATE — 'set({acceptedAt: at}).where(eq(id))'. The single-field set keeps the row otherwise unchanged.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/team-members-repo.ts'));
    expect(p).toMatch(/\.update\(teamInvites\)/);
    expect(p).toMatch(/\.set\(\{ acceptedAt: at \}\)/);
    expect(p).toMatch(/\.where\(eq\(teamInvites\.id, inviteId\)\);/);
  });

  // ─── findAccountEmail narrow projection ──────────────────────

  it('CRITICAL findAccountEmail uses narrow select({email}) projection + returns row?.email ?? null. The narrow projection avoids fetching the full account row.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/team-members-repo.ts'));
    expect(p).toMatch(/\.select\(\{ email: accounts\.email \}\)/);
    expect(p).toMatch(/return row\?\.email \?\? null;/);
  });

  // ─── toInviteRow 9-field mapper ──────────────────────────────

  it('CRITICAL toInviteRow 9-field mapper — id + ownerAccountId + inviteeEmail + role + inviteTokenHash + inviteExpiresAt + invitedByAccountId + acceptedAt + createdAt. The 9-field TeamInviteRow is the V-298c service-layer shape.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/team-members-repo.ts'));
    expect(p).toMatch(/function toInviteRow\(row: InviteDb\): TeamInviteRow \{/);
    expect(p).toMatch(/id: row\.id,/);
    expect(p).toMatch(/ownerAccountId: row\.ownerAccountId,/);
    expect(p).toMatch(/inviteeEmail: row\.inviteeEmail,/);
    expect(p).toMatch(/role: row\.role,/);
    expect(p).toMatch(/inviteTokenHash: row\.inviteTokenHash,/);
    expect(p).toMatch(/inviteExpiresAt: row\.inviteExpiresAt,/);
    expect(p).toMatch(/invitedByAccountId: row\.invitedByAccountId,/);
    expect(p).toMatch(/acceptedAt: row\.acceptedAt,/);
    expect(p).toMatch(/createdAt: row\.createdAt,/);
  });

  // ─── attachMemberEmail helper ────────────────────────────────

  it("CRITICAL attachMemberEmail helper framing — 'when an upsertMembership returns just the team_members row, we still need memberEmail to populate the TeamMemberRow shape. The caller already has it (passed in input.memberEmail)'. The caller-supplied-email design saves a join on the hot insert path.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/team-members-repo.ts'));
    expect(p).toMatch(
      /\/\*\* Helper — when an upsertMembership returns just the team_members row,/,
    );
    expect(p).toMatch(/\*\s+we still need memberEmail to populate the TeamMemberRow shape\. The/);
    expect(p).toMatch(/\*\s+caller already has it \(passed in input\.memberEmail\)\. \*\//);
    expect(p).toMatch(
      /private attachMemberEmail\(row: MemberDb, memberEmail: string\): TeamMemberRow \{/,
    );
    expect(p).toMatch(/memberEmail,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/db-team-members-repo-v298c-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
