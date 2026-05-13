// W591.C — drift guard for packages/sdk-go/audit_log.go.
// V-216/V-449/V-326c/V-462/V-297 AuditLogResource Go parity.

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

  it('Framing: V-216/V-449 + append-only ledger + V-326c team-RBAC header honoured + AuditLogEntry V-211 IP/UA-nulled-customer-facing + V-413 caveat pinned', () => {
    expect(body).toMatch(
      /\/\/ AuditLogResource handles \/v1\/account\/audit-log \(V-216 \/ V-449\)\./,
    );
    expect(body).toMatch(
      /\/\/ Append-only ledger; honors the V-326c X-Driftstack-Account team-RBAC/,
    );
    expect(body).toMatch(/\/\/ header \(a member with read access on the team owner can pull the/);
    expect(body).toMatch(/\/\/ OWNER's audit log\)\./);
    expect(body).toMatch(/\/\/ AuditLogEntry — V-216 single ledger entry\./);
    expect(body).toMatch(
      /\/\/ payload lives in `Payload`; see \/api\/audit-log doc for shapes per/,
    );
    expect(body).toMatch(/\/\/ action type\. IPAddress \+ UserAgent are server-stored fields but/);
    expect(body).toMatch(/\/\/ nulled in customer-facing responses per V-211 \(see also V-413/);
    expect(body).toMatch(/\/\/ caveat about auth-flow events leaking via payload\)\./);
    expect(body).toMatch(
      /ActorType\s+string\s+`json:"actor_type"` \/\/ "customer" \| "system" \| "staff"/,
    );
    expect(body).toMatch(/Payload\s+map\[string\]interface\{\} `json:"payload"`/);
  });

  it('List + Iterate + Export 3-verb surface: List(limit/cursor/action) GET + Export V-462/V-297 GDPR-Art-20 10k-row-cap + Truncated flag + CSV out-of-band + Iterate yields one-by-one with stop-on-false', () => {
    expect(body).toMatch(/\/\/ List returns one page of audit-log entries newest-first\./);
    expect(body).toMatch(/q\.Set\("action", query\.Action\)/);
    expect(body).toMatch(/path:\s+"\/v1\/account\/audit-log",/);
    expect(body).toMatch(/\/\/ AuditLogExportResponse — V-297 bulk-export envelope \(GDPR Article/);
    expect(body).toMatch(
      /\/\/ 20 portability\)\. Up to 10,000 rows per call; `Truncated` flips to/,
    );
    expect(body).toMatch(/\/\/ true when older entries weren't returned\./);
    expect(body).toMatch(
      /^type AuditLogExportResponse struct \{\s*\n\s*GeneratedAt time\.Time\s+`json:"generated_at"`\s*\n\s*AccountID\s+string\s+`json:"account_id"`\s*\n\s*RowCount\s+int\s+`json:"row_count"`\s*\n\s*Truncated\s+bool\s+`json:"truncated"`\s*\n\s*Data\s+\[\]AuditLogEntry `json:"data"`\s*\n\}/m,
    );
    expect(body).toMatch(/\/\/ Export returns a single-call JSON bulk-export of the calling/);
    expect(body).toMatch(/\/\/ account's audit log \(V-462 \/ V-297\)\. Designed for compliance/);
    expect(body).toMatch(/\/\/ portability requests; up to 10,000 rows\. The CSV branch is not/);
    expect(body).toMatch(
      /\/\/ surfaced through the SDK — hit \/v1\/account\/audit-log\/export\?format=csv/,
    );
    expect(body).toMatch(/\/\/ directly with the bearer for spreadsheet downloads\./);
    expect(body).toMatch(/q\.Set\("format", "json"\)/);
    expect(body).toMatch(/path:\s+"\/v1\/account\/audit-log\/export",/);
    expect(body).toMatch(
      /\/\/ Iterate yields every audit-log entry across cursor pages\. Callback/,
    );
    expect(body).toMatch(
      /\/\/ returns false to stop early\. Action filter narrows to one event type\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
