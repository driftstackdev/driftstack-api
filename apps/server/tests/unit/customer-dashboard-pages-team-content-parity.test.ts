// W495.C — drift guard for apps/customer-dashboard/src/pages/team.astro.
// V-298c + V-326a–V-326e6 team-management page. Drift here either
// drops the role-gating framing (customers wouldn't know that
// member-role can read but admin is required for writes) or breaks
// the invite-accept-while-signed-in flow (invitees would land on a
// broken accept page if they're signed in as a different email).
//
//   • V-298c / V-326e wiring framing pinned.
//   • Role gating: 'reads accept both member and admin; writes
//     require admin'.
//   • GET /v1/team/members + GET /v1/team/invites parallel
//     Promise.all.
//   • POST /v1/team/invites (admin + member roles).
//   • DELETE /v1/team/members/:id remove with window.confirm.
//   • 7-day accept-link + same-email-required framing.
//   • Loading-state '<li>Loading…' placeholders.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/team.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W495.C apps/customer-dashboard/src/pages/team.astro content parity', () => {
  const body = read(LIB);

  it("V-298c / V-326e framing pinned: 'wires the page to the live /v1/team/* endpoints. Members view shows confirmed memberships; pending invites surfaced below. Invite form posts to POST /v1/team/invites; remove posts DELETE /v1/team/members/:id.' — pinned so the 2-endpoint read pattern (members + invites separately) + the explicit endpoint mapping for invite/remove survives (drift to a single endpoint would lose the 'pending vs confirmed' separation)", () => {
    expect(body).toMatch(
      /\/\/ V-298c \/ V-326e — wires the page to the live \/v1\/team\/\* endpoints\.\s*\n?\s*\/\/ Members view shows confirmed memberships; pending invites surfaced\s*\n?\s*\/\/ below\. Invite form posts to POST \/v1\/team\/invites; remove posts\s*\n?\s*\/\/ DELETE \/v1\/team\/members\/:id\./,
    );
  });

  it('V-326a–V-326e6 auth integration framing pinned: \'Members can act on the owner\'s resources via the X-Driftstack-Account header; the V-331 picker handles toggling. Reads accept both "member" and "admin" roles; writes require "admin".\' — pinned so the role-gating asymmetry (member-read + admin-write) stays explicit (drift to hiding would surprise members who try to write and get 403\'d without explanation)', () => {
    expect(body).toMatch(
      /\/\/ Auth integration: V-326a–V-326e6 closed the cycle\. Members can act\s*\n?\s*\/\/ on the owner's resources via the X-Driftstack-Account header; the\s*\n?\s*\/\/ V-331 picker handles toggling\. Reads accept both 'member' and\s*\n?\s*\/\/ 'admin' roles; writes require 'admin'\./,
    );
  });

  it("Members + invites Promise.all parallel fetch: GET /v1/team/members + GET /v1/team/invites with authorization Bearer header — pinned so the two reads stay parallel (drift to sequential would double the page-load latency for accounts with many members) + the Bearer-token pattern matches the rest of the dashboard's authedFetch convention", () => {
    expect(body).toMatch(
      /Promise\.all\(\[\s*\n?\s*fetch\(apiBaseUrl \+ '\/v1\/team\/members', \{\s*\n?\s*headers: \{ authorization: 'Bearer ' \+ token \},\s*\n?\s*\}\)\.then\(function \(r\) \{\s*\n?\s*if \(!r\.ok\) throw new Error\('members HTTP ' \+ r\.status\);\s*\n?\s*return r\.json\(\);\s*\n?\s*\}\),\s*\n?\s*fetch\(apiBaseUrl \+ '\/v1\/team\/invites', \{/,
    );
  });

  it("POST /v1/team/invites contract: body:{email, role} + 202-accepted-OR-r.ok success + r.status !== 202 error branch — pinned so the invite endpoint's 'accepted-but-pending-confirmation' 202 status maps to success (drift to requiring 200 would surface the 202 as an error to the customer when the invite was actually accepted)", () => {
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/team\/invites', \{\s*\n?\s*method: 'POST',\s*\n?\s*headers: \{\s*\n?\s*authorization: 'Bearer ' \+ token,\s*\n?\s*'content-type': 'application\/json',\s*\n?\s*\},\s*\n?\s*body: JSON\.stringify\(\{ email: email, role: role \}\),\s*\n?\s*\}\)/,
    );
    expect(body).toMatch(/if \(!r\.ok && r\.status !== 202\) \{/);
  });

  it("DELETE /v1/team/members/:id contract: encodeURIComponent on id + 204-or-r.ok success + window.confirm before fire — pinned so customers can't accidentally remove a team-mate (confirm-required) + the server's 204 success path maps correctly (drift to requiring 200 would mark valid removals as failures)", () => {
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/team\/members\/' \+ encodeURIComponent\(id\), \{\s*\n?\s*method: 'DELETE',\s*\n?\s*headers: \{ authorization: 'Bearer ' \+ token \},\s*\n?\s*\}\)\s*\n?\s*\.then\(function \(r\) \{\s*\n?\s*if \(!r\.ok && r\.status !== 204\) throw new Error\('HTTP ' \+ r\.status\);/,
    );
    expect(body).toMatch(
      /const ok = window\.confirm\(\s*\n?\s*'Remove ' \+\s*\n?\s*email \+\s*\n?\s*' from the team\? They keep their Driftstack account but lose team access\.',\s*\n?\s*\);/,
    );
  });

  it('Invite role <select> 2-option: member (default) / admin — pinned so the role vocabulary stays {member, admin} and the form defaults to the less-privileged role (drift to defaulting admin would let customers accidentally grant write access on every invite; drift to dropping the 2-option enum would couple the form to an undocumented role)', () => {
    expect(body).toMatch(
      /<option value="member">Member<\/option>\s*\n?\s*<option value="admin">Admin<\/option>/,
    );
  });

  it('Role badge styling: admin → bg-blue-50 text-blue-700 / member → bg-slate-100 text-slate-600 — pinned so admin visually pops over member (admins have write power, customers should be able to tell at a glance who can take destructive actions); drift to identical styling would hide the role distinction', () => {
    expect(body).toMatch(
      /m\.role === 'admin' \? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600';/,
    );
  });

  it("Pending invite badge: bg-amber-50 text-amber-700 + uppercase 'pending' — pinned so pending invites have visual urgency (amber = needs action, distinct from member emerald/slate) so admins can see at a glance who hasn't accepted yet", () => {
    expect(body).toMatch(
      /<span class="inline-flex shrink-0 rounded-full bg-amber-50 px-2 py-0\.5 text-xs font-medium uppercase tracking-wide text-amber-700">pending<\/span>/,
    );
  });

  it("7-day accept-link + same-email-required framing pinned: 'Invitees receive an email with a 7-day accept link. They must accept while signed in to the same email address. Once accepted, members can act on this account's resources by toggling the \"Acting as\" picker in the sidebar — reads work for both member and admin roles; writes require admin.' — pinned so the email-matching requirement + 7-day window + the act-as-picker mechanic + the role-gating asymmetry all survive (drift to dropping the same-email rule would let invitees be confused by accept-failures when signed in as a different account)", () => {
    expect(body).toMatch(
      /Invitees receive an email with a 7-day accept link\. They must accept while signed in to the\s*\n?\s*same email address\. Once accepted, members can act on this account's resources by toggling\s*\n?\s*the "Acting as" picker in the sidebar — reads work for both <code>member<\/code> and\s*\n?\s*<code>admin<\/code> roles; writes require <code>admin<\/code>\./,
    );
  });

  it("Remove-button busy-state: btn.disabled = true + btn.textContent = 'Removing…' + restore to 'Remove' on error — pinned so accidental double-clicks don't fire two DELETE calls (which would 404 the second one + display a misleading error) and the button shows visual feedback during the network round-trip", () => {
    expect(body).toMatch(/btn\.disabled = true;\s*\n?\s*btn\.textContent = 'Removing…';/);
    expect(body).toMatch(/btn\.disabled = false;\s*\n?\s*btn\.textContent = 'Remove';/);
  });

  it("No-token member-list state: 'Sign in to see team members.' + 'Sign in to see pending invites.' — pinned so unauthenticated visitors see explicit sign-in prompts in BOTH lists rather than the static 'Loading…' placeholder which would never resolve (drift to silent bail would leave both lists stuck at 'Loading…' indefinitely)", () => {
    expect(body).toMatch(
      /<li class="px-6 py-4 text-sm text-slate-500">Sign in to see team members\.<\/li>/,
    );
    expect(body).toMatch(
      /<li class="px-6 py-4 text-sm text-slate-500">Sign in to see pending invites\.<\/li>/,
    );
  });

  it("Empty-state: members → 'No team members yet. Invite one above.' / invites → 'No pending invites.' — pinned so the two empty states stay distinct (drift to identical copy would lose the 'next step: invite' affordance on the members empty)", () => {
    expect(body).toMatch(/No team members yet\. Invite one above\./);
    expect(body).toMatch(/No pending invites\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
