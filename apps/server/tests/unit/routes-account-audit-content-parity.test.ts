// W417.C — drift guard for apps/server/src/routes/account-audit.ts.
// V-216 customer audit log read + V-297 GDPR-Article-20 export +
// V-330b team-member effective-account header + V-484 filter
// passthroughs. Drift here either drops V-297 10k row ceiling (DoS
// vector via memory blowup) or breaks RFC 4180 CSV cell escape
// (audit log download corrupts on commas/quotes/newlines).
//
//   • V-216 framing pinned: GET /v1/account/audit-log; newest-first
//     cursor-paginated; optional action filter.
//   • V-297 framing pinned: export endpoint csv|json default json;
//     CSV for spreadsheets / GDPR Article 20 portability; JSON for
//     programmatic consumers; 10_000-row server-side ceiling;
//     ?since=<timestamp> pagination if more needed (rare).
//   • V-330b framing pinned: X-Driftstack-Account team-member
//     effective-account read; both 'member' and 'admin' roles allowed
//     (read-only).
//   • V-484 framing pinned: from/to/actor_type/target_resource_id
//     filter passthrough to service layer.
//   • Auth posture: requireAuth + rateLimit('global') on both routes.
//   • EXPORT_MAX_ROWS = 10_000 ceiling; EXPORT_PAGE_SIZE = 200.
//   • Export filename: driftstack-audit-log-YYYY-MM-DD; truncated
//     header `x-driftstack-export-truncated: true|false`.
//   • CSV cell escape per RFC 4180: quote on comma/quote/newline;
//     double up internal quotes.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W417.C apps/server/src/routes/account-audit.ts content parity', () => {
  const body = read(LIB);

  it('V-216 framing pinned: GET /v1/account/audit-log newest-first cursor-paginated + optional action filter', () => {
    expect(body).toMatch(/V-216 — customer-facing audit log read endpoint\./);
    expect(body).toMatch(
      /GET \/v1\/account\/audit-log — list the calling account's own audit\s*\n?\s*\/\/\s*entries \(newest first, cursor-paginated, optional action filter\)\./,
    );
  });

  it('V-297 framing pinned: csv|json export + GDPR Article 20 portability + 10k ceiling + ?since pagination', () => {
    expect(body).toMatch(
      /V-297 — `GET \/v1\/account\/audit-log\/export\?format=csv\|json` exports\s*\n?\s*\/\/\s*the full audit log for the calling account as a single download\.\s*\n?\s*\/\/\s*CSV for spreadsheets \/ GDPR Article 20 portability; JSON for\s*\n?\s*\/\/\s*programmatic consumers\. Server-side ceiling: 10,000 rows per export\s*\n?\s*\/\/\s*to avoid pathological cases\. Pagination via subsequent\s*\n?\s*\/\/\s*`\?since=<timestamp>` calls if more is needed \(rare in practice\)\./,
    );
  });

  it('V-330b framing pinned: X-Driftstack-Account team-member read; both member + admin roles read-only', () => {
    expect(body).toMatch(
      /\/\/ V-330b — honor X-Driftstack-Account: a team member with a\s*\n?\s*\/\/ valid membership reads the owner's audit log\. Read-only;\s*\n?\s*\/\/ both 'member' and 'admin' roles allowed\./,
    );
  });

  it('V-484 framing pinned: from/to/actor_type/target_resource_id filter passthrough', () => {
    expect(body).toMatch(/\/\/ V-484 — additional filters forwarded to the service layer\./);
  });

  it('readEffectiveAccountHeader imported from shared lib/effective-account-header.ts (extracted to collapse drift across team-RBAC routes; inline EFFECTIVE_ACCOUNT_HEADER + array-or-string handler now lives there)', () => {
    expect(body).toMatch(
      /import \{ readEffectiveAccountHeader \} from '\.\.\/lib\/effective-account-header\.js';/,
    );
    expect(body).toMatch(/readEffectiveAccountHeader\(request\)/);
  });

  it('ListAccountAuditLogQuerySchema imported from @driftstack/api-types (SDK mirror)', () => {
    expect(body).toMatch(
      /import \{ ListAccountAuditLogQuerySchema \} from '@driftstack\/api-types';/,
    );
  });

  it('publicEntry: 10-field shape with account_id=acc_ + actor_account_id/actor_key_id nullable prefixed + ip_address/user_agent/payload pass-through + ISO timestamp', () => {
    expect(body).toMatch(
      /function publicEntry\(row: AccountAuditEntryRow\): Record<string, unknown> \{/,
    );
    expect(body).toMatch(/id: row\.id,/);
    expect(body).toMatch(/account_id: `acc_\$\{row\.accountId\}`,/);
    expect(body).toMatch(/actor_type: row\.actorType,/);
    expect(body).toMatch(
      /actor_account_id: row\.actorAccountId \? `acc_\$\{row\.actorAccountId\}` : null,/,
    );
    expect(body).toMatch(/actor_key_id: row\.actorKeyId \? `key_\$\{row\.actorKeyId\}` : null,/);
    expect(body).toMatch(/action: row\.action,/);
    expect(body).toMatch(/target_resource_id: row\.targetResourceId,/);
    expect(body).toMatch(/payload: row\.payload,/);
    expect(body).toMatch(/ip_address: row\.ipAddress,/);
    expect(body).toMatch(/user_agent: row\.userAgent,/);
    expect(body).toMatch(/timestamp: row\.timestamp\.toISOString\(\),/);
  });

  it('List dispatch: spread-conditional cursor + action + from + to + actor_type → actorType + target_resource_id → targetResourceId + effectiveAccountId on team', () => {
    expect(body).toMatch(/const page = await accountAudit\.list\(ctx, \{/);
    expect(body).toMatch(/limit: parsed\.data\.limit,/);
    expect(body).toMatch(
      /\.\.\.\(parsed\.data\.cursor !== undefined \? \{ cursor: parsed\.data\.cursor \} : \{\}\),/,
    );
    expect(body).toMatch(
      /\.\.\.\(parsed\.data\.action !== undefined \? \{ action: parsed\.data\.action \} : \{\}\),/,
    );
    expect(body).toMatch(
      /\.\.\.\(parsed\.data\.from !== undefined \? \{ from: parsed\.data\.from \} : \{\}\),/,
    );
    expect(body).toMatch(
      /\.\.\.\(parsed\.data\.to !== undefined \? \{ to: parsed\.data\.to \} : \{\}\),/,
    );
    expect(body).toMatch(
      /\.\.\.\(parsed\.data\.actor_type !== undefined \? \{ actorType: parsed\.data\.actor_type \} : \{\}\),/,
    );
    expect(body).toMatch(
      /\.\.\.\(parsed\.data\.target_resource_id !== undefined\s*\n?\s*\? \{ targetResourceId: parsed\.data\.target_resource_id \}\s*\n?\s*: \{\}\),/,
    );
    expect(body).toMatch(
      /\.\.\.\(effective\.kind === 'team' \? \{ effectiveAccountId: effective\.accountId \} : \{\}\),/,
    );
  });

  it('Export: ExportQuerySchema format enum csv|json default json; EXPORT_MAX_ROWS=10_000 + EXPORT_PAGE_SIZE=200 constants', () => {
    expect(body).toMatch(
      /const ExportQuerySchema = z\.object\(\{\s*\n?\s*format: z\.enum\(\['csv', 'json'\]\)\.default\('json'\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(/const EXPORT_MAX_ROWS = 10_000;/);
    expect(body).toMatch(/const EXPORT_PAGE_SIZE = 200;/);
  });

  it('Export pagination walk: while length < EXPORT_MAX_ROWS; break on nextCursor === null; truncated = length >= EXPORT_MAX_ROWS', () => {
    expect(body).toMatch(
      /while \(all\.length < EXPORT_MAX_ROWS\) \{\s*\n?\s*const page = await accountAudit\.list\(ctx, \{\s*\n?\s*limit: EXPORT_PAGE_SIZE,\s*\n?\s*\.\.\.\(cursor !== undefined \? \{ cursor \} : \{\}\),\s*\n?\s*\.\.\.\(effective\.kind === 'team' \? \{ effectiveAccountId: effective\.accountId \} : \{\}\),\s*\n?\s*\}\);\s*\n?\s*all\.push\(\.\.\.page\.items\);\s*\n?\s*if \(page\.nextCursor === null\) break;/,
    );
    expect(body).toMatch(/const truncated = all\.length >= EXPORT_MAX_ROWS;/);
  });

  it('Export filenameBase: driftstack-audit-log-YYYY-MM-DD via toISOString().slice(0, 10)', () => {
    expect(body).toMatch(
      /const filenameBase = `driftstack-audit-log-\$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}`;/,
    );
  });

  it('Export CSV: 9-column header (timestamp/action/actor_type/actor_account_id/actor_key_id/target_resource_id/ip_address/user_agent/payload); CRLF row terminator; prefixed actor ids', () => {
    expect(body).toMatch(
      /const header = \[\s*\n?\s*'timestamp',\s*\n?\s*'action',\s*\n?\s*'actor_type',\s*\n?\s*'actor_account_id',\s*\n?\s*'actor_key_id',\s*\n?\s*'target_resource_id',\s*\n?\s*'ip_address',\s*\n?\s*'user_agent',\s*\n?\s*'payload',\s*\n?\s*\];/,
    );
    expect(body).toMatch(/row\.actorAccountId \? `acc_\$\{row\.actorAccountId\}` : '',/);
    expect(body).toMatch(/row\.actorKeyId \? `key_\$\{row\.actorKeyId\}` : '',/);
    expect(body).toMatch(/row\.payload === null \? '' : JSON\.stringify\(row\.payload\)/);
    expect(body).toMatch(
      /const csv = \[header, \.\.\.rows\]\.map\(\(cells\) => cells\.map\(csvEscape\)\.join\(','\)\)\.join\('\\r\\n'\);/,
    );
  });

  it('Export CSV headers: content-type text/csv utf-8 + content-disposition attachment filename .csv + x-driftstack-export-truncated header', () => {
    expect(body).toMatch(/\.header\('content-type', 'text\/csv; charset=utf-8'\)/);
    expect(body).toMatch(
      /\.header\('content-disposition', `attachment; filename="\$\{filenameBase\}\.csv"`\)/,
    );
    expect(body).toMatch(
      /\.header\('x-driftstack-export-truncated', truncated \? 'true' : 'false'\)/,
    );
  });

  it('Export JSON envelope: generated_at ISO + account_id=acc_ + row_count + truncated boolean + data: all.map(publicEntry); attachment .json + truncated header', () => {
    expect(body).toMatch(
      /\.send\(\{\s*\n?\s*generated_at: new Date\(\)\.toISOString\(\),\s*\n?\s*account_id: `acc_\$\{ctx\.account\.id\}`,\s*\n?\s*row_count: all\.length,\s*\n?\s*truncated,\s*\n?\s*data: all\.map\(publicEntry\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(/\.header\('content-type', 'application\/json; charset=utf-8'\)/);
    expect(body).toMatch(
      /\.header\('content-disposition', `attachment; filename="\$\{filenameBase\}\.json"`\)/,
    );
  });

  it('csvEscape: RFC 4180 — quote when comma/quote/newline; double up internal quotes', () => {
    expect(body).toMatch(
      /\/\*\*\s*\n?\s*\*\s*V-297 — CSV cell escape per RFC 4180\. Quote when the cell contains\s*\n?\s*\*\s*comma \/ quote \/ newline; double up internal quotes\.\s*\n?\s*\*\//,
    );
    expect(body).toMatch(
      /function csvEscape\(cell: string\): string \{\s*\n?\s*if \(\/\[",\\r\\n\]\/\.test\(cell\)\) \{\s*\n?\s*return `"\$\{cell\.replace\(\/"\/g, '""'\)\}"`;\s*\n?\s*\}\s*\n?\s*return cell;/,
    );
  });

  it('imports: FastifyInstance/FastifyRequest + ListAccountAuditLogQuerySchema + AccountAuditEntryRow/AccountAuditService + BadRequestError + resolveEffectiveAccount + zod', () => {
    expect(body).toMatch(/import type \{ FastifyInstance, FastifyRequest \} from 'fastify';/);
    expect(body).toMatch(
      /import type \{ AccountAuditEntryRow, AccountAuditService \} from '\.\.\/services\/account-audit\.js';/,
    );
    expect(body).toMatch(/import \{ BadRequestError \} from '\.\.\/lib\/errors\.js';/);
    expect(body).toMatch(/import \{ resolveEffectiveAccount \} from '\.\.\/services\/auth\.js';/);
    expect(body).toMatch(/import \{ z \} from 'zod';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
