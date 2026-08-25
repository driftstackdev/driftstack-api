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
      /\/\/ V-298c \/ V-326e — wires the page to the live \/v1\/team\/\* endpoints\.\s*\/\/ Members view shows confirmed memberships; pending invites surfaced\s*\/\/ below\. Invite form posts to POST \/v1\/team\/invites; remove posts\s*\/\/ DELETE \/v1\/team\/members\/:id\./,
    );
  });

  it('V-326a–V-326e6 auth integration framing pinned: \'Members can act on the owner\'s resources via the X-Driftstack-Account header; the V-331 picker handles toggling. Reads accept both "member" and "admin" roles; writes require "admin".\' — pinned so the role-gating asymmetry (member-read + admin-write) stays explicit (drift to hiding would surprise members who try to write and get 403\'d without explanation)', () => {
    expect(body).toMatch(
      /\/\/ Auth integration: V-326a–V-326e6 closed the cycle\. Members can act\s*\/\/ on the owner's resources via the X-Driftstack-Account header; the\s*\/\/ V-331 picker handles toggling\. Reads accept both 'member' and\s*\/\/ 'admin' roles; writes require 'admin'\./,
    );
  });

  it('Members + invites stay parallel, deadline-bounded, and stale-refresh safe', () => {
    expect(body).toMatch(
      /Promise\.all\(\[\s*boundedFetch\(\s*apiBaseUrl \+ '\/v1\/team\/members',\s*\{ headers: \{ authorization: 'Bearer ' \+ token \} \},\s*membersController,\s*\)\.then\(function \(r\) \{\s*if \(!r\.ok\) throw new Error\('members HTTP ' \+ r\.status\);\s*return r\.json\(\);\s*\}\),\s*boundedFetch\(\s*apiBaseUrl \+ '\/v1\/team\/invites',/,
    );
    expect(body).toMatch(/const TEAM_TIMEOUT_MS = 15_000;/);
    expect(body).toMatch(
      /window\.driftstackFetchWithDeadline\(url, init, TEAM_TIMEOUT_MS, controller\)/,
    );
    expect(body).toMatch(/if \(generation !== refreshGeneration\) return false;/);
  });

  it('POST /v1/team/invites stays bounded, serializes the role, maps API errors, and blocks ambiguous retries', () => {
    expect(body).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/team\/invites', \{\s*method: 'POST',\s*headers: \{\s*authorization: 'Bearer ' \+ token,\s*'content-type': 'application\/json',\s*\},\s*body: JSON\.stringify\(\{ email: email, role: role \}\),\s*\}\)/,
    );
    expect(body).toMatch(/if \(!r\.ok && r\.status !== 202\) \{/);
    expect(body).toMatch(/throw window\.driftstackResponseError\(r, b\);/);
    expect(body).toMatch(/if \(inviteInFlight\) return;/);
    expect(body).toMatch(/if \(err && err\.name === 'AbortError'\) \{/);
    expect(body).toMatch(/inviteRetryBlockedEmail = normalizedEmail;/);
  });

  it('DELETE /v1/team/members/:id stays bounded, encoded, confirmed, latched, and reconciles timeout outcomes', () => {
    expect(body).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/team\/members\/' \+ encodeURIComponent\(id\), \{\s*method: 'DELETE',\s*headers: \{ authorization: 'Bearer ' \+ token \},\s*\}\)\s*\.then\(function \(r\) \{\s*if \(!r\.ok && r\.status !== 204\) throw new Error\('HTTP ' \+ r\.status\);/,
    );
    expect(body).toMatch(
      /const ok = await window\.driftstackConfirm\(\s*'Remove ' \+\s*email \+\s*' from the team\? They keep their Driftstack account but lose team access\.',/,
    );
    expect(body).toMatch(/if \(removalButtonsInFlight\.has\(btn\)\) return;/);
    expect(body).toMatch(/const refreshed = await refresh\(false\);/);
    expect(body).toMatch(
      /' is no longer present; removal likely completed, so do not submit it again\.'/,
    );
  });

  it('Invite role <select> 2-option: member (default) / admin — pinned so the role vocabulary stays {member, admin} and the form defaults to the less-privileged role (drift to defaulting admin would let customers accidentally grant write access on every invite; drift to dropping the 2-option enum would couple the form to an undocumented role)', () => {
    expect(body).toMatch(
      /<option value="member">Member<\/option>\s*<option value="admin">Admin<\/option>/,
    );
  });

  it('Role badge styling: admin → bg-tk-accent/10 text-tk-accent-text (S23 2026-07-06 AA text tone) / member → bg-tk-surface text-tk-ink-2 — pinned so admin visually pops over member (admins have write power, customers should be able to tell at a glance who can take destructive actions); drift to identical styling would hide the role distinction. Fleet v2 (2026-07-03) moved admin off the hard-coded blue-50/blue-700 onto the two-axis accent token so the badge renders correctly in light mode.', () => {
    expect(body).toMatch(
      /m\.role === 'admin' \? 'bg-tk-accent\/10 text-tk-accent-text' : 'bg-tk-surface text-tk-ink-2';/,
    );
  });

  it("Pending invite badge: bg-tk-accent/10 text-tk-accent-text (S23 2026-07-06 AA text tone) + uppercase 'pending' — pinned so pending invites have visual urgency (glow-red = needs action, distinct from member emerald/slate) so admins can see at a glance who hasn't accepted yet", () => {
    expect(body).toMatch(
      /<span class="inline-flex shrink-0 rounded-full bg-tk-accent\/10 px-2 py-0\.5 text-xs font-medium uppercase tracking-wide text-tk-accent-text">pending<\/span>/,
    );
  });

  it("7-day accept-link + same-email-required framing pinned: 'Invitees receive an email with a 7-day accept link. They must accept while signed in to the same email address. Once accepted, members can act on this account's resources by toggling the \"Acting as\" picker in the sidebar — reads work for both member and admin roles; writes require admin.' — pinned so the email-matching requirement + 7-day window + the act-as-picker mechanic + the role-gating asymmetry all survive (drift to dropping the same-email rule would let invitees be confused by accept-failures when signed in as a different account)", () => {
    expect(body).toMatch(
      /Invitees receive an email with a 7-day accept link\. They must accept while signed in to the\s*same email address\. Once accepted, members can act on this account's resources by toggling\s*the "Acting as" picker in the sidebar — reads work for both <code>member<\/code> and\s*<code>admin<\/code> roles; writes require <code>admin<\/code>\./,
    );
  });

  it('Remove-button busy state disables and exposes aria-busy while deleting, then restores in finally — pinned so accidental double-clicks cannot fire duplicate DELETE calls and assistive technology receives the in-flight state', () => {
    expect(body).toMatch(
      /btn\.disabled = true;\s*btn\.setAttribute\('aria-busy', 'true'\);\s*btn\.textContent = 'Removing…';/,
    );
    expect(body).toMatch(
      /btn\.disabled = false;\s*btn\.setAttribute\('aria-busy', 'false'\);\s*btn\.textContent = 'Remove';/,
    );
  });

  it("No-token member-list state: 'Sign in to see team members.' + 'Sign in to see pending invites.' — pinned so unauthenticated visitors see explicit sign-in prompts in BOTH lists rather than the static 'Loading…' placeholder which would never resolve (drift to silent bail would leave both lists stuck at 'Loading…' indefinitely)", () => {
    expect(body).toMatch(
      /<li class="px-6 py-4 text-sm text-tk-ink-3">Sign in to see team members\.<\/li>/,
    );
    expect(body).toMatch(
      /<li class="px-6 py-4 text-sm text-tk-ink-3">Sign in to see pending invites\.<\/li>/,
    );
  });

  it("Empty-state (2026-05-29 polished icon+headline+body, consistent with snapshots/recipes): members → headline 'No team members yet' + body 'Invite one above to collaborate…' / invites → headline 'No pending invites' + body 'Invitations you send will appear here…' — pinned so the two empty states stay distinct (drift to identical copy would lose the 'next step: invite' affordance on the members empty) and use the shared emptyState() helper", () => {
    expect(body).toMatch(/function emptyState\(iconPath, headline, body\)/);
    expect(body).toMatch(/'No team members yet',\s*'Invite one above to collaborate/);
    expect(body).toMatch(/'No pending invites',\s*'Invitations you send will appear here/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
