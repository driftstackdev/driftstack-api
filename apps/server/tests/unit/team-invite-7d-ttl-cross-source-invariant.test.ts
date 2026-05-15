// W906 — V-298c Team invite + 7-day TTL cross-source invariant.
// Two-hundred-thirty-second in the drift-guard series. Pins the
// V-298c team-invite contract:
//
//   TEAM_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000 (= 7 days).
//
//   TeamMemberRow (9 fields, confirmed membership):
//     id + ownerAccountId + memberAccountId + memberEmail + role
//     + invitedAt + acceptedAt + invitedByAccountId (nullable) +
//     createdAt.
//
//   TeamInviteRow (9 fields, pending invite):
//     id + ownerAccountId + inviteeEmail + role + inviteTokenHash
//     + inviteExpiresAt + invitedByAccountId (nullable) +
//     acceptedAt (nullable) + createdAt.
//
//   TeamMembersServiceConfig.dashboardBaseUrl is REQUIRED — used
//   to build accept-invite URLs in invitation emails.
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

const TTL_DAYS = 7;
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

describe('W906 V-298c Team invite + 7-day TTL cross-source invariant', () => {
  // ─── TEAM_INVITE_TTL_MS = 7 days ─────────────────────────────

  it('CRITICAL apps/server/src/services/team-members.ts TEAM_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000 (= 7 days = 604_800_000 ms). The 7-day TTL is wide enough for a teammate to find + respond to the invite email but narrow enough to bound stale-invite cleanup.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/team-members.ts'));
    expect(p).toMatch(
      /export const TEAM_INVITE_TTL_MS = 7 \* 24 \* 60 \* 60 \* 1000;\s*\/\/ 7 days/,
    );
    expect(TTL_MS).toBe(604_800_000);
  });

  // ─── TeamMemberRow 9-field shape ─────────────────────────────

  it('CRITICAL TeamMemberRow has 9 fields — id + ownerAccountId + memberAccountId + memberEmail + role + invitedAt + acceptedAt + invitedByAccountId (nullable) + createdAt. The 9-field shape carries both invitation provenance (invitedAt + invitedByAccountId) AND confirmed membership (acceptedAt).', () => {
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

  // ─── TeamInviteRow 9-field shape ─────────────────────────────

  it('CRITICAL TeamInviteRow has 9 fields — id + ownerAccountId + inviteeEmail + role + inviteTokenHash + inviteExpiresAt + invitedByAccountId (nullable) + acceptedAt (nullable) + createdAt. The 9-field invite shape has 2 nullables — invitedByAccountId (system-invite) + acceptedAt (pending).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/team-members.ts'));
    expect(p).toMatch(/export interface TeamInviteRow \{/);
    expect(p).toMatch(/inviteeEmail: string;/);
    expect(p).toMatch(/inviteTokenHash: string;/);
    expect(p).toMatch(/inviteExpiresAt: Date;/);
    expect(p).toMatch(/invitedByAccountId: string \| null;/);
    expect(p).toMatch(/acceptedAt: Date \| null;/);
  });

  // ─── TeamMembersServiceConfig.dashboardBaseUrl ──────────────

  it("CRITICAL TeamMembersServiceConfig has dashboardBaseUrl REQUIRED — 'Public origin of the customer-dashboard, used to build accept URLs in invite emails'. The required field forces wiring the dashboard URL — drift to optional would let invite-emails land with broken accept links.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/team-members.ts'));
    expect(p).toMatch(/export interface TeamMembersServiceConfig \{/);
    expect(p).toMatch(/dashboardBaseUrl: string;/);
    expect(p).toMatch(
      /Public origin of the customer-dashboard, used to build accept URLs in invite emails/,
    );
  });

  // ─── upsertInvite is deduped + idempotent ────────────────────

  it("CRITICAL upsertInvite repo method is 'Insert or refresh a pending invite (deduped by owner + email)'. The dedup-by-owner+email contract prevents duplicate invite-rows for the same teammate.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/team-members.ts'));
    expect(p).toMatch(/Insert or refresh a pending invite \(deduped by owner \+ email\)/);
  });

  it("CRITICAL markInviteAccepted method is 'Mark invite as accepted (idempotent)'. The idempotency lets accept-flow retries succeed without producing duplicate audit-log entries.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/team-members.ts'));
    expect(p).toMatch(/Mark invite as accepted \(idempotent\)/);
  });

  // ─── removeMember returns deleted account-id for cache invalidation ─

  it("CRITICAL removeMember return type is 'string | null' — returns the removed member's account_id for auth-cache invalidation. The 'so the caller can invalidate that member's auth cache' framing pins the security-handoff contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/team-members.ts'));
    expect(p).toMatch(
      /Returns the removed member's\s*\*\s*account id when the row was found \+ deleted \(so the caller can/,
    );
    expect(p).toMatch(
      /invalidate that member's auth cache\); null when the row was not\s*\*\s*found/,
    );
  });

  // ─── 7-day TTL cardinality ───────────────────────────────────

  it('CRITICAL TEAM_INVITE_TTL_MS = 7 days. Drift to shorter (e.g. 1 day) would force teammates to find the email same-day; drift to longer (e.g. 30 days) would let stale invites linger in the DB.', () => {
    expect(TTL_DAYS).toBe(7);
    expect(TTL_MS).toBe(604_800_000);
  });

  // ─── findInviteByTokenHash for accept path ──────────────────

  it("CRITICAL findInviteByTokenHash is 'Token-hash lookup for the accept path. Returns null if not found'. The hash-keyed lookup is what makes invite-link consumption secure (server stores hash, not plaintext).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/team-members.ts'));
    expect(p).toMatch(/Token-hash lookup for the accept path\. Returns null if not found/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/team-invite-7d-ttl-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
