// W558.C — drift guard for /docs/architecture/team-roles-taxonomy.md.
// V-142 4-role taxonomy locked. Drift here either weakens the
// owner>admin>member>viewer-additive-inheritance posture, drops the
// team-role-vs-API-key-scope distinction (role gates dashboard;
// scope gates /v1/* HTTP routes), or relaxes the 3-vs-5-role-
// considered-rejected reasoning.
//
//   • V-142. Locked 2026-05-05. Driftstack engineering owner.
//   • 4 roles: owner>admin>member>viewer with additive permission
//     inheritance.
//   • V-079 single-user-account today; multi-seat future work.
//   • V-139 /team UI scaffolded; backend doesn't ship multi-user.
//   • Team-role ↔ API-key-scope distinction: role gates dashboard;
//     scope gates /v1/* HTTP routes.
//   • API key scope enum CLOSED — adding new scope is breaking
//     for strictly-typed SDK consumers (V-220 deprecation cycle).
//   • Backend implementation 5-pillar (DB + Auth + Routes + Email
//     + Customer-dashboard).
//   • Why-4-not-3-or-5: viewer-stakeholder vs billing-only ruled out.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/architecture/team-roles-taxonomy.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W558.C /docs/architecture/team-roles-taxonomy.md content parity', () => {
  const body = read(LIB);

  it('Header framing pinned: the V-142 lock date, the owner line, the seat inventory (Solo/Starter 1, Team 5, Agency 15, API ladder 5+), and an audience line that now says multi-seat SHIPPED. V-822 rewrote two clauses this case used to quote — that the backend did not yet ship multi-user accounts, and that the /team UI already surfaced four roles. Both were false and both are banned by sentinels below', () => {
    expect(body).toMatch(/^# Team roles taxonomy$/m);
    expect(body).toMatch(
      /\*\*Status:\*\* locked as of V-142 \(2026-05-05\) per founder DECISION 5 in/,
    );
    expect(body).toMatch(/the overnight directive\./);
    expect(body).toMatch(/\*\*Owner:\*\* Driftstack engineering\./);
    expect(body).toMatch(
      /\*\*Audience:\*\* engineers working on multi-seat account support, which has/,
    );
    expect(body).toMatch(/a live `apps\/customer-dashboard\/src\/pages\/team\.astro`/);
    expect(body).toMatch(
      /SHIPPED — `team_members` \+ `team_invites` in the schema, six routes under/,
    );
    // V-822 SENTINEL — multi-seat shipped; the header may not say it has not.
    expect(body, 'multi-seat is implemented').not.toMatch(
      /\*\*Audience:\*\*[\s\S]{0,200}backend doesn't yet ship multi-user accounts/,
    );
    expect(body).toMatch(/Solo Manual \+ API/);
    expect(body).toMatch(
      /Starter are 1-seat; Team Manual = 5 seats; Agency Manual = 15 seats; API/,
    );
    expect(body).toMatch(/ladder includes 5\+ seats per tier\./);
    expect(body).toMatch(/`\/team` UI scaffolded in V-139 surfaces the roles that exist/);
    // V-822 SENTINEL — the dashboard's role picker offers Member and Admin only.
    expect(body, 'the /team UI does not surface four roles').not.toMatch(
      /surfaces the four-role taxonomy already/,
    );
  });

  it("4-role hierarchy + additive-inheritance framing pinned: '## The four roles' + 'owner > admin > member > viewer' + 'Each role inherits the role below it; permissions are additive.' + '### Owner' + 'The single authoritative principal on the account. Created automatically' + 'at signup; transferable on request via support workflow.' + 'Manage billing — change plan, payment method, cancel subscription.' + 'Invite + remove team members.' + 'Change member roles' + 'Transfer ownership.' + 'Delete the account (hard-delete cascade per /settings danger-zone).' + 'There is exactly one owner per account.' + 'There is no \"ownerless\" state.' — pinned so the 4-role-hierarchy + additive-inheritance + owner-5-permission + exactly-one-owner + no-ownerless-state commitment survives", () => {
    expect(body).toMatch(/## The four roles/);
    expect(body).toMatch(/owner > admin > member > viewer/);
    expect(body).toMatch(/Each role inherits the role below it; permissions are additive\./);
    expect(body).toMatch(/### Owner/);
    expect(body).toMatch(
      /The single authoritative principal on the account\. Created automatically/,
    );
    expect(body).toMatch(/at signup; transferable on request via support workflow\./);
    expect(body).toMatch(/- Manage billing — change plan, payment method, cancel subscription\./);
    expect(body).toMatch(/- Invite \+ remove team members\./);
    expect(body).toMatch(/- Change member roles/);
    expect(body).toMatch(/- Transfer ownership\./);
    expect(body).toMatch(
      /- Delete the account \(hard-delete cascade per \/settings danger-zone\)\./,
    );
    expect(body).toMatch(/There is exactly one owner per account\./);
    expect(body).toMatch(/There is no "ownerless" state\./);
  });

  it("Admin + Member + Viewer 3-role framing pinned: '### Admin' + 'Full operational control over the account's product surface' + 'Create + revoke API keys with any scope (including the `admin`' + 'scope on individual keys — the ApiKeyScope `admin` is distinct from' + 'the team role `admin`' + 'Manage webhook endpoints (create, edit, delete, view DLQ).' + 'Admins cannot:' + 'Manage billing.' + 'Invite or remove members.' + 'Change roles.' + '### Member' + 'Default role for invited team members.' + 'Create + drive sessions.' + 'Use their personal API keys (created by an admin).' + 'Members cannot:' + 'Create API keys (admins mint them).' + '### Viewer' + 'Read-only access for stakeholders monitoring usage + billing' + 'Useful for finance / procurement /' + 'compliance team members' + 'Viewers cannot:' + 'Create or modify any resource.' + 'Drive sessions in the GUI client (the GUI client requires `gui_control`' + 'scope on an API key' — pinned so the admin-ApiKeyScope-vs-team-role-distinction + 3-admin-cannot + member-default + members-can't-create-API-keys + viewer-stakeholder + gui_control-scope-required commitment survives", () => {
    expect(body).toMatch(/### Admin/);
    expect(body).toMatch(/Full operational control over the account's product surface/);
    expect(body).toMatch(/- Create \+ revoke API keys with any scope \(including the `admin`/);
    expect(body).toMatch(/scope on individual keys — the ApiKeyScope `admin` is distinct from/);
    expect(body).toMatch(/the team role `admin`/);
    expect(body).toMatch(/- Manage webhook endpoints \(create, edit, delete, view DLQ\)\./);
    expect(body).toMatch(/Admins cannot:/);
    expect(body).toMatch(/- Manage billing\./);
    expect(body).toMatch(/- Invite or remove members\./);
    expect(body).toMatch(/- Change roles\./);
    expect(body).toMatch(/### Member/);
    expect(body).toMatch(/Default role for invited team members\./);
    expect(body).toMatch(/- Create \+ drive sessions\./);
    expect(body).toMatch(/- Use their personal API keys \(created by an admin\)\./);
    expect(body).toMatch(/Members cannot:/);
    expect(body).toMatch(/- Create API keys \(admins mint them\)\./);
    expect(body).toMatch(/### Viewer/);
    expect(body).toMatch(/Read-only access for stakeholders monitoring usage \+ billing/);
    expect(body).toMatch(/Useful for finance \/ procurement \//);
    expect(body).toMatch(/compliance team members/);
    expect(body).toMatch(/Viewers cannot:/);
    expect(body).toMatch(/- Create or modify any resource\./);
    expect(body).toMatch(
      /- Drive sessions in the GUI client \(the GUI client requires `gui_control`/,
    );
    expect(body).toMatch(/scope on an API key/);
  });

  it("API-key-scope ↔ team-role mapping + closed-scope-enum framing pinned. V-822 REPLACED the layer-split sentence this case used to quote: team roles gate /v1/* as well as the dashboard, so the old wording would have an engineer skip the role check on a new route. Still pinned: '## API key scope ↔ team role mapping' + '| API key scope | Team roles allowed to mint a key with this scope |' + '| `read`        | owner, admin' + '| `write`       | owner, admin' + '| `admin`       | owner, admin' + '| `gui_control` | owner, admin' + 'Members + viewers don't mint API keys — they use keys an admin minted' + 'The scope enum itself is closed; adding a new scope is a breaking' + 'change for strictly-typed SDK consumers and triggers the deprecation' + 'cycle.' + '`docs/architecture/api-versioning.md` (V-220) §' + '\"Per-resource versioning notes — `/v1/api-keys/*`\"' + 'breaking-change taxonomy and the path V-174 took when expanding scopes.' — pinned so the role-gates-dashboard-scope-gates-routes + 4-scope-mint-table (all-owner-admin) + members-don't-mint + closed-scope-enum-breaking + V-220-V-174 commitment survives", () => {
    expect(body).toMatch(/## API key scope ↔ team role mapping/);
    expect(body).toMatch(/\*\*API key scopes\*\* gate `\/v1\/\*` HTTP routes, and/);
    expect(body).toMatch(
      /\*\*team roles gate them too\*\* — the two compose, they are not split by/,
    );
    // V-822 — the correction must carry the mechanism, not just the verdict:
    // writes on another account need admin, reads do not.
    expect(body).toMatch(/\*\*Writes on another account require the `admin` role\*\*/);
    expect(body).toMatch(/\*\*reads are role-agnostic\*\*/);
    // SENTINEL — the retired split. Thirteen route modules resolve team
    // membership; an engineer reading the old sentence writes a scope check,
    // skips the role check, and ships a hole.
    expect(body, 'team roles gate /v1/* too').not.toMatch(
      /team roles\*\* gate dashboard UI access/,
    );
    expect(body).toMatch(/\| API key scope \| Team roles allowed to mint a key with this scope \|/);
    expect(body).toMatch(/\| `read`\s+\| owner, admin/);
    expect(body).toMatch(/\| `write`\s+\| owner, admin/);
    expect(body).toMatch(/\| `admin`\s+\| owner, admin/);
    expect(body).toMatch(/\| `gui_control` \| owner, admin/);
    expect(body).toMatch(/Members \+ viewers don't mint API keys — they use keys an admin minted/);
    expect(body).toMatch(/The scope enum itself is closed; adding a new scope is a breaking/);
    expect(body).toMatch(/change for strictly-typed SDK consumers and triggers the deprecation/);
    expect(body).toMatch(/cycle\./);
    expect(body).toMatch(/`docs\/architecture\/api-versioning\.md` \(V-220\) §/);
    expect(body).toMatch(/"Per-resource versioning notes — `\/v1\/api-keys\/\*`"/);
    expect(body).toMatch(
      /breaking-change taxonomy and the path V-174 took when expanding scopes\./,
    );
  });

  it("Backend implementation sketch pinned AS HISTORY. V-822 re-headed the section and added a correction above it, because multi-seat shipped with a different shape than the sketch describes; the sketch text below is kept verbatim and still pinned. Formerly: '## Backend implementation notes (forward-looking)' + 'V-079 auth-flow schema only models single-user accounts today' + '(`accounts` table 1:1 with `users` table)' + '**Database**: a `team_members` table joining `accounts` to' + '`users` with a `role: enum('owner', 'admin', 'member', 'viewer')`' + 'column + `invited_at` + `joined_at` + `invited_by_user_id`.' + '**Auth**: `AccountContext` extends to carry the calling user's' + 'role via the API key's owning user.' + '**Routes**:' + '`POST /v1/team/invite` (owner-only)' + '`POST /v1/team/accept`' + '`GET /v1/team/members`' + '`PATCH /v1/team/members/:id/role` (owner-only)' + '`DELETE /v1/team/members/:id` (owner-only)' + '**Email**: 2 new transactional templates — invite + role-change-' + 'notification. Postmark template ids per V-052 sub-processor list.' + '**Customer dashboard**: `/team` page wires to the live endpoints' — pinned so the V-079-1:1-accounts-users + 5-pillar-backend (DB + Auth + Routes + Email + Customer-dashboard) + 5-team-route + 2-email-template + V-052-Postmark commitment survives", () => {
    expect(body).toMatch(/## Backend implementation notes \(SHIPPED — see the correction below\)/);
    // V-822 — the sketch below is KEPT VERBATIM as the record of what was
    // planned, so the assertions that follow still pass and no sentinel bans
    // its text. What must be present is the correction ABOVE it; without that,
    // a reader takes the sketch for a description of the running system.
    expect(body).toMatch(/> \*\*V-822\.\*\* This section was headed "forward-looking"/);
    expect(body).toMatch(/NOT to a `users` table, which does not exist in this schema/);
    expect(body).toMatch(/The original forward-looking sketch, verbatim:/);
    expect(body).toMatch(/V-079 auth-flow schema only models single-user accounts today/);
    expect(body).toMatch(/\(`accounts` table 1:1 with `users` table\)/);
    expect(body).toMatch(/1\. \*\*Database\*\*: a `team_members` table joining `accounts` to/);
    expect(body).toMatch(/`users` with a `role: enum\('owner', 'admin', 'member', 'viewer'\)`/);
    expect(body).toMatch(/column \+ `invited_at` \+ `joined_at` \+ `invited_by_user_id`\./);
    expect(body).toMatch(/2\. \*\*Auth\*\*: `AccountContext` extends to carry the calling user's/);
    expect(body).toMatch(/role via the API key's owning user\./);
    expect(body).toMatch(/3\. \*\*Routes\*\*:/);
    expect(body).toMatch(/- `POST \/v1\/team\/invite` \(owner-only\)/);
    expect(body).toMatch(/- `POST \/v1\/team\/accept`/);
    expect(body).toMatch(/- `GET \/v1\/team\/members`/);
    expect(body).toMatch(/- `PATCH \/v1\/team\/members\/:id\/role` \(owner-only\)/);
    expect(body).toMatch(/- `DELETE \/v1\/team\/members\/:id` \(owner-only\)/);
    expect(body).toMatch(
      /4\. \*\*Email\*\*: 2 new transactional templates — invite \+ role-change-/,
    );
    expect(body).toMatch(/notification\. Postmark template ids per V-052 sub-processor list\./);
    expect(body).toMatch(
      /5\. \*\*Customer dashboard\*\*: `\/team` page wires to the live endpoints/,
    );
  });

  it("Why-4-not-3-or-5 framing pinned: '## Why 4 roles, not 3 or 5' + 'Considered alternatives:' + '**3 roles (owner / admin / member)** — simpler but loses the' + 'read-only \"stakeholder\" use case.' + 'Finance team members who need' + 'invoice + usage visibility shouldn't have the ability to create' + 'sessions; viewer-as-distinct fixes that.' + '**5 roles (owner / admin / billing-only / member / viewer)** —' + 'considered a billing-only role for finance.' + 'Ruled out: viewer' + 'already covers \"read billing\"; carving out a separate billing-only' + 'role adds permission-matrix surface without proportional benefit.' + 'The 4-role taxonomy is the locked design as of V-142. Future' + 'expansion (e.g. \"developer\" role for code-only access without' + 'profile management) is possible but not currently scheduled.' — pinned so the 3-role-loses-stakeholder + 5-role-billing-only-ruled-out + viewer-covers-read-billing + V-142-locked + developer-role-future commitment survives", () => {
    expect(body).toMatch(/## Why 4 roles, not 3 or 5/);
    expect(body).toMatch(/Considered alternatives:/);
    expect(body).toMatch(/- \*\*3 roles \(owner \/ admin \/ member\)\*\* — simpler but loses the/);
    expect(body).toMatch(/read-only "stakeholder" use case\./);
    expect(body).toMatch(/Finance team members who need/);
    expect(body).toMatch(/invoice \+ usage visibility shouldn't have the ability to create/);
    expect(body).toMatch(/sessions; viewer-as-distinct fixes that\./);
    expect(body).toMatch(
      /- \*\*5 roles \(owner \/ admin \/ billing-only \/ member \/ viewer\)\*\* —/,
    );
    expect(body).toMatch(/considered a billing-only role for finance\./);
    expect(body).toMatch(/Ruled out: viewer/);
    expect(body).toMatch(/already covers "read billing"; carving out a separate billing-only/);
    expect(body).toMatch(/role adds permission-matrix surface without proportional benefit\./);
    expect(body).toMatch(/The 4-role taxonomy is the locked design as of V-142\. Future/);
    expect(body).toMatch(/expansion \(e\.g\. "developer" role for code-only access without/);
    expect(body).toMatch(/profile management\) is possible but not currently scheduled\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
