// W755 — customer-dashboard /audit-log.astro V-216 (audit log) +
// V-297 (GDPR Article 20 export) + V-354 (filter + load-more) +
// V-381 (clone/snapshot-restore shared filter) + V-398 (MFA + staff
// + webhook-secret events) + V-399 (payload-hint inline) + V-480
// (profile import/export) + V-484 (multi-filter + date-range) parity.
// Eighty-first in the cross-SDK drift-guard series.
//
// /audit-log is the compliance/transparency surface customers use to
// reconstruct what happened on their account. Drift to dropping an
// AccountAuditAction would silently hide events from customers who
// are legally entitled to see them under GDPR Article 20.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/audit-log.astro');

describe('W755 dashboard /audit-log page V-216 + V-297 + V-354 + V-484 parity', () => {
  it('audit-log.astro file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL V-216 + V-297 + V-354 anchor header pinned. The 3-line frontmatter — "V-216 — customer-facing audit log." + "V-297 — added export (CSV / JSON) for GDPR Article 20 portability." + "V-354 — filter dropdown + load-more pagination." — threads ALL THREE anchors.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-216 — customer-facing audit log\./);
    expect(p).toMatch(/V-297 — added export \(CSV \/ JSON\) for GDPR Article 20 portability\./);
    expect(p).toMatch(/V-354 — filter dropdown \+ load-more pagination\./);
  });

  it('CRITICAL ACTION_LABEL covers the 27-event AccountAuditAction enum. Drift to dropping a label would render the raw enum value to customers.', () => {
    const p = read(PAGE);

    // 27 events.
    for (const action of [
      'account.email_verified',
      'account.login',
      'account.logout',
      'account.password_changed',
      'account.mfa_enrolled',
      'account.mfa_disabled',
      'account.recovery_code_used',
      'api_key.minted',
      'api_key.revoked',
      'api_key.rotated',
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
      expect(p, `action ${action}`).toMatch(new RegExp(`'${action.replace(/\./g, '\\.')}': '`));
    }
  });

  it("CRITICAL append-only framing pinned. The 'Account-scoped events · append-only' header is the load-bearing customer-trust contract (drift to mutable would erode audit-log credibility).", () => {
    const p = read(PAGE);
    expect(p).toMatch(/Account-scoped events · append-only/);
  });

  it("CRITICAL 'your data, your file' GDPR framing pinned. The 'Export the full history at any time — your data, your file.' wording is the customer-facing GDPR Article 20 portability promise.", () => {
    const p = read(PAGE);
    expect(p).toMatch(/Export the full history at any time — your data, your file\./);
  });

  it("CRITICAL V-381 clone + snapshot-restore shared-filter framing pinned. The 'V-381 — V-313 clone + V-312 snapshot.restore both emit profile.created with a payload tag (cloned_from / restored_from_snapshot); the filter is shared.' framing explains WHY profile.created label is 'Profiles created (incl. clones / snapshot restores)'.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-381 — V-313 clone \+ V-312 snapshot\.restore both emit/);
    expect(p).toMatch(
      /profile\.created with a payload tag \(cloned_from \/ restored_from_snapshot\);/,
    );
    expect(p).toMatch(/the filter is shared\./);
    expect(p).toMatch(/label: 'Profiles created \(incl\. clones \/ snapshot restores\)'/);
  });

  it('CRITICAL V-398 staff-event + V-359 webhook-secret + V-353b MFA expansion framing pinned. The 3 V-398-tagged comment lines threading these expansions.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-398 — V-353b MFA lifecycle/);
    expect(p).toMatch(/V-398 — V-359 webhook signing-secret rotation/);
    expect(p).toMatch(/V-398 — staff-touched events surfaced for transparency/);
  });

  it('CRITICAL V-399 payloadHint() switch covers 6 event types with customer-meaningful payload tags. account.login/account.recovery_code_used/profile.created/webhook_endpoint.secret_rotated/team.member_invited/subscription.tier_changed each carry a distinct payload hint.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-399 — render the payload context inline for actions where/);

    for (const action of [
      'account.login',
      'account.recovery_code_used',
      'profile.created',
      'webhook_endpoint.secret_rotated',
      'team.member_invited',
      'subscription.tier_changed',
    ]) {
      expect(p, `case '${action}'`).toMatch(new RegExp(`case '${action.replace(/\./g, '\\.')}':`));
    }
  });

  it('CRITICAL V-399 subscription.tier_changed hint formats as `<from> → <to>`. The arrow framing is what makes tier changes visually scannable.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /' · ' \+ escapeHtml\(String\(p\.from\)\) \+ ' → ' \+ escapeHtml\(String\(p\.to\)\)/,
    );
  });

  it('CRITICAL GET /v1/account/audit-log endpoint pinned (NOT /audit). The audit-log path matches the V-216 schema route.', () => {
    const p = read(PAGE);
    expect(p).toMatch(/apiBaseUrl \+ '\/v1\/account\/audit-log\?'/);
  });

  it('CRITICAL V-484 multi-filter buildUrl() pinned — action + cursor + from + to + actor_type + target_resource_id. Drift to dropping a query param would silently disable that filter.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /if \(activeFilter\) params\.push\('action=' \+ encodeURIComponent\(activeFilter\)\);/,
    );
    expect(p).toMatch(/if \(cursor\) params\.push\('cursor=' \+ encodeURIComponent\(cursor\)\);/);
    expect(p).toMatch(
      /if \(activeFrom\) params\.push\('from=' \+ encodeURIComponent\(activeFrom\)\);/,
    );
    expect(p).toMatch(/if \(activeTo\) params\.push\('to=' \+ encodeURIComponent\(activeTo\)\);/);
    expect(p).toMatch(
      /if \(activeActor\) params\.push\('actor_type=' \+ encodeURIComponent\(activeActor\)\);/,
    );
    expect(p).toMatch(/target_resource_id=' \+ encodeURIComponent\(activeTarget\)/);
  });

  it('CRITICAL V-484 datetime-local → UTC ISO coercion pinned. The localToIso() helper + "datetime-local emits YYYY-MM-DDTHH:MM in local time; coerce to UTC ISO so the server compares like-for-like" framing is the load-bearing TZ-correctness anchor.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\/\/ <input type="datetime-local"> emits "YYYY-MM-DDTHH:MM" in/);
    expect(p).toMatch(/\/\/ local time; coerce to UTC ISO so the server compares like-/);
    expect(p).toMatch(/\/\/ for-like\./);
    expect(p).toMatch(
      /function localToIso\(local\) \{\s*\n\s+\/\/ <input type="datetime-local">[\s\S]+?return d\.toISOString\(\);/,
    );
  });

  it('CRITICAL PAGE_LIMIT = 50 cursor pagination pinned. Drift to a larger page would risk hitting Cloudflare Workers 1MB response cap on busy accounts.', () => {
    const p = read(PAGE);
    expect(p).toMatch(/const PAGE_LIMIT = 50;/);
    expect(p).toMatch(/const params = \['limit=' \+ PAGE_LIMIT\];/);
  });

  it('CRITICAL Load-more cursor visibility — `setLoadMoreVisible(!!nextCursor)`. Drift to always-visible would let customers click into a 404; drift to never-visible would force customers to refresh to see older pages.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/setLoadMoreVisible\(!!nextCursor\);/);
  });

  it("CRITICAL V-297 export CSV + JSON button pair pinned. Drift to dropping either format would force customers to do format conversion themselves — defeats GDPR Article 20 'machine-readable structured format' compliance. 2026-05-24 — buttons wrap content (icon + label); pin loosened to data-attr + label.", () => {
    const p = read(PAGE);
    expect(p).toMatch(/data-export-csv/);
    expect(p).toMatch(/Export CSV/);
    expect(p).toMatch(/data-export-json/);
    expect(p).toMatch(/Export JSON/);
  });

  it("CRITICAL export-via-blob-not-URL framing pinned. The 'Direct fetch + blob download — keeps the auth header out of the URL (a window.location.assign would leak the bearer in browser history if any redirect chain were involved).' framing is the load-bearing security rationale.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\/\/ Direct fetch \+ blob download — keeps the auth header out of/);
    expect(p).toMatch(/\/\/ the URL \(a window\.location\.assign would leak the bearer in/);
    expect(p).toMatch(/\/\/ browser history if any redirect chain were involved\)\./);
  });

  it('CRITICAL bounded Export GET /v1/account/audit-log/export?format=<csv|json> with one cross-format busy lease and stable error copy pinned', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /boundedFetch\(\s*\n\s+apiBaseUrl \+ '\/v1\/account\/audit-log\/export\?format=' \+ encodeURIComponent\(format\),/,
    );
    expect(p).toMatch(/const AUDIT_TIMEOUT_MS = 15_000;/);
    expect(p).toMatch(
      /return window\.driftstackFetchWithDeadline\(url, init, AUDIT_TIMEOUT_MS, controller\);/,
    );
    expect(p).toMatch(/let exportInFlight = false;/);
    expect(p).toMatch(/if \(exportInFlight\) return;\s*\n\s+exportInFlight = true;/);
    expect(p).toContain("activeExportBtn.setAttribute('aria-busy', 'true')");
    expect(p).toContain("label.textContent = 'Exporting ' + format.toUpperCase() + '…'");
    expect(p).toContain('throw window.driftstackResponseError(r, b)');
    expect(p).toContain("requestErrorMessage(err, 'Could not export the audit log. Try again.')");
    expect(p).toMatch(/\.finally\(function \(\) \{\s*\n\s+exportInFlight = false;/);
    expect(p).toContain("btn === exportCsvBtn ? 'Export CSV' : 'Export JSON'");
  });

  it('CRITICAL Export content-disposition filename extraction pinned — `/filename="([^"]+)"/`. Drift to dropping would let downloads get random Blob URLs; the server-suggested filename is what gives the file a sensible default name.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/const cd = r\.headers\.get\('content-disposition'\) \|\| '';/);
    expect(p).toMatch(/const m = \/filename="\(\[\^"\]\+\)"\/\.exec\(cd\);/);
    expect(p).toMatch(/const name = m \? m\[1\] : 'audit-log\.' \+ format;/);
  });

  it('CRITICAL Export 10k-row cap framing pinned. The "Exports cap at 10,000 rows per file. Older entries remain accessible via the read endpoint (GET /v1/account/audit-log) with cursor pagination" wording explains the export-vs-read endpoint distinction.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Exports cap at 10,000 rows per file\. Older entries remain accessible via the read endpoint/,
    );
    expect(p).toMatch(/with cursor pagination\./);
  });

  it("CRITICAL privacy@driftstack.dev escalation pinned. The 'Account, billing, and authentication data export on request via privacy@driftstack.dev' framing is the GDPR-DPA compliance escalation path.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Account,\s*\n\s+billing, and authentication data export on request via/);
    expect(p).toMatch(/>privacy@driftstack\.dev<\/code/);
  });

  it("CRITICAL V-331b act-as header passthrough pinned on BOTH list-fetch + export. Drift to dropping on export would let a team-RBAC customer export the wrong account's audit log.", () => {
    const p = read(PAGE);

    const actAsPattern =
      /\.\.\.\(typeof window\.driftstackActAsHeaders === 'function'\s*\n\s+\? window\.driftstackActAsHeaders\(\)\s*\n\s+: \{\}\),/;

    const matches = p.match(new RegExp(actAsPattern, 'g'));
    expect(matches?.length, 'actAs spreads').toBeGreaterThanOrEqual(2);
  });

  it('CRITICAL escapeHtml uses inline if-chain not the 5-char map (audit-log style). Drift to the dictionary form is fine, but the 5-char coverage (& < > " \') must be preserved.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/if \(c === '&'\) return '&amp;';/);
    expect(p).toMatch(/if \(c === '<'\) return '&lt;';/);
    expect(p).toMatch(/if \(c === '>'\) return '&gt;';/);
    expect(p).toMatch(/if \(c === '"'\) return '&quot;';/);
    expect(p).toMatch(/return '&#39;';/);
  });

  it('CRITICAL fmtTs() formats as YYYY-MM-DD HH:MM:SS UTC. Drift to a different format would break customer-side log correlation; the trailing UTC suffix is what makes the TZ unambiguous.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /function fmtTs\(iso\) \{\s*\n\s+const d = new Date\(iso\);\s*\n\s+return d\.toISOString\(\)\.replace\('T', ' '\)\.slice\(0, 19\) \+ ' UTC';\s*\n\s+\}/,
    );
  });

  it("CRITICAL no-token banner pinned — 'Sign in to view audit log.' Drift to a 401 redirect would lose the preview-of-real-product affordance.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /'<li class="px-6 py-4 text-sm text-tk-ink-3">Sign in to view audit log\.<\/li>'/,
    );
  });

  it('CRITICAL resolveApiBaseUrl + DashboardLayout used.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/import \{ resolveApiBaseUrl \} from '\.\.\/lib\/api-base-url'/);
    expect(p).toMatch(/const apiBaseUrl = resolveApiBaseUrl\(\)/);
    expect(p).toMatch(/<DashboardLayout title="Audit log">/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/dashboard-audit-log-page-v216-v297-v354-v484-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
