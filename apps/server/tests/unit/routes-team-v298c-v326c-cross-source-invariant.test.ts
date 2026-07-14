// W1050 — routes/team V-298c + V-326c cross-source invariant.
// Pins apps/server/src/routes/team.ts Team RBAC v1 routes:
//
//   V-298c anchor — 'V-298c — Team RBAC v1 routes'.
//
//   Endpoint roster — 6 routes:
//     POST   /v1/team/invites              — owner invites email
//     GET    /v1/team/invites              — list pending
//     POST   /v1/team/invites/accept       — invitee accepts
//     GET    /v1/team/members              — list confirmed
//     GET    /v1/team/owners               — teams I am ON (V-326c)
//     DELETE /v1/team/members/:id          — remove member
//
//   Route-only-not-yet-auth-path framing — 'V-298c is route-only;
//   the auth path itself doesn't yet honor team membership (V-298d).
//   Members can be invited + accept, but the resulting membership
//   doesn't grant them any permissions on the owner's resources
//   until V-298d wires it'.
//
//   InviteBodySchema — email (trimmed + zod email validator) + role
//   ('member' | 'admin') optional.
//
//   AcceptBodySchema — token min(20) with 'Missing or malformed
//   token.' error.
//
//   MEMBER_ID_RE — '^mem_(uuid-with-dashes)$' (different from
//   admin-incidents PUBLIC_ID_RE because member ids use mem_ prefix
//   specifically; not the general 3-letter prefix family).
//
//   publicMember envelope — 8 fields including mem_ id +
//   acc_-prefixed owner_account_id + member_account_id +
//   invited_by_account_id (nullable).
//
//   publicInvite envelope — 8 fields including inv_ id +
//   accepted_at nullable (pending invites have null).
//
//   POST /v1/team/invites returns 202 (accepted — async send) with
//   'Invite sent. The invitee can accept via the email link.'.
//
//   V-326c GET /v1/team/owners reads from ctx.teams (no DB call) —
//   mirrors V-326e effective-account info.
//
//   DELETE /v1/team/members/:id throws typed NotFoundError on 404,
//   204 No Content on success.
//
// stays in lockstep across apps/server/src/routes/team.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  return readFileSync(p, 'utf8');
}

