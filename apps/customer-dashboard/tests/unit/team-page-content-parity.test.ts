// W365.B — drift guard for customer-dashboard /team page
// content. V-298c / V-326e. Existing parity tests cover
// endpoint wiring + invite-flow specifics; this guard pins:
//
//   • Role-select options are exactly the team_role Postgres
//     enum values (member / admin). A schema add (e.g. 'viewer')
//     without a page update silently makes that role
//     unsubscribable from the GUI.
//   • All 4 team endpoints used (GET .../members, GET
//     .../invites, POST .../invites, DELETE .../members/:id)
//     registered server-side.
//   • V-326a-e6 effective-account framing pinned (X-Driftstack-
//     Account header for member-acts-on-owner reads/writes).
//   • Reads accept member+admin; writes require admin (RBAC
//     contract).
//   • "API keys remain account-scoped (shared) and admin-gated"
//     framing pinned — load-bearing scope claim.
//   • localStorage key ds_web_session_token.
//   • Invite-form "send invite" + remove-member DELETE path
//     wired correctly (mem_ id semantics from /docs/teams).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/team.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/team.ts');
const DB_SCHEMA = resolve(REPO_ROOT, 'apps/server/src/db/schema.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W365.B customer-dashboard /team page content parity', () => {
  const body = read(PAGE);
  const dbSchema = read(DB_SCHEMA);
  const route = read(ROUTE);

  it('role-select options exactly match team_role Postgres enum (member / admin)', () => {
    // Pull every <option value="..."> in the role select.
    const selectMatch = body.match(/<select\b[^>]*name="role"[\s\S]*?<\/select>/);
    expect(selectMatch).not.toBeNull();
    const tag = selectMatch![0]!;
    const opts = Array.from(tag.matchAll(/<option value="([a-z_]+)">/g)).map((m) => m[1] as string);
    expect(opts.sort()).toEqual(['admin', 'member']);
    // Postgres source-of-truth.
    expect(dbSchema).toMatch(/teamRole = pgEnum\('team_role', \['member', 'admin'\]\)/);
  });

  it('all 4 team endpoints wired client + registered server-side', () => {
    expect(body).toContain("'/v1/team/members'");
    expect(body).toContain("'/v1/team/invites'");
    expect(body).toMatch(/\/v1\/team\/members\/'\s*\+\s*encodeURIComponent\(id\)/);
    expect(route).toContain("'/v1/team/invites'");
    expect(route).toContain("'/v1/team/invites/accept'");
    expect(route).toContain("'/v1/team/members'");
  });

  it('V-326 effective-account framing pinned (X-Driftstack-Account header for member→owner reads)', () => {
    expect(body).toMatch(/X-Driftstack-Account header/);
    expect(body).toMatch(/V-331 picker handles toggling/);
  });

  it('reads accept member+admin; writes require admin (RBAC contract)', () => {
    expect(body).toMatch(
      /Reads accept both 'member' and\s*\n?\s*\/\/\s*'admin' roles; writes require 'admin'/,
    );
  });

  it('"API keys remain account-scoped (shared) and admin-gated" framing pinned', () => {
    expect(body).toMatch(/API keys remain account-scoped \(shared\) and admin-gated/);
  });

  it('localStorage key ds_web_session_token (customer-dashboard convention)', () => {
    expect(body).toContain('ds_web_session_token');
  });

  it('bounds hydration and serializes invite/remove mutations', () => {
    expect(body).toContain('const TEAM_TIMEOUT_MS = 15_000;');
    expect(body).toContain('const removalButtonsInFlight = new WeakSet();');
    expect(body).toContain('let inviteInFlight = false;');
    expect(body).toMatch(/if \(inviteInFlight\) return;/);
    expect(body).toMatch(/if \(removalButtonsInFlight\.has\(btn\)\) return;/);
    expect(body.match(/boundedFetch\(/g)?.length).toBeGreaterThanOrEqual(5);
    expect(body).toContain('Request took too long. Check your connection and try again.');
    expect(body).toMatch(/setAttribute\('aria-busy', 'true'\)/);
  });

  it('reconciles ambiguous invites before allowing a token-replacing resend', () => {
    expect(body).toContain("timeoutError.name = 'AbortError'");
    expect(body).toContain('Invite outcome is unknown after the request timed out.');
    expect(body).toContain('The pending-invite list was refreshed.');
    expect(body).toContain('resending replaces the first link and sends another email');
    expect(body).toMatch(/const refreshed = await refresh\(false\)/);
  });

  it('per-member-uses-own-login + per-member-dashboard-sessions framing pinned', () => {
    // Load-bearing privacy claim — members never share login
    // credentials. The team page is the only customer surface
    // that promises this; pin so a future refactor can't soften
    // it to "shared login".
    expect(body).toMatch(/Each member uses their own login \+ their\s+own dashboard sessions/);
  });

  it('remove-member uses DELETE on /v1/team/members/:id (mem_ id semantics)', () => {
    // The remove-member fetch sends method: 'DELETE' against the
    // members endpoint — matches /docs/teams "DELETE takes mem_
    // membership id" contract.
    expect(body).toMatch(/\/v1\/team\/members\/'\s*\+\s*encodeURIComponent\(id\)/);
    expect(body).toMatch(/method: 'DELETE'/);
  });
});
