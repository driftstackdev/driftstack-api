// W438.A — drift guard for apps/server/src/routes/admin-accounts.ts.
// /v1/admin/accounts/* mutations + D-025 audit-write-before-response
// + V-281 customer-audit dual-write + V-014/V-015 deferred-facet
// rationale. Drift here either drops the D-025 contract (audit row
// becomes best-effort and operator action is invisible on failure)
// or weakens the driftstack_internal_admin scope gate (any admin
// scope reaches admin endpoints).
//
//   • D-025 framing pinned: audit-row written BEFORE response;
//     audit-failure fails request; even NotFound writes audit row
//     before re-throw (visible attempt).
//   • Every admin route gated by driftstack_internal_admin scope.
//   • withAudit / withAuditOverride / withAuditOverrideClear
//     helpers: success records result:'success'; error records
//     result:`error: <code>` from err.name lowercased minus 'error'.
//   • V-281 dual-write framing: accountAudit recorder is OPTIONAL —
//     when omitted, audit-note + refund-record endpoints not
//     registered (migration window).
//   • V-281 refund-record rationale: audit-only; never calls Stripe;
//     V-280 launch runbook + founder tier-3 boundary on direct
//     financial actions.
//   • V-014/V-015 amendment: "by endpoint" facet on usage deferred
//     (usage_records.endpoint column missing + no production paths
//     write usage_records yet).
//   • D-020 cache invalidation rationale on quota-override.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W438.A apps/server/src/routes/admin-accounts.ts content parity', () => {
  const body = read(LIB);

  it('D-025 framing pinned: audit-write-before-response is NOT best-effort; each endpoint validates input (Zod) → calls AccountsAdminService (checks admin scope, mutates state, invalidates auth cache) → writes admin_audit_log row BEFORE returning; audit failure fails request; on NotFound still write audit row before re-throw so attempt visible', () => {
    expect(body).toMatch(
      /\/\/ Admin-only account routes — \/v1\/admin\/accounts\/:id\/\{tier,suspend,unsuspend\}\./,
    );
    expect(body).toMatch(
      /\/\/ Each endpoint:\s*\/\/\s*1\. Validates input \(Zod\)\.\s*\/\/\s*2\. Calls the AccountsAdminService — which checks the admin scope,\s*\/\/\s*mutates state, and invalidates the auth cache\.\s*\/\/\s*3\. Writes an admin_audit_log row BEFORE returning\. Audit failure\s*\/\/\s*fails the request \(D-025: audit-write-before-response is not\s*\/\/\s*best-effort\)\./,
    );
    expect(body).toMatch(
      /\/\/ The audit row records the input the admin sent, the action taken,\s*\/\/ and the result \(success or error code\)\. On NotFound we still write\s*\/\/ an audit row before re-throwing so the attempt is visible\./,
    );
  });

  it('imports: 9 Zod schemas from api-types + ListAdminAccountsQuerySchema inline (limit coerce 1..100 default 50 + cursor + status + tier + email_contains 1..254); AccountsAdminService + AccountAuditService + AdminAuditService/Action + AccountRow + RateLimitOverridesService + UsageService + BadRequestError', () => {
    expect(body).toMatch(
      /import \{\s*AccountStatusSchema,\s*AccountTierSchema,\s*AddSupportNoteRequestSchema,\s*ChangeTierRequestSchema,\s*ClearQuotaOverrideQuerySchema,\s*DeleteAccountRequestSchema,\s*RecordRefundRequestSchema,\s*SetQuotaOverrideRequestSchema,\s*SuspendAccountRequestSchema,\s*UnsuspendAccountRequestSchema,\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(
      /const ListAdminAccountsQuerySchema = z\.object\(\{\s*limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.default\(50\),[\s\S]*?cursor: z\.string\(\)\.min\(1\)\.max\(512\)\.optional\(\),\s*status: AccountStatusSchema\.optional\(\),\s*tier: AccountTierSchema\.optional\(\),\s*email_contains: z\.string\(\)\.min\(1\)\.max\(254\)\.optional\(\),\s*\}\);/,
    );
    expect(body).toMatch(
      /import type \{ AccountsAdminService \} from '\.\.\/services\/admin-accounts\.js';/,
    );
    expect(body).toMatch(
      /import type \{ AccountAuditService \} from '\.\.\/services\/account-audit\.js';/,
    );
    expect(body).toMatch(
      /import type \{ AdminAuditService, AdminAuditAction \} from '\.\.\/services\/admin-audit\.js';/,
    );
  });

  it('publicAccount mapper (7-field: id acc_ + email + name + tier + status + created/updated_at); publicQuotaOverride mapper (8-field: account_id + bucket_key + capacity + refill_per_second + reason + expires_at + 2 timestamps); publicUsage (account_id acc_ + 4 fields incl. tier + totals + quotas)', () => {
    expect(body).toMatch(
      /function publicAccount\(row: AccountRow\): Record<string, unknown> \{\s*return \{\s*id: `acc_\$\{row\.id\}`,\s*email: row\.email,\s*name: row\.name,\s*tier: row\.tier,\s*status: row\.status,\s*created_at: row\.createdAt\.toISOString\(\),\s*updated_at: row\.updatedAt\.toISOString\(\),\s*\};\s*\}/,
    );
    expect(body).toMatch(
      /function publicQuotaOverride\(r: RateLimitOverrideRecord\): Record<string, unknown> \{\s*return \{\s*account_id: `acc_\$\{r\.accountId\}`,\s*bucket_key: r\.bucketKey,\s*capacity: r\.capacity,\s*refill_per_second: r\.refillPerSecond,\s*reason: r\.reason,\s*expires_at: r\.expiresAt\.toISOString\(\),\s*created_at: r\.createdAt\.toISOString\(\),\s*updated_at: r\.updatedAt\.toISOString\(\),\s*\};\s*\}/,
    );
  });

  it('readClientIp imported from shared lib/client-ip.ts (extracted to collapse drift across admin-* routes)', () => {
    expect(body).toMatch(/import \{ readClientIp \} from '\.\.\/lib\/client-ip\.js';/);
    expect(body).toMatch(/ipAddress: readClientIp\(request\),/);
  });

  it('V-281 AdminAccountsRoutesOptions framing pinned: customer-audit recorder OPTIONAL during migration window; when omitted, new endpoints are not registered (accountAudit?)', () => {
    expect(body).toMatch(
      /\*\s*V-281 — customer-audit recorder\. Used by the new\s*\*\s*`audit-note` \+ `record-refund` endpoints to write a customer-\s*\*\s*visible audit row in addition to the admin-audit row\. Optional\s*\*\s*during the migration window — when omitted, the new endpoints\s*\*\s*are not registered\./,
    );
    expect(body).toMatch(/accountAudit\?: AccountAuditService;/);
  });

  it('withAudit wrapper: D-025 audit-before-response; success records result:"success"; error records result:`error: ${code}` (err.name lowercased + replace /error$/); re-throws after recording', () => {
    expect(body).toMatch(
      /\/\/ Helper that wraps a mutation with audit-on-success \+ audit-on-error\.\s*\/\/ The route logic stays focused on the action; the wrapper enforces\s*\/\/ D-025's "audit before response" contract\./,
    );
    expect(body).toMatch(
      /try \{\s*const updated = await perform\(\);\s*await audit\.record\(\{\s*adminAccountId: ctx\.account\.id,\s*adminKeyId: ctx\.apiKey\.id,\s*action,\s*targetAccountId,\s*inputPayload,\s*result: 'success',\s*ipAddress: readClientIp\(request\),\s*\}\);\s*return updated;\s*\} catch \(err\) \{\s*const code =\s*err instanceof Error && err\.name \? err\.name\.toLowerCase\(\)\.replace\(\/error\$\/, ''\) : 'unknown';/,
    );
    expect(body).toMatch(/result: `error: \$\{code\}`,/);
  });

  it('POST /:id/tier: driftstack_internal_admin scope; ChangeTierRequest parse; withAudit action "account.tier_changed" with input {tier, reason?}; returns publicAccount', () => {
    expect(body).toMatch(
      /app\.post<\{ Params: \{ id: string \} \}>\(\s*'\/v1\/admin\/accounts\/:id\/tier',\s*\{\s*preHandler: \[app\.requireScope\('driftstack_internal_admin'\), app\.rateLimit\('global'\)\],\s*\},/,
    );
    expect(body).toMatch(
      /const updated = await withAudit\(\s*request,\s*'account\.tier_changed',\s*accountId,\s*\{ tier: body\.tier, \.\.\.\(body\.reason \? \{ reason: body\.reason \} : \{\}\) \},\s*\(\) => accountsAdmin\.changeTier\(ctx, accountId, body\.tier\),\s*\);/,
    );
  });

  it('POST /:id/suspend + unsuspend: SuspendAccountRequest/UnsuspendAccountRequest parse; withAudit "account.suspended" / "account.unsuspended" with optional reason; returns publicAccount', () => {
    expect(body).toMatch(
      /'account\.suspended',\s*accountId,\s*\{ \.\.\.\(body\.reason \? \{ reason: body\.reason \} : \{\}\) \},\s*\(\) => accountsAdmin\.suspend\(ctx, accountId\),/,
    );
    expect(body).toMatch(
      /'account\.unsuspended',\s*accountId,\s*\{ \.\.\.\(body\.reason \? \{ reason: body\.reason \} : \{\}\) \},\s*\(\) => accountsAdmin\.unsuspend\(ctx, accountId\),/,
    );
  });

  it('GET /v1/admin/accounts: cursor pagination via acc_<uuid> token; filters (status + tier + email_contains); response data + has_more + next_cursor (prefixed)', () => {
    expect(body).toMatch(
      /\/\/ List accounts with optional filters: status, tier, email substring\.\s*\/\/ Cursor pagination via `acc_<uuid>` cursor token\. Admin scope only\./,
    );
    expect(body).toMatch(
      /return \{\s*data: page\.data\.map\(publicAccount\),\s*has_more: page\.hasMore,\s*next_cursor: page\.nextCursor !== null \? `acc_\$\{page\.nextCursor\}` : null,\s*\};/,
    );
  });

  it("V-014/V-015 amendment framing pinned on GET /:id/usage: period + record_type facets only; 'by endpoint' deferred — usage_records.endpoint column doesn't exist AND production paths that write usage_records don't exist (recordUsage workstream gap)", () => {
    expect(body).toMatch(
      /\/\/ Period \+ record_type facets only\. "by endpoint" facet deferred per\s*\/\/ D-025: requires usage_records\.endpoint column \(doesn't exist\) AND\s*\/\/ production paths that write usage_records \(don't exist — see V-014\s*\/\/ \/ V-015 amendment for the recordUsage workstream gap\)\./,
    );
  });

  it('POST /:id/quota-override framing pinned: per-account per-bucket override w/ duration_seconds; loaded into AccountContext at auth time; consulted by rateLimitConsume; D-020 cache invalidation makes change effective on next auth read', () => {
    expect(body).toMatch(
      /\/\/ Set or replace a per-account, per-bucket rate-limit override with a\s*\/\/ duration \(seconds\)\. Override is loaded into AccountContext at auth\s*\/\/ time and consulted by rateLimitConsume; D-020 cache invalidation\s*\/\/ makes the change effective on the next auth read\./,
    );
    expect(body).toMatch(
      /const expiresAt = new Date\(Date\.now\(\) \+ body\.duration_seconds \* 1000\);/,
    );
  });

  it('V-281 audit-note framing pinned: dual-write (admin_audit_log via withAudit + customer account_audit via accountAudit.record); audit-only — no side effect on account state; both surfaces written so note visible on per-customer audit slice + admin audit table; 201 {ok:true}', () => {
    expect(body).toMatch(
      /\/\/ ── V-281 — POST \/v1\/admin\/accounts\/:id\/audit-note ─[\s\S]*?\/\/ Records a free-form admin support note on the customer's audit log\.\s*\/\/ Audit-only — no side effect on account state\. Both surfaces \(the\s*\/\/ admin_audit_log via withAudit, and the customer-visible\s*\/\/ account_audit log via accountAudit\.record\) are written so the note\s*\/\/ is visible on the per-customer audit slice \+ the admin audit table\./,
    );
    expect(body).toMatch(
      /await accountAudit\.record\(\{\s*accountId,\s*actorType: 'staff',\s*actorAccountId: ctx\.account\.id,\s*actorKeyId: ctx\.apiKey\.id,\s*action: 'admin\.support_note',\s*targetResourceId: null,\s*payload: \{ note: body\.note \},\s*ipAddress: readClientIp\(request\),\s*\}\);/,
    );
    expect(body).toMatch(/return reply\.code\(201\)\.send\(\{ ok: true as const \}\);/);
  });

  it('V-281 refund-record framing pinned: operator manually refunded via Stripe dashboard; audit-only — does NOT call Stripe; money movement always operator-driven via Stripe per V-280 launch-day runbook + founder tier-3 boundary on direct financial actions; currency defaults to "USD" if absent', () => {
    expect(body).toMatch(
      /\/\/ Records that the operator manually refunded a Stripe charge via\s*\/\/ the Stripe dashboard\. Audit-only — does NOT call Stripe\. Money\s*\/\/ movement is always operator-driven via Stripe per the V-280\s*\/\/ launch-day runbook \+ the founder's tier-3 boundary on direct\s*\/\/ financial actions\./,
    );
    expect(body).toMatch(
      /const payload = \{\s*external_reference: body\.external_reference,\s*amount_cents: body\.amount_cents,\s*currency: body\.currency \?\? 'USD',\s*reason: body\.reason,\s*\};/,
    );
    expect(body).toMatch(
      /action: 'admin\.refund_recorded',\s*targetResourceId: body\.external_reference,/,
    );
  });

  it('withAuditOverride: records targetResourceId=bucketKey + success/error result; withAuditOverrideClear hardcodes action "rate_limit_override.cleared"', () => {
    expect(body).toMatch(
      /async function withAuditOverride\(\s*request: FastifyRequest,\s*action: AdminAuditAction,\s*targetAccountId: string,\s*bucketKey: string,\s*inputPayload: Record<string, unknown>,\s*perform: \(\) => Promise<RateLimitOverrideRecord>,\s*\): Promise<RateLimitOverrideRecord> \{/,
    );
    expect(body).toMatch(
      /action: 'rate_limit_override\.cleared',\s*targetAccountId,\s*targetResourceId: bucketKey,\s*inputPayload: \{ bucket_key: bucketKey \},/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
