// W768 — apps/docs api/audit-log.md content parity. Ninety-fourth
// in the cross-SDK drift-guard series.
//
// /api/audit-log is the canonical programmatic reference for the
// V-216/V-297 audit + export endpoints. Drift to the 27-action
// catalog or the actor_type/actor_account_id team-RBAC framing
// would mismatch W755 dashboard /audit-log + V-326e enforcement.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/audit-log.md');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts');

describe('W768 docs /api/audit-log content parity', () => {
  it('api/audit-log.md file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter title + description pinned. Description threads list-filters + cursor pagination + CSV/JSON GDPR Article 20 export.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Audit log\n/);
    expect(p).toMatch(
      /description: Programmatic access to the customer audit log — list with filters \+ cursor pagination, plus CSV\/JSON export for GDPR portability\./,
    );
  });

  it("CRITICAL append-only framing + GDPR Article 20 framing pinned. Matches W755 dashboard /audit-log 'append-only' header + 'your data, your file' export framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Every action on your account lands in an append-only audit log:/);
    expect(p).toMatch(
      /export the\s*\n?complete history per the GDPR Article 20 right to data portability\./,
    );
  });

  it('CRITICAL query-params 3-set pinned — limit 1-100 default 50 + cursor + action. Drift to a different bound would let SDK consumers pass invalid limits.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`limit` — page size, 1-100; default 50\./);
    expect(p).toMatch(/`cursor` — pagination token from a prior page's `next_cursor`\./);
    expect(p).toMatch(/`action` — filter to a single action name \(see catalog below\)\./);
  });

  it("CRITICAL 3-actor_type enum — customer/system/staff. Drift to dropping 'staff' would hide admin-recorded events from customers (matches W755 V-398 staff-events framing).", () => {
    const p = read(PAGE);

    expect(p).toMatch(/`customer` — a human action through the dashboard/);
    expect(p).toMatch(/`system` — an automated event \(Stripe-driven tier changes, email/);
    expect(p).toMatch(/`staff` — a Driftstack support-team action against the account/);
  });

  it("CRITICAL actor_account_id NOT-same-as-account_id team-RBAC framing pinned. The 'When a team member acts on the owner\\'s account via the X-Driftstack-Account header, the entry lands on the owner\\'s audit log (account_id = acc_<owner>) but actor_account_id records the member who performed the action (acc_<member>). Owners reading their audit log can therefore see \"who on my team did what\"' wording is the canonical RBAC-aware audit framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /the entry lands on the\s*\n?\*\*owner's\*\* audit log \(`account_id = acc_<owner>`\) but\s*\n?`actor_account_id` records the \*\*member\*\* who performed the\s*\n?action \(`acc_<member>`\)\./,
    );
    expect(p).toMatch(
      /Owners reading their audit log can\s*\n?therefore see "who on my team did what" without separate\s*\n?correlation\./,
    );
  });

  it('CRITICAL actor_key_id key_-or-null shape pinned. The audit read route (account-audit.ts) serializes actor_key_id as `key_${row.actorKeyId}` or null — it is ALWAYS key_-prefixed or null, never a bare wsk_. Web-session dashboard actions record no key id (null). Drift sentinel against the fabricated bare-wsk_ wording.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`actor_key_id` is `key_<key-uuid>` for API-key calls and `null` for\s*\n?web-session calls/,
    );
    // Drift sentinel — the API never returns a bare wsk_-prefixed
    // actor_key_id (it is always key_-prefixed or null). MUST NOT return.
    expect(p).not.toMatch(/synthetic `wsk_<session-uuid>`/);
  });

  it("CRITICAL ip_address + user_agent conditional-redaction framing pinned (corrected 2026-07-01 from a false blanket 'deliberately null' claim — a team member acting on an owner's account via X-Driftstack-Account left the real actor IP in row.ip_address, visible on the owner's own self-view/export; the docs now accurately describe the per-row actor-vs-account redaction rule instead of promising an always-null field).", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`ip_address` and `user_agent` \(top-level fields on the entry\) are\s*\n?populated with the real caller network identity ONLY on rows that\s*\n?are \*\*self-caused\*\*/,
    );
    expect(p).toMatch(
      /Both fields are redacted to `null` — regardless of who is\s*\n?reading — whenever the row is \*\*cross-account-caused\*\*/,
    );
  });

  it('CRITICAL caveat pinned — auth-flow events store issued_from_ip+user_agent in payload as a deliberate exception, with the scrub now IMPLEMENTED (corrected 2026-07-01 from a "TD-audit-payload-scrub queued" framing — the scrub runs at read/export serialization time, no backfill needed). The previous skip pinned `Caveat (V-413)` with the inline V-anchor; the V-413 internal anchor was removed from the customer-rendered copy as a UX cleanup (internal V-anchors should not bleed into docs.driftstack.io pages); the substantive caveat framing survives without it.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*Caveat:\*\* the auth-flow audit events/);
    expect(p).toMatch(
      /`account\.email_verified`, `account\.login`, `account\.logout`,\s*\n?`account\.password_changed`\) currently store `issued_from_ip` \+\s*\n?`user_agent` inside `payload`/,
    );
    expect(p).toMatch(
      /no data backfill\s*\n?needed since the scrub runs at read\/export serialization time\./,
    );
    // Drift-guard: the internal V-413 anchor MUST NOT bleed back
    // into the customer-rendered Caveat line.
    expect(p).not.toMatch(/\*\*Caveat \(V-413\):\*\*/);
  });

  it('CRITICAL 27-action catalog pinned. The 27-row table matches W755 /audit-log dashboard + V-216 server-side enum + V-398 expansions.', () => {
    const p = read(PAGE);

    for (const action of [
      'account.email_verified',
      'account.login',
      'account.logout',
      'account.password_changed',
      'account.mfa_enrolled',
      'account.mfa_disabled',
      'account.recovery_code_used',
      'api_key.minted',
      'api_key.rotated',
      'api_key.revoked',
      'session.created',
      'session.destroyed',
      'profile.created',
      'profile.deleted',
      'profile.exported',
      'profile.imported',
      'subscription.tier_changed',
      'webhook_endpoint.created',
      'webhook_endpoint.updated',
      'webhook_endpoint.deleted',
      'webhook_endpoint.secret_rotated',
      'webhook_delivery.replayed',
      'team.member_invited',
      'team.invite_accepted',
      'team.member_removed',
      'admin.refund_recorded',
      'admin.support_note',
    ]) {
      expect(p, `action ${action}`).toMatch(new RegExp(`\\| \`${action.replace(/\./g, '\\.')}\``));
    }
  });

  // V-726 — removal now revokes the keys the departing member minted on the
  // owner, and the audit entry names them. That payload is the only way an owner
  // can establish afterwards which credentials an offboarding invalidated, so it
  // is a documented contract, not an implementation detail.
  it('V-726 team.member_removed documents its revoked_api_key_ids payload and the pre-attribution caveat', () => {
    const p = read(PAGE);
    expect(p).toMatch(/`team\.member_removed`[^|]*\|[^|]*\|[^|]*revoked_api_key_ids/);
    // The caveat matters as much as the field: an owner must not read an empty
    // list as proof that nothing was left behind.
    expect(p).toMatch(/keys created before this was recorded are not listed/);
  });

  it("CRITICAL account.login payload method 3-enum pinned — password/mfa_totp/mfa_recovery, plus the oauth_callback variant. S36 2026-07-07 (fable-truth-audit): the old 5-enum was FALSE — auth-flows.ts only ever emits method 'password' (:821) or 'mfa_totp'/'mfa_recovery' (:935); magic-link consume emits NO account.login row, password-reset confirm emits account.password_changed {via:'password_reset'}, and the OAuth callback emits account.login with {kind:'oauth_callback', provider, session_id} and no method field.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/`payload\.method` ∈ \{`password`, `mfa_totp`, `mfa_recovery`\}/);
    expect(p).toMatch(
      /OAuth sign-ins land a variant payload `\{ kind: "oauth_callback", provider, session_id \}` with no `method` field\./,
    );
    expect(p).toMatch(/Magic-link sign-ins emit no `account\.login` row/);
    // Negative pins — the retired fictional method values must not come back.
    expect(p).not.toMatch(/`payload\.method` ∈ \{[^}]*`magic_link`/);
    expect(p).not.toMatch(/`payload\.method` ∈ \{[^}]*`password_reset`/);
  });

  it("CRITICAL profile.created 3-creation-paths framing pinned. The 'direct create' / clone ('cloned_from: profile_<uuid>') / restore ('restored_from_snapshot: psnap_<uuid>') 3-row split + 'profile_/psnap_ prefix asymmetry' note is the canonical reference.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/`payload\.cloned_from: "profile_<uuid>"`/);
    expect(p).toMatch(/`payload\.restored_from_snapshot: "psnap_<uuid>"`/);
    expect(p).toMatch(
      /Pre-existing format asymmetry: `cloned_from` uses an internal `profile_` prefix; `restored_from_snapshot` uses the public `psnap_` prefix\./,
    );
  });

  it('CRITICAL profile.exported source_profile_id+source_account_id portability lineage framing pinned. Drift would lose the V-480 export-envelope audit visibility.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Payload carries `source_profile_id` \+ `source_account_id` for portability lineage/,
    );
  });

  it("CRITICAL multi-action-filter-not-supported framing pinned. The '(Multi-action filtering in a single call isn\\'t supported; the dashboard\\'s filter dropdown calls separately and merges client-side when it needs a composite view.)' wording matches W755 dashboard /audit-log V-354 filter implementation.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /\(Multi-action filtering in a single call isn't supported; the\s*\n?dashboard's filter dropdown calls separately and merges client-side\s*\n?when it needs a composite view\.\)/,
    );
  });

  it('CRITICAL cursor walk-every-entry idiomatic example pinned. The while-loop pattern is what SDK consumers copy-paste for paginated export.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/let cursor = null;\nwhile \(true\) \{/);
    expect(p).toMatch(/if \(!page\.next_cursor\) break;\s*\n?\s+cursor = page\.next_cursor;/);
  });

  it('CRITICAL payload-typed-shape reference pinned for 7 critical action types. Drift to dropping the typed-shape callouts would let SDK consumers misjudge payload contracts.', () => {
    const p = read(PAGE);

    // account.login + .recovery_code_used + profile.created (3 variants) + webhook secret_rotated + team.member_invited + subscription.tier_changed + api_key.minted.
    expect(p).toMatch(/\/\/ account\.login/);
    expect(p).toMatch(/\/\/ account\.recovery_code_used/);
    expect(p).toMatch(/\/\/ profile\.created — three creation paths/);
    expect(p).toMatch(/\/\/ webhook_endpoint\.secret_rotated/);
    // Drift-guard: the internal V-359 anchor MUST NOT bleed back
    // into the customer-rendered code-comment example.
    expect(p).not.toMatch(/\/\/ webhook_endpoint\.secret_rotated \(V-359\)/);
    expect(p).toMatch(/\/\/ team\.member_invited/);
    expect(p).toMatch(/\/\/ subscription\.tier_changed/);
    expect(p).toMatch(/\/\/ api_key\.minted/);
  });

  it('CRITICAL webhook_endpoint.secret_rotated payload shape pinned — new_secret_prefix + old_secret_prefix + grace_expires_at. The previous pin asserted bare `new_prefix` / `old_prefix` but the real emit-site at apps/server/src/services/webhooks.ts:516-518 uses the `_secret_` infix. Matches V-359 server-side payload contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/"new_secret_prefix": "whsec_<first-12>",/);
    expect(p).toMatch(/"old_secret_prefix": "whsec_<first-12>",/);
    expect(p).toMatch(/"grace_expires_at": "2026-05-10T00:00:00\.000Z"/);
    // The fictional shorter names must NOT return.
    expect(p).not.toMatch(/"new_prefix":/);
    expect(p).not.toMatch(/"old_prefix":/);
  });

  it('CRITICAL "Consumers should default-handle unknown payload shapes gracefully; new fields are additive" framing pinned. Drift to claiming breaking changes would mismatch versioning policy.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Consumers should default-handle unknown payload\s+shapes\s+gracefully;\s+new fields are additive\./,
    );
  });

  it("CRITICAL export-no-pagination + GDPR-Article-20 framing pinned. The 'Returns the FULL audit-log history for the calling account as a single download (no pagination). Used for GDPR Article 20 portability — customer takes their compliance record off the platform' wording is the load-bearing export contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Returns the FULL audit-log history for the calling account as a\s*\n?single download \(no pagination\)\. Used for GDPR Article 20\s*\n?portability — customer takes their compliance record off the\s*\n?platform\./,
    );
  });

  it('CRITICAL export response headers pinned — Content-Type csv|json + Content-Disposition attachment; filename="driftstack-audit-log-<YYYY-MM-DD>.{ext}". S36 2026-07-07 (fable-truth-audit): the route builds filenameBase = `driftstack-audit-log-${new Date().toISOString().slice(0, 10)}` (routes/account-audit.ts:192); the old "audit-log.{ext}" claim never matched.', () => {
    const p = read(PAGE);
    const route = read(ROUTE);

    expect(p).toMatch(/`Content-Type` — `text\/csv` or `application\/json`/);
    expect(p).toMatch(
      /`Content-Disposition` —\s*`attachment; filename="driftstack-audit-log-<YYYY-MM-DD>\.\{ext\}"`/,
    );
    // Cross-source: the server really builds that filename base.
    expect(route).toMatch(
      /filenameBase = `driftstack-audit-log-\$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}`/,
    );
    expect(p).not.toMatch(/filename="audit-log\.\{ext\}"/);
  });

  it("CRITICAL 10,000-row cap framing pinned. Matches W755 dashboard /audit-log 'Exports cap at 10,000 rows per file' framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Cap: 10,000 rows per file\. Older entries remain accessible via the\s*\n?paginated read endpoint above\./,
    );
  });

  it('CRITICAL CSV-columns 9-field set pinned — timestamp/action/actor_type/actor_account_id/actor_key_id/target_resource_id/ip_address/user_agent/payload. Must match the server CSV header (account-audit.ts) so SDK consumer parsers stay aligned; the doc previously listed a fictional `id` + `payload_json` and omitted ip_address/user_agent.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /CSV columns \(in order\): `timestamp`, `action`, `actor_type`,\s*\n?`actor_account_id`, `actor_key_id`, `target_resource_id`, `ip_address`,\s*\n?`user_agent`, `payload`\./,
    );
    // The fictional columns must not return.
    expect(p).not.toMatch(/CSV columns.*`id`/s);
    expect(p).not.toMatch(/`payload_json`/);
  });

  it('CRITICAL JSON-envelope shape pinned — generated_at + account_id + row_count + truncated + data[]. The truncated flag is the load-bearing 10k-cap discriminator.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/"generated_at": "2026-05-09T18:00:00Z"/);
    expect(p).toMatch(/"account_id": "acc_abc"/);
    expect(p).toMatch(/"row_count": 142/);
    expect(p).toMatch(/"truncated": false/);
    expect(p).toMatch(
      /The `truncated` flag is `true` when the row count hit the 10,000-row\s*\n?ceiling and older entries weren't included\./,
    );
  });

  it("CRITICAL SDK examples JSON-branch-only framing pinned. The 'The SDKs expose the JSON branch only — CSV download is browser-driven and not useful through a typed SDK call' wording explains WHY CSV is dashboard-only.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The SDKs expose the JSON branch only — CSV download is browser-driven\s*\n?and not useful through a typed SDK call\./,
    );
  });

  it('CRITICAL 3-language SDK examples pinned — TypeScript + Python + Go each call auditLog.export() / audit_log.export() / AuditLog.Export(ctx).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/const dump = await client\.auditLog\.export\(\);/);
    expect(p).toMatch(/dump = client\.audit_log\.export\(\)/);
    expect(p).toMatch(/client\.AuditLog\.Export\(ctx\)/);
  });

  it("CRITICAL read:audit-scope + X-Driftstack-Account team-RBAC honored framing pinned. S36 2026-07-07 (fable-truth-audit): V-553.B-21 WIDENED the audit read gate from the old hard account_owner requirement to the granular read:audit scope (services/account-audit.ts list() → throwIfMissingScope(ctx, 'read:audit')), which a bare broad `read` key satisfies via the V-481 broad-satisfies-granular rule — the doc's old 'a bare read key is not sufficient' claim described retired behavior. The 'X-Driftstack-Account header is honored for team scopes' wording matches W766 /api/team header-honoring endpoint list.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Both endpoints require a customer bearer \(API key OR web session\)\s*\n?with the granular `read:audit` scope\. A broad `read` key — or an\s*\n?`account_owner` key — satisfies it/,
    );
    expect(p).toMatch(
      /The\s*\n?X-Driftstack-Account header is honored for team scopes: a member with\s*\n?read access on the team owner sees the OWNER's audit log when the\s*\n?header is set/,
    );
    // Drift sentinels — neither the retired hard-account_owner claim nor
    // the pre-V-481 'read key is not sufficient' claim may come back.
    expect(p).not.toMatch(/with the `account_owner` scope/);
    expect(p).not.toMatch(/a bare `read` key is not sufficient/);
  });

  it("CRITICAL 3-error-row table pinned — 401/403/400. The 403 'X-Driftstack-Account points at an account the caller isn't a member of' is the load-bearing team-RBAC error framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\| 401\s+\| Missing \/ invalid bearer/);
    expect(p).toMatch(
      /\| 403\s+\| X-Driftstack-Account points at an account the caller isn't a member of/,
    );
    expect(p).toMatch(
      /\| 400\s+\| Invalid `limit` \(outside \[1, 100\]\) or unknown `action` enum value/,
    );
  });

  it('CRITICAL 2-endpoint canonical action set — GET /v1/account/audit-log + GET /v1/account/audit-log/export.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`GET \/v1\/account\/audit-log`/);
    expect(p).toMatch(/`GET \/v1\/account\/audit-log\/export\?format=csv`/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/docs-pages-api-audit-log-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
