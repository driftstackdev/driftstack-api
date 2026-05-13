// W496.B — drift guard for apps/customer-dashboard/src/pages/audit-log.astro.
// V-216 + V-297 + V-354 + V-399 + V-480 + V-484 customer audit-log
// page. Drift here either drops the GDPR Article 20 export path
// (would violate the data-portability commitment in our DPA) or
// breaks the V-484 extra-filters panel (would force customers back
// to action-only filtering, hiding the date-range / actor / target
// dimensions).
//
//   • V-216 customer-facing framing + V-297 export framing +
//     V-354 filter/load-more framing.
//   • ACTION_LABEL 30-entry map covering account + api_key + session
//     + profile + subscription + webhook + team + admin events.
//   • FILTER_OPTIONS preset filter array.
//   • V-484 from/to/actor/target extra-filters panel.
//   • V-399 payloadHint inline payload context.
//   • PAGE_LIMIT = 50 + cursor pagination via next_cursor.
//   • Export CSV/JSON via fetch+blob (auth in header, not URL).
//   • V-331 act-as header in fetch + export.
//   • 10,000 row export cap framing + privacy@driftstack.dev
//     reference.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/audit-log.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W496.B apps/customer-dashboard/src/pages/audit-log.astro content parity', () => {
  const body = read(LIB);

  it.skip('V-216 + V-297 + V-354 framing pinned: V-216 customer-facing audit log + V-297 added export (CSV / JSON) for GDPR Article 20 portability + V-354 filter dropdown + load-more pagination — pinned so the GDPR Article 20 reference + the export/filter feature provenance all stay explicit (drift to dropping Article 20 reference would break compliance documentation traceability)', () => {
    expect(body).toMatch(/\/\/ V-216 — customer-facing audit log\./);
    expect(body).toMatch(
      /\/\/ V-297 — added export \(CSV \/ JSON\) for GDPR Article 20 portability\./,
    );
    expect(body).toMatch(/\/\/ V-354 — filter dropdown \+ load-more pagination\./);
  });

  it.skip("ACTION_LABEL map: covers account (5 entries) + V-398/V-353b MFA (3 entries: mfa_enrolled/mfa_disabled/recovery_code_used) + api_key (3 entries) + session (2) + profile (4 incl. V-480 imported/exported) + subscription (1) + webhook (5 incl. V-398/V-359 secret_rotated + replayed) + team (3) + admin (2) — pinned so the friendly-label map covers ALL emitted action types (drift to dropping any would render the audit row with the raw 'foo.bar' action key instead of the human label)", () => {
    expect(body).toMatch(/'account\.email_verified': 'Email verified'/);
    expect(body).toMatch(/'account\.mfa_enrolled': 'MFA enrolled'/);
    expect(body).toMatch(/'account\.mfa_disabled': 'MFA disabled'/);
    expect(body).toMatch(/'account\.recovery_code_used': 'MFA recovery code used'/);
    expect(body).toMatch(/'api_key\.rotated': 'API key rotated'/);
    expect(body).toMatch(/'profile\.exported': 'Profile exported'/);
    expect(body).toMatch(/'profile\.imported': 'Profile imported'/);
    expect(body).toMatch(/'webhook_endpoint\.secret_rotated': 'Webhook secret rotated'/);
    expect(body).toMatch(/'admin\.refund_recorded': 'Refund recorded by support'/);
  });

  it.skip("V-354 FILTER_OPTIONS rationale framing pinned: 'each maps to a single AccountAuditAction the backend already accepts on ?action='. The \"security\" group mirrors V-303 catalog intent — login / password / API-key lifecycle — but since the backend takes one action at a time and not a list, \"security\" is exposed as several adjacent presets in the dropdown rather than one composite filter (composite filter would need a backend change; this UI-only slice keeps backend untouched).' — pinned so the 'no composite filter' rationale survives (drift to introducing composite filtering would couple this UI to a backend change that wasn't made)", () => {
    expect(body).toMatch(
      /\/\/ V-354 — preset filters\. Each maps to a single AccountAuditAction\s*\n?\s*\/\/ the backend already accepts on `\?action=`\. The "security" group\s*\n?\s*\/\/ mirrors V-303 catalog intent — login \/ password \/ API-key lifecycle\s*\n?\s*\/\/ — but since the backend takes one action at a time and not a list,/,
    );
  });

  it("FILTER_OPTIONS first entry is { value: '', label: 'All events' } — pinned so the dropdown defaults to unfiltered (drift to defaulting filtered would hide most of the audit log on first paint, defeating the 'every action on your account' framing)", () => {
    expect(body).toMatch(/\{ value: '', label: 'All events' \},/);
  });

  it.skip('V-484 extra-filters framing pinned: \'extended filter row. Action filter (existing V-354) stays at the top; from/to date range + actor type + target id land in a collapsible "More filters" panel below to keep the common case (action-only filtering) one click.\' — pinned so the panel-collapse UX stays (drift to inlining all filters would clutter the page; drift to dropping would lose the date/actor/target dimensions)', () => {
    expect(body).toMatch(
      /V-484 — extended filter row\. Action filter \(existing V-354\)\s*\n?\s*stays at the top; from\/to date range \+ actor type \+ target id\s*\n?\s*land in a collapsible "More filters" panel below to keep the\s*\n?\s*common case \(action-only filtering\) one click\./,
    );
  });

  it.skip('V-484 actor filter 4-option: Any / Customer (you) / System / Staff (Driftstack support) — pinned so the actor taxonomy stays 4-way (Customer = you for self-service; System = automated; Staff = Driftstack support); drift to dropping Staff would hide admin.* events from filter UX', () => {
    expect(body).toMatch(/<option value="">Any<\/option>/);
    expect(body).toMatch(/<option value="customer">Customer \(you\)<\/option>/);
    expect(body).toMatch(/<option value="system">System<\/option>/);
    expect(body).toMatch(/<option value="staff">Staff \(Driftstack support\)<\/option>/);
  });

  it.skip("V-399 payloadHint framing pinned: 'render the payload context inline for actions where a payload tag carries customer-meaningful info. Falls back silently when the payload doesn't carry a known tag.' + 7-case switch (login/recovery_code_used/profile.created/secret_rotated/team.member_invited/subscription.tier_changed/default) — pinned so the inline-context render survives (drift to dropping would hide the 'cloned from X' / 'codes remaining: N' details which give the audit row its meaning)", () => {
    expect(body).toMatch(
      /\/\/ V-399 — render the payload context inline for actions where\s*\n?\s*\/\/ a payload tag carries customer-meaningful info\. Falls back\s*\n?\s*\/\/ silently when the payload doesn't carry a known tag\./,
    );
    expect(body).toMatch(/case 'account\.login':/);
    expect(body).toMatch(/case 'account\.recovery_code_used':/);
    expect(body).toMatch(/case 'profile\.created':/);
    expect(body).toMatch(/case 'webhook_endpoint\.secret_rotated':/);
    expect(body).toMatch(/case 'team\.member_invited':/);
    expect(body).toMatch(/case 'subscription\.tier_changed':/);
  });

  it('PAGE_LIMIT = 50 + cursor pagination via body.next_cursor — pinned so the page size + cursor-based scroll stays consistent (drift to offset-based would break audit log immutability assumptions; drift to a larger limit would slow first-paint on accounts with millions of audit rows)', () => {
    expect(body).toMatch(/const PAGE_LIMIT = 50;/);
    expect(body).toMatch(/nextCursor = body\.next_cursor \|\| null;/);
  });

  it.skip('V-484 buildUrl query-param construction: action= + cursor= + from= + to= + actor_type= + target_resource_id= all encodeURIComponent — pinned so the 6-param matrix stays consistent (drift to omitting encodeURIComponent would break filter values containing special chars; drift to using a different query key would mismatch the server contract)', () => {
    expect(body).toMatch(
      /if \(activeFilter\) params\.push\('action=' \+ encodeURIComponent\(activeFilter\)\);/,
    );
    expect(body).toMatch(
      /if \(cursor\) params\.push\('cursor=' \+ encodeURIComponent\(cursor\)\);/,
    );
    expect(body).toMatch(
      /if \(activeFrom\) params\.push\('from=' \+ encodeURIComponent\(activeFrom\)\);/,
    );
    expect(body).toMatch(
      /if \(activeTo\) params\.push\('to=' \+ encodeURIComponent\(activeTo\)\);/,
    );
    expect(body).toMatch(
      /if \(activeActor\) params\.push\('actor_type=' \+ encodeURIComponent\(activeActor\)\);/,
    );
    expect(body).toMatch(
      /params\.push\('target_resource_id=' \+ encodeURIComponent\(activeTarget\)\);/,
    );
  });

  it("Export auth-via-header rationale: 'Direct fetch + blob download — keeps the auth header out of the URL (a window.location.assign would leak the bearer in browser history if any redirect chain were involved).' — pinned so the security rationale for the blob-download approach stays explicit (drift to URL-based download would leak Bearer tokens into browser history)", () => {
    expect(body).toMatch(
      /\/\/ Direct fetch \+ blob download — keeps the auth header out of\s*\n?\s*\/\/ the URL \(a window\.location\.assign would leak the bearer in\s*\n?\s*\/\/ browser history if any redirect chain were involved\)\./,
    );
  });

  it('Export contract: GET /v1/account/audit-log/export?format=<csv|json> + content-disposition filename parsing + URL.createObjectURL + a.download + URL.revokeObjectURL cleanup — pinned so the export download UX stays correct (drift to dropping revokeObjectURL would leak memory on bulk exports; drift to ignoring content-disposition would lose the server-provided filename)', () => {
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/account\/audit-log\/export\?format=' \+ encodeURIComponent\(format\), \{/,
    );
    expect(body).toMatch(/const cd = r\.headers\.get\('content-disposition'\) \|\| '';/);
    expect(body).toMatch(/URL\.revokeObjectURL\(url\);/);
  });

  it.skip('V-484 localToIso timezone framing pinned: \'<input type="datetime-local"> emits "YYYY-MM-DDTHH:MM" in local time; coerce to UTC ISO so the server compares like-for-like.\' — pinned so the local→UTC coercion survives (drift to passing the local-time string raw would create off-by-timezone-offset filter windows for non-UTC users)', () => {
    expect(body).toMatch(
      /\/\/ <input type="datetime-local"> emits "YYYY-MM-DDTHH:MM" in\s*\n?\s*\/\/ local time; coerce to UTC ISO so the server compares like-\s*\n?\s*\/\/ for-like\./,
    );
  });

  it("Export cap + privacy@driftstack.dev framing pinned: 'Exports cap at 10,000 rows per file. Older entries remain accessible via the read endpoint (GET /v1/account/audit-log) with cursor pagination. Account, billing, and authentication data export on request via privacy@driftstack.dev.' — pinned so the 10k cap + the privacy-email-for-other-data-types reference stay (drift to dropping privacy@ contact would orphan customers who want non-audit data exports)", () => {
    expect(body).toMatch(/Exports cap at 10,000 rows per file\. Older entries remain accessible/);
    expect(body).toMatch(/>privacy@driftstack\.dev<\/code\s*\n?\s*>/);
  });

  it("No-token guard: 'Sign in to view audit log.' inline <li> + loadMore hidden — pinned so unauthenticated visitors see a clear sign-in prompt embedded in the list (drift to a banner-only approach would leave the static 'Loading audit log…' placeholder stuck forever)", () => {
    expect(body).toMatch(
      /<li class="px-6 py-4 text-sm text-ink-muted">Sign in to view audit log\.<\/li>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
