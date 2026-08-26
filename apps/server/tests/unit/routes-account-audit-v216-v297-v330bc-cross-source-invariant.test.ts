// W1037 — routes/account-audit V-216 + V-297 + V-330b/c + V-484
// cross-source invariant. Three-hundred-sixty-third in the drift-
// guard series. Pins the apps/server/src/routes/account-audit.ts
// customer audit-log read + export routes:
//
//   V-216 anchor — 'V-216 — customer-facing audit log read endpoint'.
//
//   V-297 export framing — 'V-297 — GET /v1/account/audit-log/export
//   ?format=csv|json exports the full audit log for the calling
//   account as a single download. CSV for spreadsheets / GDPR
//   Article 20 portability; JSON for programmatic consumers. Server-
//   side ceiling: 10,000 rows per export to avoid pathological cases.
//   Pagination via subsequent ?since=<timestamp> calls if more is
//   needed (rare in practice)'.
//
//   Export constants — EXPORT_MAX_ROWS = 10_000 + EXPORT_PAGE_SIZE
//     = 200.
//
//   V-330b list framing — 'V-330b — honor X-Driftstack-Account: a
//   team member with a valid membership reads the owner's audit log.
//   Read-only; both member and admin roles allowed'.
//
//   V-330c export framing — 'V-330c — same effective-account
//   semantic as the read endpoint above. A team member can export
//   the owner's audit log when they pass X-Driftstack-Account'.
//
//   V-484 framing — 'V-484 — additional filters forwarded to the
//   service layer' (from, to, actor_type, target_resource_id).
//
//   publicEntry 11-field shape — id + account_id (acc_) + actor_type
//     + nullable actor_account_id (acc_) + nullable actor_key_id
//     (key_) + action + target_resource_id + payload + ip_address +
//     user_agent + timestamp (ISO).
//
//   CSV header has 9 columns (timestamp + action + actor_type +
//     actor_account_id + actor_key_id + target_resource_id +
//     ip_address + user_agent + payload).
//
//   CSV row separator '\r\n' + RFC 4180 csvEscape (quote when comma/
//     quote/newline + double internal quotes).
//
//   x-driftstack-export-truncated header — 'true' | 'false'.
//
//   Content-Disposition filename — `driftstack-audit-log-YYYY-MM-DD
//     .{csv|json}`.
//
//   ExportQuerySchema — z.enum(['csv', 'json']).default('json').
//
// stays in lockstep across apps/server/src/routes/account-audit.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1037 routes/account-audit V-216 + V-297 + V-330b/c + V-484 cross-source invariant', () => {
  it("CRITICAL V-216 anchor + V-297 export framing — 'V-216 — customer-facing audit log read endpoint. GET /v1/account/audit-log — list the calling account's own audit entries (newest first, cursor-paginated, optional action filter). V-297 — GET /v1/account/audit-log/export?format=csv|json exports the full audit log for the calling account as a single download. CSV for spreadsheets / GDPR Article 20 portability; JSON for programmatic consumers. Server-side ceiling: 10,000 rows per export to avoid pathological cases. Pagination via subsequent ?since=<timestamp> calls if more is needed (rare in practice)'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts'));
    expect(p).toMatch(/V-216 — customer-facing audit log read endpoint\./);
    expect(p).toMatch(/GET \/v1\/account\/audit-log — list the calling account's own audit/);
    expect(p).toMatch(/entries \(newest first, cursor-paginated, optional action filter\)\./);
    expect(p).toMatch(/V-297 — `GET \/v1\/account\/audit-log\/export\?format=csv\|json` exports/);
    expect(p).toMatch(/the full audit log for the calling account as a single download\./);
    expect(p).toMatch(/CSV for spreadsheets \/ GDPR Article 20 portability; JSON for/);
    expect(p).toMatch(/programmatic consumers\. Server-side ceiling: 10,000 rows per export/);
    expect(p).toMatch(/to avoid pathological cases\./);
  });

  it('CRITICAL EXPORT_MAX_ROWS = 10_000 + EXPORT_PAGE_SIZE = 200.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts'));
    expect(p).toMatch(/const EXPORT_MAX_ROWS = 10_000;/);
    expect(p).toMatch(/const EXPORT_PAGE_SIZE = 200;/);
  });

  it("CRITICAL V-330b framing — 'V-330b — honor X-Driftstack-Account: a team member with a valid membership reads the owner's audit log. Read-only; both member and admin roles allowed'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts'));
    expect(p).toMatch(/\/\/ V-330b — honor X-Driftstack-Account: a team member with a/);
    expect(p).toMatch(/\/\/ valid membership reads the owner's audit log\. Read-only;/);
    expect(p).toMatch(/\/\/ both 'member' and 'admin' roles allowed\./);
  });

  it("CRITICAL V-330c framing — 'V-330c — same effective-account semantic as the read endpoint above. A team member can export the owner's audit log when they pass X-Driftstack-Account'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts'));
    expect(p).toMatch(/\/\/ V-330c — same effective-account semantic as the read endpoint/);
    expect(p).toMatch(/\/\/ above\. A team member can export the owner's audit log when/);
    expect(p).toMatch(/\/\/ they pass X-Driftstack-Account\./);
  });

  it("CRITICAL V-484 framing — 'V-484 — additional filters forwarded to the service layer' (from, to, actor_type, target_resource_id forwarded into service.list).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts'));
    expect(p).toMatch(/\/\/ V-484 — additional filters forwarded to the service layer\./);
    expect(p).toMatch(
      /\.\.\.\(parsed\.data\.from !== undefined \? \{ from: parsed\.data\.from \} : \{\}\),/,
    );
    expect(p).toMatch(
      /\.\.\.\(parsed\.data\.to !== undefined \? \{ to: parsed\.data\.to \} : \{\}\),/,
    );
    expect(p).toMatch(
      /\.\.\.\(parsed\.data\.actor_type !== undefined \? \{ actorType: parsed\.data\.actor_type \} : \{\}\),/,
    );
    expect(p).toMatch(/\.\.\.\(parsed\.data\.target_resource_id !== undefined/);
    expect(p).toMatch(/\? \{ targetResourceId: parsed\.data\.target_resource_id \}/);
  });

  it('CRITICAL publicEntry 11-field — id + account_id (acc_) + actor_type + nullable actor_account_id (acc_) + nullable actor_key_id (key_) + action + target_resource_id + payload + ip_address + user_agent + timestamp ISO.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts'));
    expect(p).toMatch(/id: row\.id,/);
    expect(p).toMatch(/account_id: `acc_\$\{row\.accountId\}`,/);
    expect(p).toMatch(/actor_type: row\.actorType,/);
    expect(p).toMatch(
      /actor_account_id: row\.actorAccountId \? `acc_\$\{row\.actorAccountId\}` : null,/,
    );
    expect(p).toMatch(/actor_key_id: row\.actorKeyId \? `key_\$\{row\.actorKeyId\}` : null,/);
    expect(p).toMatch(/action: row\.action,/);
    expect(p).toMatch(/target_resource_id: row\.targetResourceId,/);
    // ip/ua + payload conditionally scrubbed for cross-actor (team-member)
    // reads UNIONED with the per-row actor-differs check (a staff support-
    // note row must redact even on the owner's own self-view); the owner's
    // own view of their own rows keeps them (GDPR Art-15 self-access).
    expect(p).toMatch(
      /const redact = redactActorPrivacy \|\| rowNeedsActorPrivacyRedaction\(row\);/,
    );
    expect(p).toMatch(
      /function rowNeedsActorPrivacyRedaction\(row: AccountAuditEntryRow\): boolean \{\s*return row\.actorAccountId !== null && row\.actorAccountId !== row\.accountId;\s*\}/,
    );
    expect(p).toMatch(/payload: redact \? scrubActorPrivacy\(row\.payload\) : row\.payload,/);
    expect(p).toMatch(/ip_address: redact \? null : row\.ipAddress,/);
    expect(p).toMatch(/user_agent: redact \? null : row\.userAgent,/);
    expect(p).toMatch(/timestamp: row\.timestamp\.toISOString\(\),/);
    expect(p).toMatch(/const redactActorPrivacy = effective\.kind === 'team';/);
  });

  it('CRITICAL CSV header 9 columns — timestamp + action + actor_type + actor_account_id + actor_key_id + target_resource_id + ip_address + user_agent + payload.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts'));
    expect(p).toMatch(/const header = \[/);
    expect(p).toMatch(/'timestamp',/);
    expect(p).toMatch(/'action',/);
    expect(p).toMatch(/'actor_type',/);
    expect(p).toMatch(/'actor_account_id',/);
    expect(p).toMatch(/'actor_key_id',/);
    expect(p).toMatch(/'target_resource_id',/);
    expect(p).toMatch(/'ip_address',/);
    expect(p).toMatch(/'user_agent',/);
    expect(p).toMatch(/'payload',/);
  });

  it('CRITICAL CSV export goes through the shared buildCsv helper (RFC 4180 + CWE-1236 formula-injection guard), not a local RFC-only escaper.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts'));
    expect(p).toMatch(/import \{ buildCsv \} from '\.\.\/lib\/csv\.js';/);
    expect(p).toMatch(/const csv = buildCsv\(\{ header, rows \}\);/);
    // The local RFC-4180-only csvEscape (no formula guard) was removed;
    // audit free-text like user_agent is client-controlled.
    expect(p).not.toMatch(/function csvEscape\(/);
  });

  it("CRITICAL CSV response 3 headers — content-type 'text/csv; charset=utf-8' + content-disposition 'attachment; filename=driftstack-audit-log-YYYY-MM-DD.csv' + x-driftstack-export-truncated 'true'|'false'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts'));
    expect(p).toMatch(/\.header\('content-type', 'text\/csv; charset=utf-8'\)/);
    expect(p).toMatch(
      /\.header\('content-disposition', `attachment; filename="\$\{filenameBase\}\.csv"`\)/,
    );
    expect(p).toMatch(/\.header\('x-driftstack-export-truncated', truncated \? 'true' : 'false'\)/);
    expect(p).toMatch(
      /const filenameBase = `driftstack-audit-log-\$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}`;/,
    );
  });

  it('CRITICAL JSON export envelope 5-field — generated_at (ISO) + account_id (acc_) + row_count + truncated + data: all.map(publicEntry).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts'));
    expect(p).toMatch(/generated_at: new Date\(\)\.toISOString\(\),/);
    // account_id labels the scoped account (owner under team export, caller else).
    expect(p).toContain(
      "account_id: `acc_${effective.kind === 'team' ? effective.accountId : ctx.account.id}`,",
    );
    expect(p).toMatch(/row_count: all\.length,/);
    expect(p).toMatch(/truncated,/);
    expect(p).toMatch(/data: all\.map\(\(row\) => publicEntry\(row, redactActorPrivacy\)\),/);
  });

  it("CRITICAL ExportQuerySchema — z.enum(['csv', 'json']).default('json').", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts'));
    expect(p).toMatch(/format: z\.enum\(\['csv', 'json'\]\)\.default\('json'\),/);
  });

  it("CRITICAL EFFECTIVE_ACCOUNT_HEADER = 'x-driftstack-account' + readEffectiveAccountHeader array-or-string handling — extracted to shared lib/effective-account-header.ts and imported by account-audit.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts'));
    expect(p).toMatch(
      /import \{ readEffectiveAccountHeader \} from '\.\.\/lib\/effective-account-header\.js';/,
    );
    const lib = read(resolve(REPO_ROOT, 'apps/server/src/lib/effective-account-header.ts'));
    expect(lib).toMatch(/export const EFFECTIVE_ACCOUNT_HEADER = 'x-driftstack-account';/);
    expect(lib).toMatch(/const value = Array\.isArray\(raw\) \? raw\[0\] : raw;/);
  });

  it('CRITICAL export pagination loop — the loop records WHICH exit it took. A row count cannot tell a complete export of exactly the cap from a truncated one, because 10,000 divides by the 200-row page size; V-1793 replaced `truncated = all.length >= EXPORT_MAX_ROWS` with `!exhausted`, set only on the null-cursor break.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts'));
    expect(p).toMatch(/while \(all\.length < EXPORT_MAX_ROWS\) \{/);
    expect(p).toMatch(/all\.push\(\.\.\.page\.items\);/);
    expect(p).toMatch(/if \(page\.nextCursor === null\) \{/);
    expect(p).toMatch(/exhausted = true;/);
    expect(p).toMatch(/cursor = page\.nextCursor;/);
    expect(p).toMatch(/const truncated = !exhausted;/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/routes-account-audit-v216-v297-v330bc-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
