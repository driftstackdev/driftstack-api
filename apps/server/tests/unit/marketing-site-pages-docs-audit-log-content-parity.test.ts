// W518.B — drift guard for apps/marketing-site/src/pages/docs/audit-log.astro.
// V-697 customer-facing audit log. Drift here either changes the response
// envelope shape (would create marketing↔/v1/account/audit-log divergence)
// or shifts the retention table (would create marketing↔billing tier
// retention divergence).
//
//   • V-697 doc-comment framing.
//   • GET /v1/account/audit-log endpoint + no-per-scope-gate-on-read.
//   • X-Driftstack-Account header for team RBAC effective-account-id.
//   • /export?format=csv 10,000-row ceiling + x-driftstack-export-truncated.
//   • Response envelope: data + next_cursor (no items field).
//   • 11-field audit-entry row shape including actor_type / actor_account_id
//     / actor_key_id / action / target_resource_id / payload / ip_address /
//     user_agent / timestamp.
//   • UUID entry id (no aud_ prefix).
//   • 3-actor-type taxonomy: customer / system / staff.
//   • 4-filter compositional: action / actor_type / target_resource_id /
//     from + to.
//   • Cursor pagination + timestamp DESC + id DESC tiebreaker.
//   • V-330b effectiveAccountId team RBAC.
//   • 5-tier retention: Trial 30d / Solo+Starter 90d / Team+Builder 1y /
//     Agency+Scale 3y / Enterprise 7y default.
//   • Append-only + admin.support_note pointer-not-edit correction.
//   • No-per-entry-webhook (feedback-loop avoidance).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/audit-log.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W518.B apps/marketing-site/src/pages/docs/audit-log.astro content parity', () => {
  const body = read(LIB);

  it("V-697 framing pinned: 'customer audit log developer docs.' — pinned so the V-697 anchor survives", () => {
    expect(body).toMatch(/\/\/ V-697 — customer audit log developer docs\./);
  });

  it('GET /v1/account/audit-log + no-per-scope-gate-on-read + X-Driftstack-Account team RBAC + /export?format=csv 10,000-row ceiling + x-driftstack-export-truncated framing pinned — pinned so the endpoint + no-scope-gate + team-RBAC-header + 10000-row-export-ceiling + truncated-signal commitments survive', () => {
    expect(body).toMatch(/GET \/v1\/account\/audit-log/);
    expect(body).toMatch(
      /The endpoint is reachable with any authenticated key — there\s*\n?\s*is no per-scope gate on read\./,
    );
    expect(body).toMatch(/<code>X-Driftstack-Account<\/code>/);
    expect(body).toMatch(
      /<code>GET \/v1\/account\/audit-log\/export\?format=csv<\/code> \(10,000-row\s*\n?\s*ceiling, signalled by <code>x-driftstack-export-truncated<\/code>\s*\n?\s*on the response\)/,
    );
  });

  it("Response envelope 11-field audit-entry shape pinned: id (raw UUID, no aud_ prefix) + account_id + actor_type customer + actor_account_id + actor_key_id + action api_key.minted + target_resource_id api_key_key_ + payload {name, scopes} + ip_address + user_agent + timestamp + 'The response envelope uses data and next_cursor — there is no items field.' — pinned so the 11-field row + UUID-no-aud_-prefix + data+next_cursor-no-items-field envelope commitment survives (drift to renaming items↔data would create marketing↔server divergence)", () => {
    expect(body).toMatch(/"id": "b1a2c3d4-…-uuid"/);
    expect(body).toMatch(/"account_id": "acc_…"/);
    expect(body).toMatch(/"actor_type": "customer"/);
    expect(body).toMatch(/"actor_account_id": "acc_…"/);
    expect(body).toMatch(/"actor_key_id": "key_…"/);
    expect(body).toMatch(/"action": "api_key\.minted"/);
    expect(body).toMatch(/"target_resource_id": "api_key_key_…"/);
    expect(body).toMatch(/"payload": \{ "name": "ci-bot", "scopes": \["read"\] \}/);
    expect(body).toMatch(/"ip_address": "203\.0\.113\.42"/);
    expect(body).toMatch(/"user_agent": "DriftstackCLI\/2\.3\.1"/);
    expect(body).toMatch(/"timestamp": "2026-05-11T13:42:00\.000Z"/);
    expect(body).toMatch(
      /Entry ids are raw UUIDs \(no <code>aud_<\/code> prefix\)\. The\s*\n?\s*response envelope uses <code>data<\/code> and\s*\n?\s*<code>next_cursor<\/code> — there is no <code>items<\/code> field\./,
    );
  });

  it('Actions-captured 7-category framing pinned: Account (7-action enum) + API keys (3) + Sessions (2) + Profiles (4) + Webhooks (3) + Billing (1) + Team RBAC (3) + Staff actions (admin.refund_recorded + admin.support_note) — pinned so the 7-category action ladder including non-exhaustive note + Staff-actions-visible-to-customer commitment survives', () => {
    expect(body).toMatch(/<strong>Account:<\/strong>/);
    expect(body).toMatch(/<code>account\.email_verified<\/code>/);
    expect(body).toMatch(/<code>account\.mfa_enrolled<\/code>/);
    expect(body).toMatch(/<code>account\.recovery_code_used<\/code>/);
    expect(body).toMatch(/<strong>API keys:<\/strong>/);
    expect(body).toMatch(/<code>api_key\.minted<\/code>/);
    expect(body).toMatch(/<code>api_key\.rotated<\/code>/);
    expect(body).toMatch(/<strong>Sessions:<\/strong>/);
    expect(body).toMatch(/<code>session\.created<\/code>/);
    expect(body).toMatch(/<code>session\.destroyed<\/code>/);
    expect(body).toMatch(/<strong>Profiles:<\/strong>/);
    expect(body).toMatch(/<code>profile\.exported<\/code>/);
    expect(body).toMatch(/<strong>Webhooks:<\/strong>/);
    expect(body).toMatch(/<code>webhook_delivery\.replayed<\/code>/);
    expect(body).toMatch(/<strong>Billing:<\/strong>/);
    expect(body).toMatch(/<code>subscription\.tier_changed<\/code>/);
    expect(body).toMatch(/<strong>Team RBAC:<\/strong>/);
    expect(body).toMatch(/<code>team\.invite_accepted<\/code>/);
    expect(body).toMatch(/<strong>Staff actions \(visible to you\):<\/strong>/);
    expect(body).toMatch(/<code>admin\.refund_recorded<\/code>/);
    expect(body).toMatch(/<code>admin\.support_note<\/code>/);
  });

  it("3-actor-type taxonomy framing pinned: customer (authenticated API key or web session, actor_account_id + actor_key_id identify) + system (automated by infra, actor_account_id/actor_key_id null) + staff (Driftstack staff via internal admin tools, refund recording / support-note / exceptional interventions, 'We notify the affected account by email when this happens for any action that modifies state.') — pinned so the 3-actor-type + email-notify-on-staff-mutation commitment survives (drift to silently-staff-modifying would break the customer-trust commitment)", () => {
    expect(body).toMatch(
      /<strong><code>customer<\/code><\/strong> — action performed\s*\n?\s*by an authenticated API key or web session\. The\s*\n?\s*<code>actor_account_id<\/code> \+ <code>actor_key_id<\/code>\s*\n?\s*fields identify which account \/ key performed it\./,
    );
    expect(body).toMatch(
      /<strong><code>system<\/code><\/strong> — automated action by\s*\n?\s*Driftstack infrastructure \(e\.g\. scheduled-job triggered\s*\n?\s*revocation, expired-card subscription downgrade\)\./,
    );
    expect(body).toMatch(
      /<strong><code>staff<\/code><\/strong> — Driftstack staff\s*\n?\s*performed the action via internal admin tools\. Used for\s*\n?\s*refund recording, support-note insertion, and exceptional\s*\n?\s*manual interventions\. We notify the affected account by\s*\n?\s*email when this happens for any action that modifies state\./,
    );
  });

  it('4-filter compositional framing pinned: action (single action string) + actor_type (customer/system/staff) + target_resource_id (per-resource filter) + from + to (ISO-8601 inclusive) + sample GET query with action=api_key.minted&from=2026-05-01Z&to=2026-05-31Z — pinned so the 4-filter set + ISO-8601-inclusive + filter-composition commitment survives', () => {
    expect(body).toMatch(/<strong><code>action<\/code><\/strong> — single action string/);
    expect(body).toMatch(
      /<strong><code>actor_type<\/code><\/strong> — <code>customer<\/code>,\s*\n?\s*<code>system<\/code>, or <code>staff<\/code>\./,
    );
    expect(body).toMatch(
      /<strong><code>target_resource_id<\/code><\/strong> — filter to\s*\n?\s*a specific resource id/,
    );
    expect(body).toMatch(
      /<code>\?target_resource_id=api_key_key_xyz<\/code> to see every\s*\n?\s*action on that key/,
    );
    expect(body).toMatch(
      /<strong><code>from<\/code><\/strong>,\s*\n?\s*<strong><code>to<\/code><\/strong> — ISO-8601 timestamps, inclusive\./,
    );
    expect(body).toMatch(
      /GET \/v1\/account\/audit-log\?action=api_key\.minted&from=2026-05-01Z&to=2026-05-31Z/,
    );
  });

  it("Pagination + effectiveAccountId team-RBAC framing pinned: 'Standard cursor pagination — see /docs/pagination. Sort order is timestamp DESC with id DESC tiebreaker, so newest entries appear first.' + effectiveAccountId behaviour + 'both member and admin team roles are read-allowed on this surface' + '/v1/account/audit-log/export effective-account header gate applies too' — pinned so the timestamp-DESC + id-DESC-tiebreaker + effectiveAccountId + member-AND-admin-can-read + export-also-gated commitments survive. The previous skip pinned an inline `(V-330b` anchor that was removed from the customer-facing copy (internal V-labels should not bleed into marketing pages); the structural framing survives without it.", () => {
    expect(body).toMatch(
      /Standard cursor pagination — see <a href="\/docs\/pagination\/">\/docs\/pagination<\/a>\.\s*\n?\s*Sort order is <code>timestamp DESC<\/code> with <code>id DESC<\/code>\s*\n?\s*tiebreaker, so newest entries appear first\./,
    );
    expect(body).toMatch(
      /<code>X-Driftstack-Account: acc_&lt;owner-uuid&gt;<\/code>\s*\n?\s*header, the server returns the <strong>owner's<\/strong> audit\s*\n?\s*log — both <code>member<\/code> and <code>admin<\/code> team\s*\n?\s*roles are read-allowed on this surface \(\s*\n?\s*<code>effectiveAccountId<\/code> behaviour\)/,
    );
    expect(body).toMatch(
      /The same effective-account header gate applies to\s*\n?\s*<code>\/v1\/account\/audit-log\/export<\/code>\./,
    );
    // Internal V-anchors must NOT bleed into customer-facing copy.
    expect(body).not.toMatch(/\(V-330b\s/);
  });

  it("Indefinite-retention framing pinned: 'Audit log entries are retained indefinitely, on every tier — there is no tier-based retention window and no scheduled prune job. An account's entries are removed only when the account itself is deleted (a cascading delete tied to the account record, not a time-based sweep).' + SIEM-export-cron pattern framing — pinned so the honest no-prune-job/indefinite-retention statement survives (a fictional 5-tier retention table + 'pruned by a nightly sweep' claim was corrected 2026-06-30: account_audit_log has no expires_at/retention column and the only real audit-shaped sweep, AuditArchiveService, explicitly excludes this table — see apps/server/src/services/audit-archive.ts AUDIT_TABLES. Drift back to a fabricated retention promise would re-create a compliance-adjacent doc/code mismatch; drift to dropping the SIEM-export-cron suggestion would orphan customers who want their own offline retention copy)", () => {
    expect(body).toMatch(
      /Audit log entries are retained <strong>indefinitely<\/strong>,\s*\n?\s*on every tier — there is no tier-based retention window and no\s*\n?\s*scheduled prune job\. An account's entries are removed only when\s*\n?\s*the account itself is deleted \(a cascading delete tied to the\s*\n?\s*account record, not a time-based sweep\)\./,
    );
    expect(body).toMatch(
      /most\s*\n?\s*enterprise customers ship a daily cron that calls the endpoint\s*\n?\s*with <code>from=yesterday&amp;to=today<\/code> and forwards the\s*\n?\s*response into their SIEM\./,
    );
    // The fabricated tier-retention table must not reappear.
    expect(body).not.toMatch(/pruned by a nightly\s*\n?\s*sweep/);

    // V-1518 — the half of this arm's title that was never checked. It names
    // AUDIT_TABLES as the reason the promise above is true, and until now only
    // the PAGE was asserted: the code side was prose. Read the roster and hold
    // it to that claim, so approving D-033 (the proposed 90d/R2 retention, still
    // pending review) cannot quietly add the customer table and falsify a live
    // customer promise in a different file.
    const archive = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/services/audit-archive.ts'),
      'utf8',
    );
    const roster = archive.slice(
      archive.indexOf('export const AUDIT_TABLES = ['),
      archive.indexOf('];', archive.indexOf('export const AUDIT_TABLES = [')),
    );
    expect(roster, 'AUDIT_TABLES is still the archive roster').toContain(
      "tableName: 'admin_audit_log'",
    );
    expect(
      roster.includes("tableName: 'account_audit_log'"),
      'the archive now sweeps account_audit_log, and this page promises those entries are retained ' +
        'indefinitely with no scheduled prune job — correct the promise or exclude the table',
    ).toBe(false);
  });

  it("Immutability + admin.support_note-pointer correction framing pinned: 'Audit entries are append-only. There's no delete or update endpoint; even staff cannot mutate existing entries. If a correction is needed (e.g. a misattributed action), staff append an admin.support_note pointing at the original entry rather than editing it.' — pinned so the append-only + no-delete-or-update + even-staff-cannot-mutate + admin.support_note-pointer-correction commitment survives (drift to allowing staff edit would break the immutable audit-trail commitment)", () => {
    expect(body).toMatch(
      /Audit entries are <strong>append-only<\/strong>\. There's no\s*\n?\s*delete or update endpoint; even staff cannot mutate existing\s*\n?\s*entries\. If a correction is needed \(e\.g\. a misattributed\s*\n?\s*action\), staff append an <code>admin\.support_note<\/code>\s*\n?\s*pointing at the original entry rather than editing it\./,
    );
  });

  it("No-per-entry-webhook + feedback-loop-avoidance framing pinned: 'The audit log itself does not emit a per-entry webhook event — that would create a feedback loop (writing a webhook delivery would itself generate an audit entry). Subscribe to the underlying resource webhooks instead (api_key.revoked, session.completed, etc.) — see /docs/webhooks.' — pinned so the no-per-entry-webhook + feedback-loop-rationale + subscribe-to-underlying-resource-webhooks-instead commitment survives", () => {
    expect(body).toMatch(
      /The audit log itself does <strong>not<\/strong> emit a per-entry\s*\n?\s*webhook event — that would create a feedback loop \(writing a\s*\n?\s*webhook delivery would itself generate an audit entry\)\.\s*\n?\s*Subscribe to the underlying resource webhooks instead\s*\n?\s*\(<code>api_key\.revoked<\/code>, <code>session\.completed<\/code>,\s*\n?\s*etc\.\) — see <a href="\/docs\/webhooks\/">\/docs\/webhooks<\/a>\./,
    );
    expect(body).not.toMatch(/href="\/docs\/(?:pagination|webhooks)"/);
  });

  it('Support 2-channel framing pinned: compliance@driftstack.dev for compliance/audit-export questions + developers@driftstack.dev for technical questions — pinned so the 2-channel split (compliance vs technical) stays consistent', () => {
    expect(body).toMatch(
      /Compliance \/ audit-export questions:\s*\n?\s*<a href="mailto:compliance@driftstack\.dev">compliance@driftstack\.dev<\/a>\./,
    );
    expect(body).toMatch(
      /Technical questions about the endpoint:\s*\n?\s*<a href="mailto:developers@driftstack\.dev">developers@driftstack\.dev<\/a>\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
