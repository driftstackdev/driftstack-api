// W591.C (W636-deepened) — drift guard for packages/sdk-go/audit_log.go.
// V-216/V-449/V-326c/V-462/V-297 AuditLogResource Go parity.
//
// W636 splits the original 3 it() blocks (framing + 3-verb-bundle +
// file-exists) into 8 focused per-concept blocks + pins previously-
// implicit invariants:
//
//   • V-216/V-449 append-only ledger contract: rows are immutable
//     once written; no UPDATE/DELETE verbs surface here.
//   • V-326c team-RBAC X-Driftstack-Account header semantics: a
//     member with read access on the team owner can pull the OWNER's
//     audit log (not their own). This is the load-bearing cross-
//     account read contract.
//   • V-211 IP/UA nulled in customer-facing responses + V-413 caveat
//     about auth-flow events leaking via payload — both pinned so
//     drift to surfacing IP/UA would silently break the privacy
//     posture customers anchor on.
//   • AuditLogEntry ActorType inline-comment enum (customer/system/
//     staff) — pinned so a drift adding e.g. "admin" doesn't ship
//     unannounced through the SDK shape.
//   • AuditLogExportResponse Truncated invariant: flips to true when
//     older entries weren't returned (the 10k cap was hit). Drift
//     here would silently make truncation invisible to compliance
//     auditors using the export for GDPR Article 20 portability.
//   • CSV format out-of-band: SDK only exposes JSON; CSV requires
//     hitting /v1/account/audit-log/export?format=csv directly.
//   • Iterate yield-one-by-one + stop-on-false-OR-on-error semantics
//     with action filter passthrough across pages.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/audit_log.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W591.C packages/sdk-go/audit_log.go content parity', () => {
  const body = read(LIB);

  it("file exists at canonical path + V-216/V-449 AuditLogResource binds /v1/account/audit-log + append-only ledger contract + V-326c team-RBAC X-Driftstack-Account semantics pinned. CRITICAL: a member with read access on the team owner can pull the OWNER's audit log (the load-bearing cross-account read contract).", () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/^package driftstack$/m);
    expect(body).toMatch(
      /\/\/ AuditLogResource handles \/v1\/account\/audit-log \(V-216 \/ V-449\)\./,
    );
    expect(body).toMatch(
      /\/\/ Append-only ledger; honors the V-326c X-Driftstack-Account team-RBAC/,
    );
    expect(body).toMatch(/\/\/ header \(a member with read access on the team owner can pull the/);
    expect(body).toMatch(/\/\/ OWNER's audit log\)\./);
    expect(body).toMatch(/^type AuditLogResource struct \{\s*\n\s*client \*Client\s*\n\}/m);
  });

  it('AuditLogEntry — V-216 ledger row + V-211 IP/UA-nulled-customer-facing + V-413 caveat about auth-flow events leaking via payload. ActorType inline-comment enum (customer/system/staff) pinned so a drift adding "admin" or any other actor type does not ship unannounced through the SDK shape.', () => {
    expect(body).toMatch(/\/\/ AuditLogEntry — V-216 single ledger entry\./);
    expect(body).toMatch(
      /\/\/ payload lives in `Payload`; see \/api\/audit-log doc for shapes per/,
    );
    expect(body).toMatch(/\/\/ action type\. IPAddress \+ UserAgent are server-stored fields but/);
    expect(body).toMatch(/\/\/ nulled in customer-facing responses per V-211 \(see also V-413/);
    expect(body).toMatch(/\/\/ caveat about auth-flow events leaking via payload\)\./);
    expect(body).toMatch(
      /^type AuditLogEntry struct \{\s*\n\s*ID\s+string\s+`json:"id"`\s*\n\s*AccountID\s+string\s+`json:"account_id"`\s*\n\s*ActorType\s+string\s+`json:"actor_type"` \/\/ "customer" \| "system" \| "staff"\s*\n\s*ActorAccountID\s+\*string\s+`json:"actor_account_id"`\s*\n\s*ActorKeyID\s+\*string\s+`json:"actor_key_id"`\s*\n\s*Action\s+string\s+`json:"action"`\s*\n\s*TargetResourceID \*string\s+`json:"target_resource_id"`\s*\n\s*Payload\s+map\[string\]interface\{\} `json:"payload"`\s*\n\s*IPAddress\s+\*string\s+`json:"ip_address"`\s*\n\s*UserAgent\s+\*string\s+`json:"user_agent"`\s*\n\s*Timestamp\s+time\.Time\s+`json:"timestamp"`\s*\n\}/m,
    );
  });

  it('AuditLogListPage envelope + ListAuditLogQuery 3-field query (Limit / Cursor / Action filter). Action filter scopes to one event type so the dashboard timeline can narrow without client-side filtering.', () => {
    expect(body).toMatch(
      /^type AuditLogListPage struct \{\s*\n\s*Data\s+\[\]AuditLogEntry `json:"data"`\s*\n\s*NextCursor \*string\s+`json:"next_cursor"`\s*\n\}/m,
    );
    expect(body).toMatch(
      /^type ListAuditLogQuery struct \{\s*\n\s*Limit\s+int\s*\n\s*Cursor string\s*\n\s*Action string \/\/ filter to a single action name\s*\n\}/m,
    );
  });

  it("List — GET /v1/account/audit-log newest-first + 3-param conditional-set-on-non-zero query (limit / cursor / action). Action filter passthrough into the url.Values so callers narrowing to one event type don't pay for client-side filtering.", () => {
    expect(body).toMatch(/\/\/ List returns one page of audit-log entries newest-first\./);
    expect(body).toMatch(
      /func \(r \*AuditLogResource\) List\(ctx context\.Context, query \*ListAuditLogQuery\) \(\*AuditLogListPage, error\)/,
    );
    expect(body).toMatch(
      /if query\.Limit > 0 \{\s*\n\s*q\.Set\("limit", strconv\.Itoa\(query\.Limit\)\)\s*\n\s*\}/,
    );
    expect(body).toMatch(
      /if query\.Cursor != "" \{\s*\n\s*q\.Set\("cursor", query\.Cursor\)\s*\n\s*\}/,
    );
    expect(body).toMatch(
      /if query\.Action != "" \{\s*\n\s*q\.Set\("action", query\.Action\)\s*\n\s*\}/,
    );
    expect(body).toMatch(/method: "GET",\s*\n\s*path:\s+"\/v1\/account\/audit-log",/);
  });

  it("AuditLogExportResponse — V-297 GDPR Article 20 portability envelope (5 fields: generated_at + account_id + row_count + truncated + data). Truncated bool invariant: flips to true when older entries weren't returned (10k cap hit). Drift here would silently make truncation invisible to compliance auditors who use the export to verify data portability.", () => {
    expect(body).toMatch(/\/\/ AuditLogExportResponse — V-297 bulk-export envelope \(GDPR Article/);
    expect(body).toMatch(
      /\/\/ 20 portability\)\. Up to 10,000 rows per call; `Truncated` flips to/,
    );
    expect(body).toMatch(/\/\/ true when older entries weren't returned\./);
    expect(body).toMatch(
      /^type AuditLogExportResponse struct \{\s*\n\s*GeneratedAt time\.Time\s+`json:"generated_at"`\s*\n\s*AccountID\s+string\s+`json:"account_id"`\s*\n\s*RowCount\s+int\s+`json:"row_count"`\s*\n\s*Truncated\s+bool\s+`json:"truncated"`\s*\n\s*Data\s+\[\]AuditLogEntry `json:"data"`\s*\n\}/m,
    );
  });

  it('Export — V-462/V-297 GET /v1/account/audit-log/export?format=json single-call JSON bulk-export for compliance portability (up to 10,000 rows). CSV branch INTENTIONALLY not surfaced through the SDK; customers wanting spreadsheet downloads hit /v1/account/audit-log/export?format=csv directly with the bearer. The "format=json" query param is hard-coded so the SDK never accidentally returns binary CSV that customers would have to base64-handle.', () => {
    expect(body).toMatch(/\/\/ Export returns a single-call JSON bulk-export of the calling/);
    expect(body).toMatch(/\/\/ account's audit log \(V-462 \/ V-297\)\. Designed for compliance/);
    expect(body).toMatch(/\/\/ portability requests; up to 10,000 rows\. The CSV branch is not/);
    expect(body).toMatch(
      /\/\/ surfaced through the SDK — hit \/v1\/account\/audit-log\/export\?format=csv/,
    );
    expect(body).toMatch(/\/\/ directly with the bearer for spreadsheet downloads\./);
    expect(body).toMatch(
      /func \(r \*AuditLogResource\) Export\(ctx context\.Context\) \(\*AuditLogExportResponse, error\)/,
    );
    expect(body).toMatch(/q\.Set\("format", "json"\)/);
    expect(body).toMatch(/method: "GET",\s*\n\s*path:\s+"\/v1\/account\/audit-log\/export",/);
  });

  it('Iterate — yields every audit-log entry across cursor pages. Callback contract: false-stops-early-without-fetching-further-pages, error-propagates-immediately. Action filter passthrough across pages (stays narrowed to one event type for the whole walk). Empty NextCursor terminates the outer loop. Same shape as profiles.Iterate so customers reuse the pagination pattern.', () => {
    expect(body).toMatch(
      /\/\/ Iterate yields every audit-log entry across cursor pages\. Callback/,
    );
    expect(body).toMatch(
      /\/\/ returns false to stop early\. Action filter narrows to one event type\./,
    );
    expect(body).toMatch(
      /func \(r \*AuditLogResource\) Iterate\(\s*\n\s*ctx context\.Context,\s*\n\s*query \*ListAuditLogQuery,\s*\n\s*fn func\(\*AuditLogEntry\) \(bool, error\),\s*\n\) error/,
    );
    // Action filter passthrough across pages.
    expect(body).toMatch(
      /page, err := r\.List\(ctx, &ListAuditLogQuery\{\s*\n\s*Limit:\s+limit,\s*\n\s*Cursor: cursor,\s*\n\s*Action: action,\s*\n\s*\}\)/,
    );
    // Inner callback: err propagates, !cont returns nil cleanly.
    expect(body).toMatch(
      /cont, err := fn\(&page\.Data\[i\]\)\s*\n\s*if err != nil \{\s*\n\s*return err\s*\n\s*\}\s*\n\s*if !cont \{\s*\n\s*return nil\s*\n\s*\}/,
    );
    // Outer loop terminator.
    expect(body).toMatch(
      /if page\.NextCursor == nil \|\| \*page\.NextCursor == "" \{\s*\n\s*return nil\s*\n\s*\}/,
    );
  });
});
