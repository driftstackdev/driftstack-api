// W360.A — drift guard for /docs/teams. V-693 teams developer
// docs. The server-side W219.A guard already pins every endpoint
// against apps/server/src/routes/team.ts; this complementary
// guard pins the surface-level RBAC + audit + restriction claims
// integrators rely on when planning a team rollout.
//
// Pinned:
//   • All 5 team endpoints (POST/GET /v1/team/invites, POST
//     /v1/team/invites/accept, GET /v1/team/members, DELETE
//     /v1/team/members/:id, GET /v1/team/owners) registered
//     server-side.
//   • Both role values (member / admin) match the team_role
//     Postgres enum source-of-truth.
//   • Member-vs-admin write/read split pinned: writes (POST
//     /v1/sessions, /v1/webhooks, rotate-secret) require admin.
//   • X-Driftstack-Account header is the V-330b/d/e/f
//     effective-account contract.
//   • DELETE takes mem_ membership id, NOT acc_ account id
//     (load-bearing distinction; misuse is the most common
//     integration error).
//   • "Acceptance posts plaintext token; there is no
//     /accept-by-id endpoint" + "invite cannot be revoked via
//     API today" expectations pinned.
//   • Admin restrictions: cannot change tier / initiate checkout
//     / manage team / see other members' API keys.
//   • Audit-log cross-link to /docs/audit-log resolves; the
//     exact-match ?action=team.member_invited filter (no wildcards)
//     is the documented read path.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/teams.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/team.ts');
const DB_SCHEMA = resolve(REPO_ROOT, 'apps/server/src/db/schema.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W360.A /docs/teams parity', () => {
  const body = read(PAGE);
  const route = read(ROUTE);
  const dbSchema = read(DB_SCHEMA);

  it('all 5 team endpoints cited are registered server-side', () => {
    for (const cite of [
      'POST /v1/team/invites',
      'GET /v1/team/invites',
      'POST /v1/team/invites/accept',
      'GET /v1/team/members',
      'DELETE /v1/team/members/mem_',
      'GET /v1/team/owners',
    ]) {
      expect(body).toContain(cite);
    }
    for (const r of ["'/v1/team/invites'", "'/v1/team/invites/accept'", "'/v1/team/members'"]) {
      expect(route, `route missing: ${r}`).toContain(r);
    }
  });

  it('role values (member / admin) match the team_role Postgres enum', () => {
    expect(dbSchema).toMatch(/teamRole = pgEnum\('team_role', \['member', 'admin'\]\)/);
    expect(body).toMatch(/<strong>Member<\/strong>/);
    expect(body).toMatch(/<strong>Admin<\/strong>/);
  });

  it('write/read split: writes require admin; members get 403', () => {
    expect(body).toMatch(
      /<strong>reads<\/strong> are allowed for both\s+<code>member<\/code> and <code>admin<\/code>/,
    );
    expect(body).toMatch(
      /<strong>Writes<\/strong>[\s\S]*?require\s+<code>admin<\/code>; members get <code>403<\/code>/,
    );
    // The write examples cited are real endpoints.
    expect(body).toMatch(/<code>POST \/v1\/sessions<\/code>/);
    expect(body).toMatch(/<code>POST \/v1\/webhooks<\/code>/);
    expect(body).toMatch(/<code>POST \/v1\/webhooks\/&lt;id&gt;\/rotate-secret<\/code>/);
  });

  it('X-Driftstack-Account header is the V-326c effective-account contract', () => {
    expect(body).toMatch(/<code>X-Driftstack-Account<\/code>\s+request header/);
    expect(body).toMatch(/server validates the caller has a valid\s+membership/);
  });

  it('DELETE takes mem_ membership id, not acc_ account id (load-bearing distinction)', () => {
    expect(body).toMatch(
      /DELETE route takes the <code>mem_<\/code> membership id, not\s+an <code>acc_<\/code> account id/,
    );
  });

  it('accept-by-plaintext-token + no-API-revoke expectations pinned', () => {
    expect(body).toMatch(/Acceptance posts the <em>plaintext token<\/em> from the email/);
    expect(body).toMatch(
      /there is no <code>\/v1\/team\/invites\/&lt;id&gt;\/accept<\/code>\s+endpoint/,
    );
    expect(body).toMatch(
      /invite row itself can't be revoked via the API\s+today; the invite simply expires/,
    );
  });

  it("admin-cannot-do list pinned (tier / checkout / team mutations / other members' keys)", () => {
    expect(body).toMatch(/Change the owner's <strong>tier<\/strong> or initiate\s+checkout/);
    expect(body).toMatch(/Manage the team itself/);
    expect(body).toMatch(/each member's keys\s+are private to their account/);
  });

  it('audit-trail framing pinned: exact-match team.* action filter on /v1/account/audit-log (no wildcards)', () => {
    // The action filter is exact-match (one action per request, no
    // wildcards). The cited actions are the real audit-log enum values
    // from packages/api-types/src/accounts.ts:
    // team.member_invited / team.invite_accepted / team.member_removed.
    expect(body).toMatch(
      /The <code>action<\/code>\s*filter is exact-match \(one action per request, no wildcards\)/,
    );
    expect(body).toMatch(/<code>GET \/v1\/account\/audit-log\?action=team\.member_invited<\/code>/);
    expect(body).toMatch(/<code>team\.invite_accepted<\/code>/);
    expect(body).toMatch(/<code>team\.member_removed<\/code>/);
    // The old wildcard syntax was never real — ban it.
    expect(body).not.toMatch(/\?action=team\.\*/);
    expect(body).toContain('/docs/audit-log');
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/audit-log.astro')),
    ).toBe(true);
  });

  it('support + developer-contact mailtos pinned', () => {
    expect(body).toContain('mailto:support@driftstack.dev');
    expect(body).toContain('mailto:developers@driftstack.dev');
  });
});
