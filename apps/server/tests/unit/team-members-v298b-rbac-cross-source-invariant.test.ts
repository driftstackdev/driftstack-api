// W953 — V-298b team-members RBAC + V-298c auth-integration cross-
// source invariant. Two-hundred-seventy-ninth in the drift-guard
// series. Pins the team RBAC v1 service:
//
//   V-298b anchor — 'V-298b — Team RBAC v1 service'.
//
//   Team model framing — 'Models a "team" as one owner-account + N
//   member-accounts joined via the team_members table. Each member
//   is itself a regular accounts row (their own login + email); team
//   membership is a separate relationship'.
//
//   V-298b/V-298c boundary framing — 'The auth path integration
//   lives in V-298c — for V-298b, the service is pure (no auth-
//   cache writes, no scope checks beyond what the route layer
//   enforces at construction-time)'.
//
//   TeamRole 2-value union: 'member' | 'admin'.
//
//   3-step invite flow:
//     1. Owner/admin calls invite(inviterId, email, role).
//        Service generates 7-day token + emails invitee.
//     2. Invitee receives email + signs up + verifies email.
//     3. Invitee clicks accept link. Service token-hash lookup +
//        email-match assert + writes team_members row + marks
//        invite accepted.
//
//   2 idempotency invariants:
//     - Re-invite same email: existing pending invite gets fresh
//       token (old invalidated). No duplicate row.
//     - Re-accept: team_members unique-keyed (owner + member);
//       second accept returns existing membership without error.
//
//   TeamMemberRow (9 fields, matches W906 V-298c shape):
//     - id + ownerAccountId + memberAccountId + memberEmail + role
//       + invitedAt + acceptedAt + invitedByAccountId (nullable) +
//       createdAt.
//
//   TeamInviteRow shape (mirrors W906 V-298c invite-row pattern).
//
//   3-error import: BadRequestError + ConflictError + NotFoundError.
//
//   Token primitives from lib/auth-tokens: generateAuthToken +
//     tokenHash (matches V-079 + V-353d + V-266 + V-934 32-byte
//     URL-safe + sha256-at-rest pattern).
//
// stays in lockstep across apps/server/src/services/team-members.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W953 V-298b team-members RBAC cross-source invariant', () => {
  // ─── V-298b anchor + service intro ───────────────────────────

  it("CRITICAL apps/server/src/services/team-members.ts header pins V-298b anchor — 'V-298b — Team RBAC v1 service'. The V-298b anchor is the policy provenance for team-RBAC v1.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/team-members.ts'));
    expect(p).toMatch(/V-298b — Team RBAC v1 service/);
  });

  // ─── Team model framing ──────────────────────────────────────

  it('CRITICAL team-model framing — \'Models a "team" as one owner-account + N member-accounts joined via the team_members table. Each member is itself a regular accounts row (their own login + email); team membership is a separate relationship\'. The 1-owner + N-member + members-have-own-accounts model is the V-298b data structure.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/team-members.ts'));
    expect(p).toMatch(/Models a "team" as one owner-account \+ N member-accounts joined via/);
    expect(p).toMatch(/the team_members table\. Each member is itself a regular `accounts`/);
    expect(p).toMatch(/row \(their own login \+ email\); team membership is a separate/);
    expect(p).toMatch(/relationship\./);
  });

  // ─── V-298b/V-298c service-purity boundary ───────────────────

  it("CRITICAL V-298b/V-298c boundary framing — 'The auth path integration lives in V-298c — for V-298b, the service is pure (no auth-cache writes, no scope checks beyond what the route layer enforces at construction-time)'. The V-298b pure-service + V-298c auth-integration split keeps team-RBAC modular.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/team-members.ts'));
    expect(p).toMatch(/The auth path integration lives in V-298c — for/);
    expect(p).toMatch(/V-298b, the service is pure \(no auth-cache writes, no scope checks/);
    expect(p).toMatch(/beyond what the route layer enforces at construction-time\)\./);
  });

  // ─── TeamRole 2-value union ──────────────────────────────────

  it("CRITICAL TeamRole = 'member' | 'admin'. The 2-role union matches W924 auth-cache SerializedTeamMembership + W951 auth.ts TeamMembership shapes.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/team-members.ts'));
    expect(p).toMatch(/export type TeamRole = 'member' \| 'admin';/);
  });

  // ─── 3-step invite flow framing ──────────────────────────────

  it("CRITICAL 3-step invite flow framing — '1. Owner (or admin team member) calls invite(inviterId, email, role). Service generates a 7-day token + emails the invitee. 2. Invitee receives the email. They sign up (if not already a Driftstack customer) and verify their email. 3. Invitee clicks the accept link. Service looks up the invite by token-hash, asserts the invitee's account email matches, writes the team_members row, marks the invite accepted'. The 7-day token + email-match-assert + 2-mutation flow is the customer-facing API.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/team-members.ts'));
    expect(p).toMatch(
      /1\. Owner \(or admin team member\) calls invite\(inviterId, email, role\)\./,
    );
    expect(p).toMatch(/Service generates a 7-day token \+ emails the invitee\./);
    expect(p).toMatch(/2\. Invitee receives the email\. They sign up \(if not already a/);
    expect(p).toMatch(/Driftstack customer\) and verify their email\./);
    expect(p).toMatch(/3\. Invitee clicks the accept link\. Service looks up the invite by/);
    expect(p).toMatch(/token-hash, asserts the invitee's account email matches, writes/);
    expect(p).toMatch(/the team_members row, marks the invite accepted\./);
  });

  // ─── 2 idempotency invariants ────────────────────────────────

  it("CRITICAL 2-idempotency framing — 'Re-inviting the same email = the existing pending invite gets a fresh token (old token invalidated). No duplicate row. Re-accepting = the team_members row is unique-keyed (owner + member); the second accept finds the row already there and returns the existing membership without error'. The fresh-token-on-reinvite + unique-keyed-on-accept design is the V-298b idempotency contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/team-members.ts'));
    expect(p).toMatch(/Idempotency:/);
    expect(p).toMatch(/- Re-inviting the same email = the existing pending invite gets a/);
    expect(p).toMatch(/fresh token \(old token invalidated\)\. No duplicate row\./);
    expect(p).toMatch(/- Re-accepting = the team_members row is unique-keyed \(owner \+/);
    expect(p).toMatch(/member\); the second accept finds the row already there and/);
    expect(p).toMatch(/returns the existing membership without error\./);
  });

  // ─── TeamMemberRow 9-field shape (matches W906) ──────────────

  it('CRITICAL TeamMemberRow has 9 fields — id + ownerAccountId + memberAccountId + memberEmail + role + invitedAt + acceptedAt + invitedByAccountId (nullable) + createdAt. The 9-field shape matches W906 V-298c team-invite invariant; drift would break the auth-cache + route-layer cross-source contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/team-members.ts'));
    expect(p).toMatch(/export interface TeamMemberRow \{/);
    expect(p).toMatch(/id: string;/);
    expect(p).toMatch(/ownerAccountId: string;/);
    expect(p).toMatch(/memberAccountId: string;/);
    expect(p).toMatch(/memberEmail: string;/);
    expect(p).toMatch(/role: TeamRole;/);
    expect(p).toMatch(/invitedAt: Date;/);
    expect(p).toMatch(/acceptedAt: Date;/);
    expect(p).toMatch(/invitedByAccountId: string \| null;/);
    expect(p).toMatch(/createdAt: Date;/);
  });

  // ─── TeamInviteRow shape (mirrors W906) ──────────────────────

  it('CRITICAL TeamInviteRow exists + has core fields (id + ownerAccountId + inviteeEmail + role). The TeamInviteRow + TeamMemberRow 2-table split distinguishes pending-invite from confirmed-membership.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/team-members.ts'));
    expect(p).toMatch(/export interface TeamInviteRow \{/);
    expect(p).toMatch(/id: string;/);
    expect(p).toMatch(/ownerAccountId: string;/);
    expect(p).toMatch(/inviteeEmail: string;/);
    expect(p).toMatch(/role: TeamRole;/);
  });

  // ─── 3-error class import ────────────────────────────────────

  it('CRITICAL imports 3 error classes — BadRequestError + ConflictError + NotFoundError. The 3-error palette covers input-validation / state-conflict / row-missing states (matches W939 billing + W948 profiles patterns).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/team-members.ts'));
    expect(p).toMatch(
      /import \{ BadRequestError, ConflictError, NotFoundError \} from '\.\.\/lib\/errors\.js';/,
    );
  });

  // ─── Token primitives import (matches V-079 pattern) ─────────

  it('CRITICAL imports generateAuthToken + tokenHash from lib/auth-tokens — the 2-primitive split matches V-079 + V-353d + V-266 + V-934 32-byte URL-safe base64 + sha256-at-rest token pattern.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/team-members.ts'));
    expect(p).toMatch(
      /import \{ generateAuthToken, tokenHash \} from '\.\.\/lib\/auth-tokens\.js';/,
    );
  });

  // ─── 3-service-dep type imports ──────────────────────────────

  it('CRITICAL imports AccountAuditService + AuthCache + EmailService — 3 service-level dependencies. AccountAuditService for membership-change audit (W937); AuthCache for V-326 team-cache invalidation; EmailService for invite emails.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/team-members.ts'));
    expect(p).toMatch(/import type \{ AccountAuditService \} from '\.\/account-audit\.js';/);
    expect(p).toMatch(/import type \{ AuthCache \} from '\.\/auth-cache\.js';/);
    expect(p).toMatch(/import type \{ EmailService \} from '\.\/email\.js';/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/team-members-v298b-rbac-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
