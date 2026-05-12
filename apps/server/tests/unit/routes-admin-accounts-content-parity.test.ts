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
      /\/\/ Each endpoint:\s*\n?\s*\/\/\s*1\. Validates input \(Zod\)\.\s*\n?\s*\/\/\s*2\. Calls the AccountsAdminService — which checks the admin scope,\s*\n?\s*\/\/\s*mutates state, and invalidates the auth cache\.\s*\n?\s*\/\/\s*3\. Writes an admin_audit_log row BEFORE returning\. Audit failure\s*\n?\s*\/\/\s*fails the request \(D-025: audit-write-before-response is not\s*\n?\s*\/\/\s*best-effort\)\./,
    );
    expect(body).toMatch(
      /\/\/ The audit row records the input the admin sent, the action taken,\s*\n?\s*\/\/ and the result \(success or error code\)\. On NotFound we still write\s*\n?\s*\/\/ an audit row before re-throwing so the attempt is visible\./,
    );
  });

  it('imports: 9 Zod schemas from api-types + ListAdminAccountsQuerySchema inline (limit coerce 1..100 default 50 + cursor + status + tier + email_contains 1..254); AccountsAdminService + AccountAuditService + AdminAuditService/Action + AccountRow + RateLimitOverridesService + UsageService + BadRequestError', () => {
    expect(body).toMatch(
      /import \{\s*\n?\s*AccountStatusSchema,\s*\n?\s*AccountTierSchema,\s*\n?\s*AddSupportNoteRequestSchema,\s*\n?\s*ChangeTierRequestSchema,\s*\n?\s*ClearQuotaOverrideQuerySchema,\s*\n?\s*RecordRefundRequestSchema,\s*\n?\s*SetQuotaOverrideRequestSchema,\s*\n?\s*SuspendAccountRequestSchema,\s*\n?\s*UnsuspendAccountRequestSchema,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(
      /const ListAdminAccountsQuerySchema = z\.object\(\{\s*\n?\s*limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.default\(50\),\s*\n?\s*cursor: z\.string\(\)\.optional\(\),\s*\n?\s*status: AccountStatusSchema\.optional\(\),\s*\n?\s*tier: AccountTierSchema\.optional\(\),\s*\n?\s*email_contains: z\.string\(\)\.min\(1\)\.max\(254\)\.optional\(\),\s*\n?\s*\}\);/,
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
      /function publicAccount\(row: AccountRow\): Record<string, unknown> \{\s*\n?\s*return \{\s*\n?\s*id: `acc_\$\{row\.id\}`,\s*\n?\s*email: row\.email,\s*\n?\s*name: row\.name,\s*\n?\s*tier: row\.tier,\s*\n?\s*status: row\.status,\s*\n?\s*created_at: row\.createdAt\.toISOString\(\),\s*\n?\s*updated_at: row\.updatedAt\.toISOString\(\),\s*\n?\s*\};\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /function publicQuotaOverride\(r: RateLimitOverrideRecord\): Record<string, unknown> \{\s*\n?\s*return \{\s*\n?\s*account_id: `acc_\$\{r\.accountId\}`,\s*\n?\s*bucket_key: r\.bucketKey,\s*\n?\s*capacity: r\.capacity,\s*\n?\s*refill_per_second: r\.refillPerSecond,\s*\n?\s*reason: r\.reason,\s*\n?\s*expires_at: r\.expiresAt\.toISOString\(\),\s*\n?\s*created_at: r\.createdAt\.toISOString\(\),\s*\n?\s*updated_at: r\.updatedAt\.toISOString\(\),\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('clientIp helper: x-forwarded-for first entry trim → fallback to request.ip → null', () => {
    expect(body).toMatch(
      /function clientIp\(request: FastifyRequest\): string \| null \{\s*\n?\s*const xff = request\.headers\['x-forwarded-for'\];\s*\n?\s*if \(typeof xff === 'string' && xff\.length > 0\) \{\s*\n?\s*\/\/ First entry is the original client\.\s*\n?\s*const first = xff\.split\(','\)\[0\]\?\.trim\(\);\s*\n?\s*if \(first\) return first;\s*\n?\s*\}\s*\n?\s*return request\.ip \?\? null;\s*\n?\s*\}/,
    );
  });

  it('V-281 AdminAccountsRoutesOptions framing pinned: customer-audit recorder OPTIONAL during migration window; when omitted, new endpoints are not registered (accountAudit?)', () => {
    expect(body).toMatch(
      /\*\s*V-281 — customer-audit recorder\. Used by the new\s*\n?\s*\*\s*`audit-note` \+ `record-refund` endpoints to write a customer-\s*\n?\s*\*\s*visible audit row in addition to the admin-audit row\. Optional\s*\n?\s*\*\s*during the migration window — when omitted, the new endpoints\s*\n?\s*\*\s*are not registered\./,
    );
    expect(body).toMatch(/accountAudit\?: AccountAuditService;/);
  });

  it('withAudit wrapper: D-025 audit-before-response; success records result:"success"; error records result:`error: ${code}` (err.name lowercased + replace /error$/); re-throws after recording', () => {
    expect(body).toMatch(
      /\/\/ Helper that wraps a mutation with audit-on-success \+ audit-on-error\.\s*\n?\s*\/\/ The route logic stays focused on the action; the wrapper enforces\s*\n?\s*\/\/ D-025's "audit before response" contract\./,
    );
    expect(body).toMatch(
      /try \{\s*\n?\s*const updated = await perform\(\);\s*\n?\s*await audit\.record\(\{\s*\n?\s*adminAccountId: ctx\.account\.id,\s*\n?\s*adminKeyId: ctx\.apiKey\.id,\s*\n?\s*action,\s*\n?\s*targetAccountId,\s*\n?\s*inputPayload,\s*\n?\s*result: 'success',\s*\n?\s*ipAddress: clientIp\(request\),\s*\n?\s*\}\);\s*\n?\s*return updated;\s*\n?\s*\} catch \(err\) \{\s*\n?\s*const code =\s*\n?\s*err instanceof Error && err\.name \? err\.name\.toLowerCase\(\)\.replace\(\/error\$\/, ''\) : 'unknown';/,
    );
    expect(body).toMatch(/result: `error: \$\{code\}`,/);
  });

  it('POST /:id/tier: driftstack_internal_admin scope; ChangeTierRequest parse; withAudit action "account.tier_changed" with input {tier, reason?}; returns publicAccount', () => {
    expect(body).toMatch(
      /app\.post<\{ Params: \{ id: string \} \}>\(\s*\n?\s*'\/v1\/admin\/accounts\/:id\/tier',\s*\n?\s*\{\s*\n?\s*preHandler: \[app\.requireScope\('driftstack_internal_admin'\), app\.rateLimit\('global'\)\],\s*\n?\s*\},/,
    );
    expect(body).toMatch(
      /const updated = await withAudit\(\s*\n?\s*request,\s*\n?\s*'account\.tier_changed',\s*\n?\s*accountId,\s*\n?\s*\{ tier: body\.tier, \.\.\.\(body\.reason \? \{ reason: body\.reason \} : \{\}\) \},\s*\n?\s*\(\) => accountsAdmin\.changeTier\(ctx, accountId, body\.tier\),\s*\n?\s*\);/,
    );
  });

  it('POST /:id/suspend + unsuspend: SuspendAccountRequest/UnsuspendAccountRequest parse; withAudit "account.suspended" / "account.unsuspended" with optional reason; returns publicAccount', () => {
    expect(body).toMatch(
      /'account\.suspended',\s*\n?\s*accountId,\s*\n?\s*\{ \.\.\.\(body\.reason \? \{ reason: body\.reason \} : \{\}\) \},\s*\n?\s*\(\) => accountsAdmin\.suspend\(ctx, accountId\),/,
    );
    expect(body).toMatch(
      /'account\.unsuspended',\s*\n?\s*accountId,\s*\n?\s*\{ \.\.\.\(body\.reason \? \{ reason: body\.reason \} : \{\}\) \},\s*\n?\s*\(\) => accountsAdmin\.unsuspend\(ctx, accountId\),/,
    );
  });

  it('GET /v1/admin/accounts: cursor pagination via acc_<uuid> token; filters (status + tier + email_contains); response data + has_more + next_cursor (prefixed)', () => {
    expect(body).toMatch(
      /\/\/ List accounts with optional filters: status, tier, email substring\.\s*\n?\s*\/\/ Cursor pagination via `acc_<uuid>` cursor token\. Admin scope only\./,
    );
    expect(body).toMatch(
      /return \{\s*\n?\s*data: page\.data\.map\(publicAccount\),\s*\n?\s*has_more: page\.hasMore,\s*\n?\s*next_cursor: page\.nextCursor !== null \? `acc_\$\{page\.nextCursor\}` : null,\s*\n?\s*\};/,
    );
  });

  it("V-014/V-015 amendment framing pinned on GET /:id/usage: period + record_type facets only; 'by endpoint' deferred — usage_records.endpoint column doesn't exist AND production paths that write usage_records don't exist (recordUsage workstream gap)", () => {
    expect(body).toMatch(
      /\/\/ Period \+ record_type facets only\. "by endpoint" facet deferred per\s*\n?\s*\/\/ D-025: requires usage_records\.endpoint column \(doesn't exist\) AND\s*\n?\s*\/\/ production paths that write usage_records \(don't exist — see V-014\s*\n?\s*\/\/ \/ V-015 amendment for the recordUsage workstream gap\)\./,
    );
  });

  it('POST /:id/quota-override framing pinned: per-account per-bucket override w/ duration_seconds; loaded into AccountContext at auth time; consulted by rateLimitConsume; D-020 cache invalidation makes change effective on next auth read', () => {
    expect(body).toMatch(
      /\/\/ Set or replace a per-account, per-bucket rate-limit override with a\s*\n?\s*\/\/ duration \(seconds\)\. Override is loaded into AccountContext at auth\s*\n?\s*\/\/ time and consulted by rateLimitConsume; D-020 cache invalidation\s*\n?\s*\/\/ makes the change effective on the next auth read\./,
    );
    expect(body).toMatch(
      /const expiresAt = new Date\(Date\.now\(\) \+ body\.duration_seconds \* 1000\);/,
    );
  });

  it('V-281 audit-note framing pinned: dual-write (admin_audit_log via withAudit + customer account_audit via accountAudit.record); audit-only — no side effect on account state; both surfaces written so note visible on per-customer audit slice + admin audit table; 201 {ok:true}', () => {
    expect(body).toMatch(
      /\/\/ ── V-281 — POST \/v1\/admin\/accounts\/:id\/audit-note ─[\s\S]*?\/\/ Records a free-form admin support note on the customer's audit log\.\s*\n?\s*\/\/ Audit-only — no side effect on account state\. Both surfaces \(the\s*\n?\s*\/\/ admin_audit_log via withAudit, and the customer-visible\s*\n?\s*\/\/ account_audit log via accountAudit\.record\) are written so the note\s*\n?\s*\/\/ is visible on the per-customer audit slice \+ the admin audit table\./,
    );
    expect(body).toMatch(
      /await accountAudit\.record\(\{\s*\n?\s*accountId,\s*\n?\s*actorType: 'staff',\s*\n?\s*actorAccountId: ctx\.account\.id,\s*\n?\s*actorKeyId: ctx\.apiKey\.id,\s*\n?\s*action: 'admin\.support_note',\s*\n?\s*targetResourceId: null,\s*\n?\s*payload: \{ note: body\.note \},\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(/return reply\.code\(201\)\.send\(\{ ok: true as const \}\);/);
  });

  it('V-281 refund-record framing pinned: operator manually refunded via Stripe dashboard; audit-only — does NOT call Stripe; money movement always operator-driven via Stripe per V-280 launch-day runbook + founder tier-3 boundary on direct financial actions; currency defaults to "USD" if absent', () => {
    expect(body).toMatch(
      /\/\/ Records that the operator manually refunded a Stripe charge via\s*\n?\s*\/\/ the Stripe dashboard\. Audit-only — does NOT call Stripe\. Money\s*\n?\s*\/\/ movement is always operator-driven via Stripe per the V-280\s*\n?\s*\/\/ launch-day runbook \+ the founder's tier-3 boundary on direct\s*\n?\s*\/\/ financial actions\./,
    );
    expect(body).toMatch(
      /const payload = \{\s*\n?\s*external_reference: body\.external_reference,\s*\n?\s*amount_cents: body\.amount_cents,\s*\n?\s*currency: body\.currency \?\? 'USD',\s*\n?\s*reason: body\.reason,\s*\n?\s*\};/,
    );
    expect(body).toMatch(
      /action: 'admin\.refund_recorded',\s*\n?\s*targetResourceId: body\.external_reference,/,
    );
  });

  it('withAuditOverride: records targetResourceId=bucketKey + success/error result; withAuditOverrideClear hardcodes action "rate_limit_override.cleared"', () => {
    expect(body).toMatch(
      /async function withAuditOverride\(\s*\n?\s*request: FastifyRequest,\s*\n?\s*action: AdminAuditAction,\s*\n?\s*targetAccountId: string,\s*\n?\s*bucketKey: string,\s*\n?\s*inputPayload: Record<string, unknown>,\s*\n?\s*perform: \(\) => Promise<RateLimitOverrideRecord>,\s*\n?\s*\): Promise<RateLimitOverrideRecord> \{/,
    );
    expect(body).toMatch(
      /action: 'rate_limit_override\.cleared',\s*\n?\s*targetAccountId,\s*\n?\s*targetResourceId: bucketKey,\s*\n?\s*inputPayload: \{ bucket_key: bucketKey \},/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
