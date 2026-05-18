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

  it('CRITICAL actor_key_id synthetic-wsk_-for-web-session pinned. The "actor_key_id is the synthetic wsk_<session-uuid> for web-session calls and key_<key-uuid> for API-key calls" wording explains the 2-shape discriminator.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`actor_key_id` is the synthetic `wsk_<session-uuid>` for web-session\s*\n?calls and `key_<key-uuid>` for API-key calls\./,
    );
  });

  it("CRITICAL ip_address + user_agent deliberately-null-in-customer-responses framing pinned. The 'deliberately null in production customer-facing responses for privacy' wording is the load-bearing customer-comms privacy contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`ip_address` and `user_agent` \(top-level fields on the entry\) are\s*\n?surfaced in the schema but deliberately null in production\s*\n?customer-facing responses for privacy/,
    );
  });

  it('CRITICAL V-413 caveat pinned — auth-flow events store issued_from_ip+user_agent in payload as a deliberate exception. The "Caveat (V-413)" + the TD-audit-payload-scrub queued framing explains the known asymmetry.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*Caveat \(V-413\):\*\* the auth-flow audit events/);
    expect(p).toMatch(
      /`account\.email_verified`, `account\.login`, `account\.logout`,\s*\n?`account\.password_changed`\) currently store `issued_from_ip` \+\s*\n?`user_agent` inside `payload`/,
    );
    expect(p).toMatch(/TD-audit-payload-scrub/);
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

  it('CRITICAL account.login payload method 5-enum pinned — password/magic_link/password_reset/mfa_totp/mfa_recovery. Matches W755 audit-log V-399 payloadHint().', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`payload\.method` ∈ \{`password`, `magic_link`, `password_reset`, `mfa_totp`, `mfa_recovery`\}/,
    );
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
    expect(p).toMatch(/\/\/ webhook_endpoint\.secret_rotated \(V-359\)/);
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
      /Consumers should default-handle unknown payload shapes gracefully;\s*\n?new fields are additive\./,
    );
  });

  it("CRITICAL export-no-pagination + GDPR-Article-20 framing pinned. The 'Returns the FULL audit-log history for the calling account as a single download (no pagination). Used for GDPR Article 20 portability — customer takes their compliance record off the platform' wording is the load-bearing export contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Returns the FULL audit-log history for the calling account as a\s*\n?single download \(no pagination\)\. Used for GDPR Article 20\s*\n?portability — customer takes their compliance record off the\s*\n?platform\./,
    );
  });

  it('CRITICAL export response headers pinned — Content-Type csv|json + Content-Disposition attachment; filename="audit-log.{ext}". Matches W755 dashboard /audit-log filename extraction.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`Content-Type` — `text\/csv` or `application\/json`/);
    expect(p).toMatch(/`Content-Disposition` — `attachment; filename="audit-log\.\{ext\}"`/);
  });

  it("CRITICAL 10,000-row cap framing pinned. Matches W755 dashboard /audit-log 'Exports cap at 10,000 rows per file' framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Cap: 10,000 rows per file\. Older entries remain accessible via the\s*\n?paginated read endpoint above\./,
    );
  });

  it('CRITICAL CSV-columns 8-field set pinned — id/timestamp/action/actor_type/actor_account_id/actor_key_id/target_resource_id/payload_json. Drift to dropping a column would silently mismatch SDK consumer parsers.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /CSV columns: `id`, `timestamp`, `action`, `actor_type`,\s*\n?`actor_account_id`, `actor_key_id`, `target_resource_id`,\s*\n?`payload_json`\./,
    );
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

  it("CRITICAL X-Driftstack-Account team-RBAC honored framing pinned. The 'X-Driftstack-Account header is honored for team scopes: a member with read access on the team owner sees the OWNER\\'s audit log when the header is set' wording matches W766 /api/team header-honoring endpoint list.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The X-Driftstack-Account header is honored for\s*\n?team scopes : a member with read access on the team owner\s*\n?sees the OWNER's audit log when the header is set\./,
    );
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
