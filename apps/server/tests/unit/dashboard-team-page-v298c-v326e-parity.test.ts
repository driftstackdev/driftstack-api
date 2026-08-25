// W757 — customer-dashboard /team.astro V-298c + V-326a–V-326e6
// (team RBAC + X-Driftstack-Account header) parity. Eighty-third in
// the cross-SDK drift-guard series.
//
// /team is the only customer surface where the team-RBAC contract
// (member-can-read, admin-can-write) is configured. Drift to the
// role gating framing would let admin-only writes leak to members
// OR force admins through the V-331 picker for read-only views.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/team.astro');

describe('W757 dashboard /team page V-298c + V-326e parity', () => {
  it('team.astro file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL V-298c / V-326e anchor framing pinned. The "wires the page to the live /v1/team/* endpoints. Members view shows confirmed memberships; pending invites surfaced below. Invite form posts to POST /v1/team/invites; remove posts DELETE /v1/team/members/:id." wording threads BOTH the anchor + the route shape.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-298c \/ V-326e — wires the page to the live \/v1\/team\/\* endpoints\./);
    expect(p).toMatch(/Members view shows confirmed memberships; pending invites surfaced/);
    expect(p).toMatch(/below\. Invite form posts to POST \/v1\/team\/invites; remove posts/);
    expect(p).toMatch(/DELETE \/v1\/team\/members\/:id\./);
  });

  it('CRITICAL V-326a-V-326e6 cycle-closed framing pinned. The "Auth integration: V-326a–V-326e6 closed the cycle. Members can act on the owner\'s resources via the X-Driftstack-Account header; the V-331 picker handles toggling." wording is the load-bearing team-RBAC architecture anchor.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-326a–V-326e6 closed the cycle\. Members can act/);
    expect(p).toMatch(/on the owner's resources via the X-Driftstack-Account header; the/);
    expect(p).toMatch(/V-331 picker handles toggling\./);
  });

  it("CRITICAL member-vs-admin RBAC framing pinned. The \"Reads accept both 'member' and 'admin' roles; writes require 'admin'.\" wording is the canonical role-gating contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Reads accept both 'member' and\s*\n\/\/ 'admin' roles; writes require 'admin'/,
    );
  });

  it('CRITICAL footer customer-facing RBAC framing pinned. The "reads work for both member and admin roles; writes require admin" wording on the page footer is the customer-visible version of the role gating contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /reads work for both <code>member<\/code> and\s*\n\s+<code>admin<\/code> roles; writes require <code>admin<\/code>\./,
    );
  });

  it('CRITICAL 2-role invite form set — Member + Admin. Drift to a different role set (e.g. owner / viewer) would diverge from the V-326e server-side enforcement.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/<option value="member">Member<\/option>/);
    expect(p).toMatch(/<option value="admin">Admin<\/option>/);
  });

  it("CRITICAL API-keys-account-scoped framing pinned. The 'Each member uses their own login + their own dashboard sessions; API keys remain account-scoped (shared) and admin-gated.' wording explains the asymmetric model — logins are personal, API keys are shared.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Each member uses their own login \+ their\s*\n\s+own dashboard sessions; API keys remain account-scoped \(shared\) and admin-gated\./,
    );
  });

  it("CRITICAL 7-day accept-link framing pinned. The 'Invitees receive an email with a 7-day accept link. They must accept while signed in to the same email address.' framing tells customers the invite TTL + the same-email requirement.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Invitees receive an email with a 7-day accept link\. They must accept while signed in to the\s*\n\s+same email address\./,
    );
  });

  it("CRITICAL act-as picker cross-reference pinned. The 'Once accepted, members can act on this account\\'s resources by toggling the \"Acting as\" picker in the sidebar' wording threads the V-331 sidebar picker.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Once accepted, members can act on this account's resources by toggling\s*\n\s+the "Acting as" picker in the sidebar/,
    );
  });

  it('CRITICAL deadline-bound parallel /v1/team/members + /v1/team/invites lifecycle pins abort and generation authority.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/const TEAM_TIMEOUT_MS = 15_000;/);
    expect(p).toMatch(
      /window\.driftstackFetchWithDeadline\(url, init, TEAM_TIMEOUT_MS, controller\)/,
    );
    expect(p).toMatch(/const generation = \+\+refreshGeneration;/);
    expect(p).toMatch(/refreshControllers\.forEach\(function \(controller\) \{/);
    expect(p).toMatch(/boundedFetch\(\s*\n\s+apiBaseUrl \+ '\/v1\/team\/members'/);
    expect(p).toMatch(/boundedFetch\(\s*\n\s+apiBaseUrl \+ '\/v1\/team\/invites'/);
    expect(p).toMatch(/Promise\.all\(\[/);
    expect(p).toMatch(/if \(generation !== refreshGeneration\) return false;/);
    expect(p).toMatch(/'members HTTP ' \+ r\.status/);
    expect(p).toMatch(/'invites HTTP ' \+ r\.status/);
    expect(p).not.toMatch(/fetch\(apiBaseUrl \+ '\/v1\/team\//);
  });

  it('CRITICAL POST /v1/team/invites body shape — { email, role }. Drift to a different field name would break the V-326e invite flow.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/team\/invites', \{\s*\n\s+method: 'POST',\s*\n\s+headers: \{\s*\n\s+authorization: 'Bearer ' \+ token,\s*\n\s+'content-type': 'application\/json',\s*\n\s+\},\s*\n\s+body: JSON\.stringify\(\{ email: email, role: role \}\),/,
    );
  });

  it('CRITICAL invite-success treats 202 Accepted as success path. Drift to a 200-only check would treat the 202 (queued for email send) as an error.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/if \(!r\.ok && r\.status !== 202\) \{/);
  });

  it('CRITICAL DELETE /v1/team/members/<id> + 204-or-error handling. Drift to a 200-only check would let the 204-on-success response trigger a false-positive error path.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/team\/members\/' \+ encodeURIComponent\(id\), \{\s*\n\s+method: 'DELETE',/,
    );
    expect(p).toMatch(
      /if \(!r\.ok && r\.status !== 204\) throw new Error\('HTTP ' \+ r\.status\);/,
    );
  });

  it("CRITICAL remove-confirm framing pinned — 'They keep their Driftstack account but lose team access.' Drift to omitting the 'keep their account' clarification would let customers think they're deleting the user.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /'Remove ' \+\s*\n\s+email \+\s*\n\s+' from the team\? They keep their Driftstack account but lose team access\.',/,
    );
  });

  it('CRITICAL member-row admin-role badge color contrast pinned. admin → bg-tk-accent/10 text-tk-accent-text (S23 2026-07-06 AA text tone); member → bg-tk-surface/text-tk-ink-2. Drift to identical styling would lose the visual role distinction. Fleet v2 (2026-07-03) moved admin onto the two-axis accent token (was hard-coded blue-50/blue-700) so the badge renders in light mode.', () => {
    const p = read(PAGE);

    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(p).toMatch(
      /m\.role === 'admin' \? 'bg-tk-accent\/10 text-tk-accent-text' : 'bg-tk-surface text-tk-ink-2'/,
    );
  });

  it("CRITICAL pending-invite row shows 'invited' + 'expires' dates. Drift to dropping the expires would lose customer visibility of the 7-day TTL.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Invited ' \+\s*\n\s+escapeHtml\(fmtIsoDay\(inv\.created_at\)\) \+\s*\n\s+' · expires ' \+\s*\n\s+escapeHtml\(fmtIsoDay\(inv\.expires_at\)\)/,
    );
  });

  it('CRITICAL pending badge uses bg-tk-accent-wash/text-tk-accent-text color contrast (S23 2026-07-06 AA text tone). The brand-color pending state is visually distinct from the gray empty state.', () => {
    const p = read(PAGE);

    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(p).toMatch(
      /'<span class="inline-flex shrink-0 rounded-full bg-tk-accent\/10 px-2 py-0\.5 text-xs font-medium uppercase tracking-wide text-tk-accent-text">pending<\/span>'/,
    );
  });

  it('CRITICAL invite errors use the shared structured response and stable request classifiers.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/throw window\.driftstackResponseError\(r, b\);/);
    expect(p).toMatch(
      /window\.driftstackRequestErrorMessage\(\s*\n\s+err,\s*\n\s+'Could not send the invite\. Try again\.',/,
    );
    expect(p).toMatch(/if \(inviteInFlight\) return;/);
    expect(p).toMatch(/inviteSubmit\.textContent = 'Sending…';/);
  });

  it('CRITICAL no-token branches show distinct messages for members vs invites lists. Drift to a single banner would force customers to scroll between two identical messages.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /'<li class="px-6 py-4 text-sm text-tk-ink-3">Sign in to see team members\.<\/li>'/,
    );
    expect(p).toMatch(
      /'<li class="px-6 py-4 text-sm text-tk-ink-3">Sign in to see pending invites\.<\/li>'/,
    );
  });

  it("CRITICAL empty-list framing distinct per section (2026-05-29 polished icon+headline+body via emptyState()) — members headline 'No team members yet' + 'Invite one above…' body vs invites 'No pending invites' + 'Invitations you send…' body. Drift to a single message would erode the section's individual identity.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/'No team members yet',\s*'Invite one above to collaborate/);
    expect(p).toMatch(/'No pending invites',\s*'Invitations you send will appear here/);
  });

  it('CRITICAL escapeHtml() 5-char XSS guard pinned in inline-script. Email + id flow through it.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/if \(c === '&'\) return '&amp;'/);
    expect(p).toMatch(/if \(c === '<'\) return '&lt;'/);
    expect(p).toMatch(/if \(c === '>'\) return '&gt;'/);
    expect(p).toMatch(/if \(c === '"'\) return '&quot;'/);
    expect(p).toMatch(/return '&#39;'/);
  });

  it('CRITICAL docs.driftstack.dev/api/team cross-reference link pinned. Drift to dropping would force customers to search for the role-gating reference.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /<a href="https:\/\/docs\.driftstack\.dev\/api\/team\/" class="text-tk-accent-text underline" target="_blank" rel="noopener noreferrer">docs\.driftstack\.dev\/api\/team<\/a>/,
    );
    expect(p).not.toMatch(/href="https:\/\/docs\.driftstack\.dev\/api\/team"/);
  });

  it('CRITICAL resolveApiBaseUrl + DashboardLayout used.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/import \{ resolveApiBaseUrl \} from '\.\.\/lib\/api-base-url'/);
    expect(p).toMatch(/const apiBaseUrl = resolveApiBaseUrl\(\)/);
    expect(p).toMatch(/<DashboardLayout title="Team">/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/dashboard-team-page-v298c-v326e-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
