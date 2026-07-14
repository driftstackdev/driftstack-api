// W783 — apps/docs guides/team-rbac.md content parity. One-hundred-
// ninth in the cross-SDK drift-guard series. Closes the apps/docs/
// guides/ subtree (4/4 covered).
//
// /guides/team-rbac is the end-to-end tutorial for the team flow.
// Drift to the 5-step flow or the role-gating split would mismatch
// W766 /api/team + W768 /api/audit-log + W757 dashboard /team
// surfaces.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/guides/team-rbac.md');

describe('W783 docs /guides/team-rbac content parity', () => {
  it('guides/team-rbac.md file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter title + description pinned.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Team RBAC — invite, accept, act-as\n/,
    );
    expect(p).toMatch(
      /description: End-to-end tutorial for setting up a multi-user team in Driftstack — invite a teammate, accept the invite, act on the owner's resources via X-Driftstack-Account\./,
    );
  });

  it("CRITICAL owner-invites-member full-lifecycle framing pinned. The 'This guide walks through the full lifecycle of a Driftstack team: the **owner** invites a **member**, the member accepts, and the member then runs sessions / manages resources scoped to the owner\\'s account' wording matches W766 /api/team multi-user model.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /This guide walks through the full lifecycle of a Driftstack team:\s*\n?the \*\*owner\*\* invites a \*\*member\*\*, the member accepts, and the\s*\n?member then runs sessions \/ manages resources scoped to the owner's\s*\n?account\./,
    );
  });

  it('CRITICAL 5-step Step heading set pinned. Step 1 Invite + Step 2 Accept + Step 3 See teams + Step 4 Act-as + Step 5 Audit. Drift to dropping a step would break tutorial flow.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/## Step 1 — Invite a teammate \(owner\)/);
    expect(p).toMatch(/## Step 2 — Accept the invite \(teammate\)/);
    expect(p).toMatch(/## Step 3 — See the team you're on \(member\)/);
    expect(p).toMatch(/## Step 4 — Act on the owner's resources \(member, admin role\)/);
    expect(p).toMatch(/## Step 5 — Audit the team's actions \(owner\)/);
  });

  it('CRITICAL 2-role framing — member (read) + admin (read+write) pinned. Matches W766 /api/team + W757 dashboard role-gating split.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`member` — read access to the owner's sessions \/ profiles \/\s*\n?\s+audit log \/ etc\. Cannot make changes\./,
    );
    expect(p).toMatch(
      /`admin` — full read \+ write\. Can create sessions, mint API\s*\n?\s+keys, manage webhooks on the owner's behalf\./,
    );
  });

  it('CRITICAL POST /v1/team/invites curl example pinned. Drift would mismatch W766 /api/team invite body shape ({email, role}).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/curl -X POST https:\/\/api\.driftstack\.dev\/v1\/team\/invites/);
    expect(p).toMatch(/-H "Authorization: Bearer \$DRIFTSTACK_OWNER_KEY"/);
    expect(p).toMatch(/-d '\{"email": "alice@example\.com", "role": "admin"\}'/);
  });

  it('CRITICAL 7-day accept-link framing pinned. Matches W757 dashboard + W766 /api/team 7-day TTL.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/The teammate receives an email with a 7-day accept link\./);
  });

  it("CRITICAL signup-with-invitee-email-must-match framing pinned. The 'using the invitee email address (must match exactly)' wording matches W766 /api/team email-must-match CSRF defense.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The teammate signs up at <https:\/\/app\.driftstack\.dev\/signup\/> using\s*\n?the invitee email address \(must match exactly\), then clicks the\s*\n?accept link from the invite email\./,
    );
    expect(p).not.toMatch(/<https:\/\/app\.driftstack\.dev\/signup>/);
  });

  it('CRITICAL accept POST endpoint + /team/accept page route pinned. Matches W766 /api/team /v1/team/invites/accept.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The link takes them to the dashboard's `\/team\/accept` page; the\s*\n?page calls `POST \/v1\/team\/invites\/accept` with the token from the\s*\n?URL\./,
    );
  });

  it("CRITICAL Acting-as picker localStorage.ds_act_as_account + 3-feature framing pinned. The 'Lists the member\\'s own account (default) + each owner team' + 'Persists the selection to localStorage.ds_act_as_account' + 'Auto-injects X-Driftstack-Account: acc_<owner-uuid> on every subsequent dashboard fetch' wording matches V-331 picker + W757 dashboard /team.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Lists the member's own account \(default\) \+ each owner team\./);
    expect(p).toMatch(/Persists the selection to `localStorage\.ds_act_as_account`\./);
    expect(p).toMatch(
      /Auto-injects `X-Driftstack-Account: acc_<owner-uuid>` on every\s*\n?\s+subsequent dashboard fetch\./,
    );
  });

  it('CRITICAL teams[] array shape pinned in curl example — owner_account_id + role + membership_id. Matches W770 /api/account .teams[] embedding.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/"teams": \[/);
    expect(p).toMatch(/"owner_account_id": "acc_owner-uuid", "role": "admin",/);
    expect(p).toMatch(/"membership_id": "mem_…"/);
  });

  it('CRITICAL /v1/team/owners alternative-endpoint framing pinned. Matches W766 /api/team inverse-view (GET /v1/team/owners) reference.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /# alternative: dedicated read of teams the member is on\s*\n?curl -H "Authorization: Bearer \$MEMBER_KEY" \\\s*\n?\s+https:\/\/api\.driftstack\.dev\/v1\/team\/owners/,
    );
  });

  it("CRITICAL act-as-creates-session counts-owner's-cap framing pinned. The 'create a session OWNED by the team owner; counts against the OWNER\\'s concurrent cap; tier-derived caps use the OWNER\\'s tier' wording matches W769 /api/usage owner-tier-is-cap-source contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /# create a session OWNED by the team owner; counts against the\s*\n?# OWNER's concurrent cap; tier-derived caps use the OWNER's tier\./,
    );
  });

  it('CRITICAL role-gating split — GET = member+admin, POST/PATCH/DELETE/rotate = admin-only framing pinned. Matches W766 /api/team + W757 dashboard role enforcement.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*Read endpoints\*\* \(GET\): both `member` and `admin` allowed\./);
    expect(p).toMatch(
      /\*\*Write endpoints\*\* \(POST \/ PATCH \/ DELETE \/ api-keys rotate\):\s*\n?\s+`admin` role only\. `member` gets `403`\./,
    );
  });

  it('CRITICAL 7-row header-honoring endpoint catalog pinned. Sessions/Profiles/API keys/Webhooks/Audit log/Email preferences/Usage. Matches W766 /api/team header-honoring inventory.', () => {
    const p = read(PAGE);

    for (const resource of [
      'Sessions',
      'Profiles',
      'API keys',
      'Webhooks',
      'Audit log',
      'Email preferences',
      'Usage',
    ]) {
      expect(p, `header-honoring row ${resource}`).toMatch(new RegExp(`\\| ${resource}\\s+\\|`));
    }
  });

  it('CRITICAL 3-endpoint NON-honoring list pinned — /v1/team/* + /v1/account/me + /v1/auth/*. Matches W766 /api/team NON-honoring set.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`\/v1\/team\/\*` — managing your own team is always per-caller\./);
    expect(p).toMatch(
      /`\/v1\/account\/me` — always returns the caller's own profile \+ team\s*\n?\s+list\./,
    );
    expect(p).toMatch(/`\/v1\/auth\/\*` — authentication is per-caller\./);
  });

  it('CRITICAL audit-log shows-who-did-what framing pinned. The \'So the owner sees, in their audit log, "Member alice@example.com (acc_…) created session ses_… on this account at 2026-05-08 14:02 UTC"\' wording matches W768 /api/audit-log actor_account_id team-RBAC framing.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`account_id`: the owner\./);
    expect(p).toMatch(/`actor_account_id`: the member who took the action\./);
    expect(p).toMatch(/`actor_key_id`: the member's API key id\./);
    expect(p).toMatch(
      /So the owner sees, in their audit log, "Member alice@example\.com\s*\n?\(`acc_…`\) created session `ses_…` on this account at 2026-05-08\s*\n?14:02 UTC"\./,
    );
  });

  it('CRITICAL audit-log CSV export 10k-cap cross-reference pinned. Matches W768 /api/audit-log GDPR Article 20 export contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/https:\/\/api\.driftstack\.dev\/v1\/account\/audit-log\/export\?format=csv/);
    expect(p).toMatch(/\(See \[GDPR Article 20 portability\]\(\/api\/audit-log\/#export\)/);
    expect(p).toMatch(/for the export ceiling \+ cursor pagination beyond 10K rows\.\)/);
  });

  it("CRITICAL remove-member-immediate-auth-cache-invalidation framing pinned. The 'The membership row is deleted; the member\\'s auth-cache is invalidated immediately so their X-Driftstack-Account header stops working on the next request. Their own account stays — only the team relationship is severed' wording is the canonical revocation-semantics contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The membership row is deleted; the member's auth-cache is\s*\n?invalidated immediately so their `X-Driftstack-Account` header\s*\n?stops working on the next request\./,
    );
    expect(p).toMatch(/Their own account stays — only\s*\n?the team relationship is severed\./);
  });

  it("CRITICAL member-NOT-separately-notified framing pinned. The 'A team.member_removed audit entry lands on the owner\\'s log; the member is NOT separately notified by Driftstack (the owner can do that via their own channels)' wording is the load-bearing customer-comms boundary.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /A `team\.member_removed` audit entry lands on the owner's log; the\s*\n?member is NOT separately notified by Driftstack \(the owner can do\s*\n?that via their own channels\)\./,
    );
  });

  it("CRITICAL multiple-admins + owner-only-invites + owner-implicitly-admin framing pinned. S36 2026-07-07 (fable-truth-audit): the old 'subsequent admins can be invited by any existing admin' claim was IMPOSSIBLE via the API — POST /v1/team/invites requires the account_owner scope and hardcodes ownerAccountId = the caller's own account (routes/team.ts), and no /v1/team/* route reads X-Driftstack-Account; an admin calling invite would create invites for THEIR OWN team.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /A team can have any number of `admin`-role members, but every one\s*\n?of them is invited by the \*\*owner\*\* — `POST \/v1\/team\/invites`\s*\n?requires the `account_owner` scope and always creates invites for\s*\n?the caller's own team/,
    );
    expect(p).toMatch(
      /The owner\s*\n?is always implicitly "admin" on their own team \(no separate\s*\n?membership row\)\./,
    );
    // Negative pin — the impossible any-admin-can-invite claim must not return.
    expect(p).not.toMatch(/can be invited\s*\n?by any existing admin/);
  });

  it('CRITICAL read-only-collaborator 2-use-case framing pinned. Auditors/compliance + junior teammates. Drift to a different rationale would lose the load-bearing customer-use-case framing.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Auditors \/ compliance reviewers \(read the audit log \+ usage\s*\n?\s+reports without write capability\)\./,
    );
    expect(p).toMatch(
      /Junior teammates being onboarded \(read sessions \+ profiles\s*\n?\s+without risk of accidentally minting a key or destroying a\s*\n?\s+session\)\./,
    );
  });

  it("CRITICAL 3-step key-rotation flow pinned — owner rotates + 24h grace + auto-expire after 24h. The 'Teammates calling the rotation endpoint themselves require admin role + X-Driftstack-Account header pointing at the owner' wording matches W762 /api/api-keys + W766 /api/team header-honoring.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/1\. Owner \(or admin member\) rotates → new key, 24h grace on the old\./);
    expect(p).toMatch(/2\. Teammates have 24h to swap deployments to the new key\./);
    expect(p).toMatch(/3\. After 24h the old key auto-expires server-side\./);
    expect(p).toMatch(
      /Teammates calling the rotation endpoint themselves require admin\s*\n?role \+ `X-Driftstack-Account` header pointing at the owner\./,
    );
  });

  it("CRITICAL team-member-separate-Data-Subject framing pinned. The 'A team member is a separate Data Subject from the owner. Their account email is processed under [Privacy §3.1](/legal/privacy/#31-account-data) on the same legal basis as any other Customer contact' wording matches W766 /api/team Privacy §3.1 cross-reference.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /A team member is a separate Data Subject from the owner\. Their\s*\n?account email is processed under \[Privacy §3\.1\]\(https:\/\/driftstack\.dev\/legal\/privacy\/#31-account-data\)\s*\n?on the same legal basis as any other Customer contact\./,
    );
    expect(p).toMatch(
      /Removing the\s*\n?member from the team does not delete their Driftstack account; only\s*\n?the membership relationship\./,
    );
  });

  it('CRITICAL Next-steps 3-link set pinned — /api/team/ + /api/api-keys/ + /webhooks/replay/.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\[\/api\/team\/\]\(\/api\/team\/\)/);
    expect(p).toMatch(/\[\/api\/api-keys\/\]\(\/api\/api-keys\/\)/);
    expect(p).toMatch(/\[\/webhooks\/replay\/\]\(\/webhooks\/replay\/\)/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/docs-pages-guides-team-rbac-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
