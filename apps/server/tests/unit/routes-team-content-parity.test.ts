// W437.C — drift guard for apps/server/src/routes/team.ts.
// V-298c Team RBAC v1 — 5 invite/member endpoints + V-326c teams-I-
// am-on. Drift here either drops the V-298c "route-only" framing
// (membership doesn't grant permissions until V-298d) or silently
// extends the role enum past 'member|admin' (Q1 verdict locked the
// two-role model for v1).
//
//   • V-298c 5 endpoints: invites POST/GET + invites/accept + members
//     GET + members/:id DELETE.
//   • V-298c framing pinned: route-only; auth path doesn't yet honor
//     team membership (V-298d wires it); members can be invited +
//     accept but the resulting membership doesn't grant permissions
//     on the owner's resources until V-298d.
//   • role enum: 'member' | 'admin' (Q1 two-role model).
//   • Public-id prefixes: mem_<uuid> + inv_<uuid> + acc_<uuid>.
//   • V-326c GET /v1/team/owners: read straight from ctx.teams (no DB
//     call); mirror of GET /v1/team/members ("teams I am ON").
//   • DELETE 404 uses problem+json shape (type/title/status/detail).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/team.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W437.C apps/server/src/routes/team.ts content parity', () => {
  const body = read(LIB);

  it('V-298c framing pinned: 5 endpoints listed (POST invites + GET invites + POST invites/accept + GET members + DELETE members/:id); route-only — auth path does NOT yet honor team membership (V-298d); members can be invited + accept but membership does NOT grant permissions on owner resources until V-298d wires it', () => {
    expect(body).toMatch(/\/\/ V-298c — Team RBAC v1 routes\./);
    expect(body).toMatch(
      // GET invites/members are requireAuth (owner-scoped by the ctx.account.id
      // query key), corrected 2026-07-10 to match the actual gate — the mutations
      // (POST invites / DELETE member) are the account_owner-gated operations.
      /\/\/\s*POST\s+\/v1\/team\/invites\s+— owner invites email \(account_owner\)\s*\n?\s*\/\/\s*GET\s+\/v1\/team\/invites\s+— list pending \(requireAuth; owner-scoped by query\)\s*\n?\s*\/\/\s*POST\s+\/v1\/team\/invites\/accept\s+— invitee accepts \(requireAuth\)\s*\n?\s*\/\/\s*GET\s+\/v1\/team\/members\s+— list confirmed \(requireAuth; owner-scoped by query\)\s*\n?\s*\/\/\s*DELETE \/v1\/team\/members\/:id\s+— remove member \(account_owner\)/,
    );
    expect(body).toMatch(
      /\/\/ V-298c is route-only; the auth path itself doesn't yet honor team\s*\n?\s*\/\/ membership \(V-298d\)\. Members can be invited \+ accept, but the\s*\n?\s*\/\/ resulting membership doesn't grant them any permissions on the\s*\n?\s*\/\/ owner's resources until V-298d wires it\./,
    );
  });

  it('imports: FastifyInstance + zod + ValidationError + TeamInviteRow/TeamMemberRow/TeamMembersService', () => {
    expect(body).toMatch(/import type \{ FastifyInstance \} from 'fastify';/);
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(/import \{ ValidationError \} from '\.\.\/lib\/errors\.js';/);
    expect(body).toMatch(
      /import type \{ TeamInviteRow, TeamMemberRow, TeamMembersService \} from '\.\.\/services\/team-members\.js';/,
    );
  });

  it('InviteBody: email trim + email() + .max(254) + role enum (member|admin) optional; AcceptBody: token min 20', () => {
    expect(body).toMatch(
      /const InviteBodySchema = z\.object\(\{\s*\n?\s*email: z\.string\(\)\.trim\(\)\.email\('Must be a valid email\.'\)\.max\(254\),\s*\n?\s*role: z\.enum\(\['member', 'admin'\]\)\.optional\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /const AcceptBodySchema = z\.object\(\{\s*\n?\s*token: z\.string\(\)\.min\(20, 'Missing or malformed token\.'\),\s*\n?\s*\}\);/,
    );
  });

  it('MEMBER_ID_RE regex (mem_ + UUID); uuidFromMemberId throws ValidationError with form-error', () => {
    expect(body).toMatch(
      /const MEMBER_ID_RE = \/\^mem_\(\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\)\$\/;/,
    );
    expect(body).toMatch(
      /function uuidFromMemberId\(value: string\): string \{\s*\n?\s*const match = MEMBER_ID_RE\.exec\(value\);\s*\n?\s*if \(!match \|\| !match\[1\]\) \{\s*\n?\s*throw new ValidationError\(\{\s*\n?\s*formErrors: \['Invalid id format\. Expected "mem_<uuid>"\.'\],\s*\n?\s*fieldErrors: \{\},\s*\n?\s*\}\);\s*\n?\s*\}\s*\n?\s*return match\[1\];\s*\n?\s*\}/,
    );
  });

  it('publicMember mapper (9 fields wire: id mem_ + owner_account_id acc_ + member_account_id acc_ + member_email + role + invited_at + accepted_at + invited_by_account_id acc_ nullable)', () => {
    expect(body).toMatch(
      /function publicMember\(row: TeamMemberRow\): Record<string, unknown> \{\s*\n?\s*return \{\s*\n?\s*id: `mem_\$\{row\.id\}`,\s*\n?\s*owner_account_id: `acc_\$\{row\.ownerAccountId\}`,\s*\n?\s*member_account_id: `acc_\$\{row\.memberAccountId\}`,\s*\n?\s*member_email: row\.memberEmail,\s*\n?\s*role: row\.role,\s*\n?\s*invited_at: row\.invitedAt\.toISOString\(\),\s*\n?\s*accepted_at: row\.acceptedAt\.toISOString\(\),\s*\n?\s*invited_by_account_id: row\.invitedByAccountId \? `acc_\$\{row\.invitedByAccountId\}` : null,\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('publicInvite mapper (8 fields wire: id inv_ + owner_account_id acc_ + invitee_email + role + expires_at + invited_by_account_id acc_ nullable + accepted_at nullable + created_at)', () => {
    expect(body).toMatch(
      /function publicInvite\(row: TeamInviteRow\): Record<string, unknown> \{\s*\n?\s*return \{\s*\n?\s*id: `inv_\$\{row\.id\}`,\s*\n?\s*owner_account_id: `acc_\$\{row\.ownerAccountId\}`,\s*\n?\s*invitee_email: row\.inviteeEmail,\s*\n?\s*role: row\.role,\s*\n?\s*expires_at: row\.inviteExpiresAt\.toISOString\(\),\s*\n?\s*invited_by_account_id: row\.invitedByAccountId \? `acc_\$\{row\.invitedByAccountId\}` : null,\s*\n?\s*accepted_at: row\.acceptedAt \? row\.acceptedAt\.toISOString\(\) : null,\s*\n?\s*created_at: row\.createdAt\.toISOString\(\),\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('POST /v1/team/invites: invite request body (email + optional role) + service.invite + 202 with "Invite sent. The invitee can accept via the email link." message', () => {
    expect(body).toMatch(
      /await service\.invite\(\{\s*\n?\s*ownerAccountId: ctx\.account\.id,\s*\n?\s*invitedByAccountId: ctx\.account\.id,\s*\n?\s*inviteeEmail: parsed\.data\.email,\s*\n?\s*\.\.\.\(parsed\.data\.role !== undefined \? \{ role: parsed\.data\.role \} : \{\}\),\s*\n?\s*\}\);\s*\n?\s*return reply\s*\n?\s*\.code\(202\)\s*\n?\s*\.send\(\{ message: 'Invite sent\. The invitee can accept via the email link\.' \}\);/,
    );
  });

  it('GET /v1/team/invites: listPendingInvites(ownerAccountId) → data array of publicInvite', () => {
    expect(body).toMatch(
      /const rows = await service\.listPendingInvites\(ctx\.account\.id\);\s*\n?\s*return \{ data: rows\.map\(publicInvite\) \};/,
    );
  });

  it('POST /v1/team/invites/accept: AcceptBodySchema parse + service.accept({plaintextToken, acceptingAccountId}) → 200 with membership: publicMember', () => {
    expect(body).toMatch(
      /const result = await service\.accept\(\{\s*\n?\s*plaintextToken: parsed\.data\.token,\s*\n?\s*acceptingAccountId: ctx\.account\.id,\s*\n?\s*\}\);\s*\n?\s*return reply\.code\(200\)\.send\(\{ membership: publicMember\(result\.membership\) \}\);/,
    );
  });

  it('GET /v1/team/members: listMembers(ownerAccountId) → data array of publicMember', () => {
    expect(body).toMatch(
      /const rows = await service\.listMembers\(ctx\.account\.id\);\s*\n?\s*return \{ data: rows\.map\(publicMember\) \};/,
    );
  });

  it('V-326c GET /v1/team/owners framing pinned: list owner accounts caller is a member of; read straight from ctx.teams (already loaded on auth-cache miss); no DB call; mirror of GET /v1/team/members ("MY members") — this is "teams I am ON"', () => {
    expect(body).toMatch(
      /\/\/ V-326c — list owner accounts the caller is a member of\. Read\s*\n?\s*\/\/ straight from ctx\.teams \(already loaded on auth-cache miss\); no\s*\n?\s*\/\/ DB call\. The mirror of GET \/v1\/team\/members \(which lists "MY\s*\n?\s*\/\/ members"\); this is "teams I am ON"\./,
    );
    expect(body).toMatch(
      /return \{\s*\n?\s*data: ctx\.teams\.map\(\(t\) => \(\{\s*\n?\s*owner_account_id: `acc_\$\{t\.ownerAccountId\}`,\s*\n?\s*owner_email: t\.ownerEmail \?\? `acc_\$\{t\.ownerAccountId\}`,\s*\n?\s*owner_name: t\.ownerName \?\? null,\s*\n?\s*role: t\.role,\s*\n?\s*membership_id: `mem_\$\{t\.membershipId\}`,\s*\n?\s*\}\)\),\s*\n?\s*\};/,
    );
  });

  it('DELETE /v1/team/members/:id: 404 returns problem+json shape (type "about:blank" + title "Not Found" + status 404 + detail with membership id); 204 on successful removal', () => {
    expect(body).toMatch(
      /const removed = await service\.removeMember\(\{\s*\n?\s*membershipId: id,\s*\n?\s*ownerAccountId: ctx\.account\.id,\s*\n?\s*\}\);\s*\n?\s*if \(!removed\) \{\s*\n?\s*return reply\.code\(404\)\.send\(\{\s*\n?\s*type: 'about:blank',\s*\n?\s*title: 'Not Found',\s*\n?\s*status: 404,\s*\n?\s*detail: `Membership \$\{request\.params\.id\} not found\.`,\s*\n?\s*\}\);\s*\n?\s*\}\s*\n?\s*return reply\.code\(204\)\.send\(\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