describe('W1050 routes/team V-298c + V-326c cross-source invariant', () => {
  // ─── V-298c anchor + 6-endpoint roster ───────────────────────

  it("CRITICAL V-298c anchor — 'V-298c — Team RBAC v1 routes'. The single-anchor design ties the route file to the team-rbac family.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/team.ts'));
    expect(p).toMatch(/V-298c — Team RBAC v1 routes\./);
  });

  it('CRITICAL endpoint roster — 6 routes (invites POST/GET/accept + members GET/DELETE + owners GET). The exhaustive header comment is the canonical contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/team.ts'));
    expect(p).toMatch(/POST\s+\/v1\/team\/invites\s+— owner invites email/);
    expect(p).toMatch(/GET\s+\/v1\/team\/invites\s+— list pending/);
    expect(p).toMatch(/POST\s+\/v1\/team\/invites\/accept\s+— invitee accepts/);
    expect(p).toMatch(/GET\s+\/v1\/team\/members\s+— list confirmed/);
    expect(p).toMatch(/DELETE \/v1\/team\/members\/:id\s+— remove member/);
    expect(p).toMatch(/'\/v1\/team\/owners'/);
  });

  // ─── Route-only-not-yet-auth-path framing ────────────────────

  it("CRITICAL route-only framing — 'V-298c is route-only; the auth path itself doesn't yet honor team membership (V-298d). Members can be invited + accept, but the resulting membership doesn't grant them any permissions on the owner's resources until V-298d wires it'. The migration-window framing prevents premature reliance on the membership for auth.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/team.ts'));
    expect(p).toMatch(/V-298c is route-only; the auth path itself doesn't yet honor team/);
    expect(p).toMatch(/membership \(V-298d\)\. Members can be invited \+ accept, but the/);
    expect(p).toMatch(/resulting membership doesn't grant them any permissions on the/);
    expect(p).toMatch(/owner's resources until V-298d wires it\./);
  });

  // ─── InviteBody / AcceptBody schemas ─────────────────────────

  it("CRITICAL InviteBodySchema — trimmed email + optional role enum ('member' | 'admin'). The trim prevents whitespace-only invites from passing the zod email check.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/team.ts'));
    expect(p).toMatch(
      /email: z\.string\(\)\.trim\(\)\.email\('Must be a valid email\.'\)\.max\(254\),/,
    );
    expect(p).toMatch(/role: z\.enum\(\['member', 'admin'\]\)\.optional\(\),/);
  });

  it("CRITICAL AcceptBodySchema — token min(20) with explicit 'Missing or malformed token.' message. The 20-char floor catches truncation; the canonical error string lets clients render a clean 'paste your token again' UI.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/team.ts'));
    expect(p).toMatch(/token: z\.string\(\)\.min\(20, 'Missing or malformed token\.'\),/);
  });

  // ─── MEMBER_ID_RE shape ──────────────────────────────────────

  it("CRITICAL MEMBER_ID_RE — '^mem_(uuid)$' (specific to member ids; not the general PUBLIC_ID_RE family). The dedicated regex anchors the mem_ prefix specifically.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/team.ts'));
    expect(p).toMatch(
      /const MEMBER_ID_RE = \/\^mem_\(\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\)\$\//,
    );
    expect(p).toMatch(/'Invalid id format\. Expected "mem_<uuid>"\.'/);
  });

  // ─── publicMember envelope ───────────────────────────────────

  it('CRITICAL publicMember envelope — 8 fields (mem_ id / acc_-prefixed owner + member + invited_by | null / member_email / role / invited_at ISO / accepted_at ISO). All 3 account ids carry the acc_ prefix.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/team.ts'));
    expect(p).toMatch(/id: `mem_\$\{row\.id\}`,/);
    expect(p).toMatch(/owner_account_id: `acc_\$\{row\.ownerAccountId\}`,/);
    expect(p).toMatch(/member_account_id: `acc_\$\{row\.memberAccountId\}`,/);
    expect(p).toMatch(/member_email: row\.memberEmail,/);
    expect(p).toMatch(/role: row\.role,/);
    expect(p).toMatch(/invited_at: row\.invitedAt\.toISOString\(\),/);
    expect(p).toMatch(/accepted_at: row\.acceptedAt\.toISOString\(\),/);
    expect(p).toMatch(
      /invited_by_account_id: row\.invitedByAccountId \? `acc_\$\{row\.invitedByAccountId\}` : null,/,
    );
  });

  // ─── publicInvite envelope ───────────────────────────────────

  it('CRITICAL publicInvite envelope — 8 fields (inv_ id / acc_ owner + invited_by | null / invitee_email / role / expires_at + accepted_at ISO|null + created_at ISO). The accepted_at nullable distinguishes pending vs already-accepted invites.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/team.ts'));
    expect(p).toMatch(/id: `inv_\$\{row\.id\}`,/);
    expect(p).toMatch(/owner_account_id: `acc_\$\{row\.ownerAccountId\}`,/);
    expect(p).toMatch(/invitee_email: row\.inviteeEmail,/);
    expect(p).toMatch(/expires_at: row\.inviteExpiresAt\.toISOString\(\),/);
    expect(p).toMatch(/accepted_at: row\.acceptedAt \? row\.acceptedAt\.toISOString\(\) : null,/);
    expect(p).toMatch(/created_at: row\.createdAt\.toISOString\(\),/);
  });

  // ─── POST /v1/team/invites response ──────────────────────────

  it("CRITICAL POST /v1/team/invites → 202 Accepted with 'Invite sent. The invitee can accept via the email link.' The 202-not-201 communicates 'we queued the send; check email'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/team.ts'));
    expect(p).toMatch(/\.code\(202\)/);
    expect(p).toMatch(/'Invite sent\. The invitee can accept via the email link\.'/);
  });

  // ─── V-326c /v1/team/owners ──────────────────────────────────

  it('CRITICAL V-326c /v1/team/owners framing — \'list owner accounts the caller is a member of. Read straight from ctx.teams (already loaded on auth-cache miss); no DB call. The mirror of GET /v1/team/members (which lists "MY members"); this is "teams I am ON"\'. The ctx-only read avoids the DB round-trip on every dashboard load.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/team.ts'));
    expect(p).toMatch(/V-326c — list owner accounts the caller is a member of\. Read/);
    expect(p).toMatch(/straight from ctx\.teams \(already loaded on auth-cache miss\); no/);
    expect(p).toMatch(/DB call\. The mirror of GET \/v1\/team\/members \(which lists "MY/);
    expect(p).toMatch(/members"\); this is "teams I am ON"\./);
  });

  it('CRITICAL /v1/team/owners response — { data: [{ owner_account_id acc_, role, membership_id mem_ }] }. The 3-field per-row shape is what the dashboard team-switcher consumes.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/team.ts'));
    expect(p).toMatch(/data: ctx\.teams\.map\(\(t\) => \(\{/);
    expect(p).toMatch(/owner_account_id: `acc_\$\{t\.ownerAccountId\}`,/);
    expect(p).toMatch(/role: t\.role,/);
    expect(p).toMatch(/membership_id: `mem_\$\{t\.membershipId\}`,/);
  });

  // ─── DELETE /v1/team/members/:id ─────────────────────────────

  it('CRITICAL DELETE /v1/team/members/:id — 204 on success, typed NotFoundError on 404', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/team.ts'));
    expect(p).toMatch(/return reply\.code\(204\)\.send\(\);/);
    expect(p).toContain('throw new NotFoundError(`Membership ${request.params.id} not found.`);');
    expect(p).not.toContain("type: 'about:blank'");
  });

  // ─── Auth + rate-limit on every route ────────────────────────

  it('CRITICAL requireAuth + global rate-limit on every team route; broad read on directories and account_owner on membership mutations.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/team.ts'));
    // create-invite, accept-invite, and remove-member are account-control
    // mutations; the three directory reads carry broad read.
    expect((p.match(/app\.requireAuth/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect((p.match(/app\.rateLimit\('global'\)/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect((p.match(/app\.requireScope\('account_owner'\)/g) ?? []).length).toBe(3);
    expect((p.match(/app\.requireScope\('read'\)/g) ?? []).length).toBe(3);
  });
});
