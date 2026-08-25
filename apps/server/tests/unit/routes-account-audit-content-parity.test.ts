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
      /GET \/v1\/account\/audit-log — list the calling account's own audit\s*\/\/\s*entries \(newest first, cursor-paginated, optional action filter\)\./,
    );
  });

  it('V-297 framing pinned: csv|json export + GDPR Article 20 portability + 10k ceiling + ?since pagination', () => {
    expect(body).toMatch(
      /V-297 — `GET \/v1\/account\/audit-log\/export\?format=csv\|json` exports\s*\/\/\s*the full audit log for the calling account as a single download\.\s*\/\/\s*CSV for spreadsheets \/ GDPR Article 20 portability; JSON for\s*\/\/\s*programmatic consumers\. Server-side ceiling: 10,000 rows per export\s*\/\/\s*to avoid pathological cases\. Pagination via subsequent\s*\/\/\s*`\?since=<timestamp>` calls if more is needed \(rare in practice\)\./,
    );
  });

  it('V-330b framing pinned: X-Driftstack-Account team-member read; both member + admin roles read-only', () => {
    expect(body).toMatch(
      /\/\/ V-330b — honor X-Driftstack-Account: a team member with a\s*\/\/ valid membership reads the owner's audit log\. Read-only;\s*\/\/ both 'member' and 'admin' roles allowed\./,
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

  it('publicEntry: 10-field shape with account_id=acc_ + actor_account_id/actor_key_id nullable prefixed + ISO timestamp; payload/ip/ua conditionally scrubbed for cross-actor (team-member) views UNIONED with the per-row actor-differs check', () => {
    expect(body).toMatch(
      /function publicEntry\(\s*row: AccountAuditEntryRow,\s*redactActorPrivacy = false,?\s*\): Record<string, unknown> \{/,
    );
    // Union: request-level team-header redaction OR the row's own actor
    // differing from the account it belongs to (e.g. a staff support-note
    // row a customer later self-reads) — both must redact.
    expect(body).toMatch(
      /const redact = redactActorPrivacy \|\| rowNeedsActorPrivacyRedaction\(row\);/,
    );
    expect(body).toMatch(
      /function rowNeedsActorPrivacyRedaction\(row: AccountAuditEntryRow\): boolean \{\s*return row\.actorAccountId !== null && row\.actorAccountId !== row\.accountId;\s*\}/,
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
    // Privacy scrub: a team-member cross-actor view OR a per-row actor
    // mismatch nulls ip/ua + strips the IP/UA payload keys; the owner's
    // own view of their own rows keeps them (GDPR Art-15).
    expect(body).toMatch(/payload: redact \? scrubActorPrivacy\(row\.payload\) : row\.payload,/);
    expect(body).toMatch(/ip_address: redact \? null : row\.ipAddress,/);
    expect(body).toMatch(/user_agent: redact \? null : row\.userAgent,/);
    expect(body).toMatch(/timestamp: row\.timestamp\.toISOString\(\),/);
    // The request-level half of the redaction fires on the team
    // (cross-actor) read + export paths only.
    expect(body).toMatch(/const redactActorPrivacy = effective\.kind === 'team';/);
    expect(body).toMatch(/const ACTOR_PRIVACY_PAYLOAD_KEYS = new Set\(\[/);
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
      /\.\.\.\(parsed\.data\.target_resource_id !== undefined\s*\? \{ targetResourceId: parsed\.data\.target_resource_id \}\s*: \{\}\),/,
    );
    expect(body).toMatch(
      /\.\.\.\(effective\.kind === 'team' \? \{ effectiveAccountId: effective\.accountId \} : \{\}\),/,
    );
  });

  it('Export: ExportQuerySchema format enum csv|json default json; EXPORT_MAX_ROWS=10_000 + EXPORT_PAGE_SIZE=200 constants', () => {
    expect(body).toMatch(
      /const ExportQuerySchema = z\.object\(\{\s*format: z\.enum\(\['csv', 'json'\]\)\.default\('json'\),\s*\}\);/,
    );
    expect(body).toMatch(/const EXPORT_MAX_ROWS = 10_000;/);
    expect(body).toMatch(/const EXPORT_PAGE_SIZE = 200;/);
  });

  it('Export pagination walk: while length < EXPORT_MAX_ROWS; break on nextCursor === null; truncated = length >= EXPORT_MAX_ROWS', () => {
    expect(body).toMatch(
      /while \(all\.length < EXPORT_MAX_ROWS\) \{\s*const page = await accountAudit\.list\(ctx, \{\s*limit: EXPORT_PAGE_SIZE,\s*\.\.\.\(cursor !== undefined \? \{ cursor \} : \{\}\),\s*\.\.\.\(effective\.kind === 'team' \? \{ effectiveAccountId: effective\.accountId \} : \{\}\),\s*\}\);\s*all\.push\(\.\.\.page\.items\);\s*if \(page\.nextCursor === null\) break;/,
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
      /const header = \[\s*'timestamp',\s*'action',\s*'actor_type',\s*'actor_account_id',\s*'actor_key_id',\s*'target_resource_id',\s*'ip_address',\s*'user_agent',\s*'payload',\s*\];/,
    );
    expect(body).toMatch(/row\.actorAccountId \? `acc_\$\{row\.actorAccountId\}` : '',/);
    expect(body).toMatch(/row\.actorKeyId \? `key_\$\{row\.actorKeyId\}` : '',/);
    // ip/ua + payload conditionally scrubbed for a cross-actor (team) export
    // UNIONED with the per-row actor-differs check (same as publicEntry).
    expect(body).toMatch(
      /const redact = redactActorPrivacy \|\| rowNeedsActorPrivacyRedaction\(row\);/,
    );
    expect(body).toMatch(/redact \? '' : \(row\.ipAddress \?\? ''\)/);
    expect(body).toMatch(
      /const payload = redact \? scrubActorPrivacy\(row\.payload\) : row\.payload;/,
    );
    expect(body).toMatch(/const csv = buildCsv\(\{ header, rows \}\);/);
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

  it('Export JSON envelope: generated_at ISO + account_id labelled with the SCOPED account (owner under a team export, caller otherwise) + row_count + truncated boolean + data: all.map(publicEntry); attachment .json + truncated header', () => {
    expect(body).toContain('generated_at: new Date().toISOString(),');
    // The envelope must label the account whose rows these ARE (mirrors the
    // data scope), not always the calling member.
    expect(body).toContain(
      "account_id: `acc_${effective.kind === 'team' ? effective.accountId : ctx.account.id}`,",
    );
    expect(body).toMatch(
      /row_count: all\.length,\s*truncated,\s*data: all\.map\(\(row\) => publicEntry\(row, redactActorPrivacy\)\),/,
    );
    expect(body).toMatch(/\.header\('content-type', 'application\/json; charset=utf-8'\)/);
    expect(body).toMatch(
      /\.header\('content-disposition', `attachment; filename="\$\{filenameBase\}\.json"`\)/,
    );
  });

  it('CSV export uses the shared buildCsv helper (RFC 4180 + CWE-1236 formula-injection guard), not a local escaper', () => {
    expect(body).toMatch(/import \{ buildCsv \} from '\.\.\/lib\/csv\.js';/);
    // The local RFC-4180-only csvEscape was removed — buildCsv applies
    // the formula-injection guard that audit free-text (user_agent)
    // needs.
    expect(body).not.toMatch(/function csvEscape\(/);
    expect(body).toMatch(/buildCsv applies the shared CSV formula-injection guard/);
  });

  it('imports: FastifyInstance/FastifyRequest + ListAccountAuditLogQuerySchema + AccountAuditEntryRow/AccountAuditService + BadRequestError + resolveEffectiveAccount + zod', () => {
    expect(body).toMatch(/import type \{ FastifyInstance \} from 'fastify';/);
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
