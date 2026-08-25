// W1053 — routes/admin-accounts D-025 + V-281 cross-source invariant.
// Pins apps/server/src/routes/admin-accounts.ts admin customer-account
// management surface. The file is large (10+ endpoints); this pin
// focuses on the cross-cutting invariants every endpoint relies on:
//
//   Header anchor — 'Admin-only account routes — /v1/admin/accounts/:id
//   /{tier,suspend,unsuspend}'.
//
//   D-025 audit-write-before-response framing — 'Each endpoint: ... 3.
//   Writes an admin_audit_log row BEFORE returning. Audit failure
//   fails the request (D-025: audit-write-before-response is not
//   best-effort)'. NotFound still writes an audit row before
//   re-throwing.
//
//   driftstack_internal_admin scope on every endpoint + global rate-
//   limit chain.
//
//   PUBLIC_ID_RE — '^[a-z]{3}_(uuid)$'.
//
//   publicAccount envelope — 7 fields (acc_ id / email / name / tier /
//   status / created_at ISO / updated_at ISO).
//
//   publicQuotaOverride envelope — 8 fields with bucket_key + capacity
//   + refill_per_second + expires_at.
//
//   publicUsage envelope — 6 fields with account_id acc_-prefixed +
//   tier + totals + quotas.
//
//   withAudit error-code derivation — strips 'Error' suffix + lowercase,
//   surfaces as 'error: <code>'. Same pattern as admin-incidents,
//   admin-webhooks, admin-force-actions.
//
//   trustProxy-resolved request.ip for D-025 IP capture.
//
//   V-281 optional accountAudit dep — when omitted, the audit-note +
//   record-refund endpoints stay unregistered.
//
//   ListAdminAccountsQuerySchema — limit 1..100 default 50 + cursor +
//   status + tier + email_contains 1..254.
//
//   AdminAuditAction strings — account.tier_changed + account.suspended +
//   account.unsuspended (at minimum).
//
// stays in lockstep across apps/server/src/routes/admin-accounts.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  return readFileSync(p, 'utf8');
}

describe('W1053 routes/admin-accounts D-025 + V-281 cross-source invariant', () => {
  // ─── Header anchor + D-025 framing ───────────────────────────

  it("CRITICAL header anchor — 'Admin-only account routes — /v1/admin/accounts/:id/{tier,suspend,unsuspend}'. The single-anchor pattern points at the canonical 3-mutation set; later endpoints (audit-note, record-refund, quota-override) layered on top.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts'));
    expect(p).toMatch(
      /Admin-only account routes — \/v1\/admin\/accounts\/:id\/\{tier,suspend,unsuspend\}\./,
    );
  });

  it("CRITICAL D-025 audit-write-before-response framing — 'Each endpoint: 1. Validates input (Zod). 2. Calls the AccountsAdminService — which checks the admin scope, mutates state, and invalidates the auth cache. 3. Writes an admin_audit_log row BEFORE returning. Audit failure fails the request (D-025: audit-write-before-response is not best-effort)'. The 3-step contract is identical across admin mutation routes.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts'));
    expect(p).toMatch(/Validates input \(Zod\)\./);
    expect(p).toMatch(/Calls the AccountsAdminService — which checks the admin scope,/);
    expect(p).toMatch(/mutates state, and invalidates the auth cache\./);
    expect(p).toMatch(/Writes an admin_audit_log row BEFORE returning\. Audit failure/);
    expect(p).toMatch(/fails the request \(D-025: audit-write-before-response is not/);
    expect(p).toMatch(/best-effort\)\./);
  });

  it("CRITICAL NotFound-still-audited framing — 'On NotFound we still write an audit row before re-throwing so the attempt is visible'. The attempt-visibility design is what makes admin enumeration detectable.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts'));
    expect(p).toMatch(/On NotFound we still write/);
    expect(p).toMatch(/an audit row before re-throwing so the attempt is visible\./);
  });

  // ─── PUBLIC_ID_RE ────────────────────────────────────────────

  it("CRITICAL PUBLIC_ID_RE — '^[a-z]{3}_(uuid)$'. Shared with admin-incidents + admin-webhooks + admin-force-actions; cross-route prefix-id family consistency.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts'));
    expect(p).toMatch(
      /const PUBLIC_ID_RE = \/\^\[a-z\]\{3\}_\(\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\)\$\//,
    );
  });

  // ─── publicAccount envelope ──────────────────────────────────

  it('CRITICAL publicAccount envelope — 7 fields (acc_ id / email / name / tier / status / created_at ISO / updated_at ISO). The flat shape is what the admin-panel customer-list page consumes.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts'));
    expect(p).toMatch(/id: `acc_\$\{row\.id\}`,/);
    expect(p).toMatch(/email: row\.email,/);
    expect(p).toMatch(/name: row\.name,/);
    expect(p).toMatch(/tier: row\.tier,/);
    expect(p).toMatch(/status: row\.status,/);
    expect(p).toMatch(/created_at: row\.createdAt\.toISOString\(\),/);
    expect(p).toMatch(/updated_at: row\.updatedAt\.toISOString\(\),/);
  });

  // ─── publicQuotaOverride envelope ────────────────────────────

  it('CRITICAL publicQuotaOverride envelope — 8 fields with acc_-prefixed account_id + bucket_key + capacity + refill_per_second + reason + expires_at ISO + created_at ISO + updated_at ISO. The shape supports the admin panel rate-limit-override UI.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts'));
    expect(p).toMatch(/account_id: `acc_\$\{r\.accountId\}`,/);
    expect(p).toMatch(/bucket_key: r\.bucketKey,/);
    expect(p).toMatch(/capacity: r\.capacity,/);
    expect(p).toMatch(/refill_per_second: r\.refillPerSecond,/);
    expect(p).toMatch(/reason: r\.reason,/);
    expect(p).toMatch(/expires_at: r\.expiresAt\.toISOString\(\),/);
  });

  // ─── publicUsage envelope ────────────────────────────────────

  it('CRITICAL publicUsage envelope — 6 fields with account_id acc_-prefixed + period_start/end ISO + tier + totals + quotas. Same flat shape as /v1/usage but with an explicit account_id field (since admin route can target any account).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts'));
    expect(p).toMatch(/account_id: `acc_\$\{accountId\}`,/);
    expect(p).toMatch(/period_start: s\.periodStart\.toISOString\(\),/);
    expect(p).toMatch(/period_end: s\.periodEnd\.toISOString\(\),/);
    expect(p).toMatch(/tier: s\.tier,/);
    expect(p).toMatch(/totals: s\.totals,/);
    expect(p).toMatch(/quotas: s\.quotas,/);
  });

  // ─── withAudit pattern ───────────────────────────────────────

  it('CRITICAL withAudit pattern — audit-on-success + audit-on-error with error-code derivation (strip Error suffix + lowercase). Same pattern as admin-incidents, admin-webhooks, admin-force-actions; drift would diverge admin-audit-log filter chips.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts'));
    expect(p).toMatch(/D-025's "audit before response" contract/);
    expect(p).toMatch(
      /err instanceof Error && err\.name \? err\.name\.toLowerCase\(\)\.replace\(\/error\$\/, ''\) : 'unknown'/,
    );
    expect(p).toMatch(/result: `error: \$\{code\}`,/);
  });

  // ─── Admin scope + rate-limit chain ──────────────────────────

  it('CRITICAL driftstack_internal_admin + global rate-limit on every endpoint. 10+ endpoints uniformly require admin scope; drift on any one would let normal customer keys hit admin tooling.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts'));
    const refs =
      p.match(
        /preHandler: \[app\.requireScope\('driftstack_internal_admin'\), app\.rateLimit\('global'\)\]/g,
      ) ?? [];
    expect(refs.length, 'admin+rate-limit chain count').toBeGreaterThanOrEqual(10);
  });

  // ─── ListAdminAccountsQuerySchema ────────────────────────────

  it('CRITICAL ListAdminAccountsQuerySchema — limit z.coerce.number().int().min(1).max(100).default(50) + cursor + status + tier + email_contains 1..254. The 254-char email_contains cap matches RFC 5321 max email length.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts'));
    expect(p).toMatch(
      /limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.default\(50\),/,
    );
    expect(p).toMatch(/cursor: z\.string\(\)\.min\(1\)\.max\(512\)\.optional\(\),/);
    expect(p).toMatch(/email_contains: z\.string\(\)\.min\(1\)\.max\(254\)\.optional\(\),/);
  });

  // ─── AdminAuditAction taxonomy (core mutations) ──────────────

  it("CRITICAL AdminAuditAction taxonomy — at minimum 'account.tier_changed' + 'account.suspended' + 'account.unsuspended'. The 3-action canonical mutation set anchored by the header comment.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts'));
    expect(p).toMatch(/withAudit\(\s*request,\s*'account\.tier_changed',/);
    expect(p).toMatch(/'account\.suspended',/);
    expect(p).toMatch(/'account\.unsuspended',/);
  });

  // ─── V-281 optional accountAudit dep ─────────────────────────

  it("CRITICAL V-281 optional accountAudit dep framing — 'V-281 — customer-audit recorder. Used by the new audit-note + record-refund endpoints to write a customer-visible audit row in addition to the admin-audit row. Optional during the migration window — when omitted, the new endpoints are not registered'. The optional-dep design lets the supplemental V-281 endpoints land independent of the core ones.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts'));
    expect(p).toMatch(/V-281 — customer-audit recorder\. Used by the new/);
    expect(p).toMatch(/`audit-note` \+ `record-refund` endpoints to write a customer-/);
    expect(p).toMatch(/visible audit row in addition to the admin-audit row\. Optional/);
    expect(p).toMatch(/during the migration window — when omitted, the new endpoints/);
    expect(p).toMatch(/are not registered\./);
  });

  // ─── trusted-proxy-aware client IP ───────────────────────────

  it('CRITICAL clientIp uses shared trustProxy-resolved request.ip for D-025 audit-IP capture.', () => {
    const route = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts'));
    expect(route).toMatch(/import \{ readClientIp \} from '\.\.\/lib\/client-ip\.js';/);
    const lib = read(resolve(REPO_ROOT, 'apps/server/src/lib/client-ip.ts'));
    expect(lib).toMatch(/return request\.ip \?\? null;/);
    expect(lib).not.toMatch(/request\.headers\['x-forwarded-for'\]/);
  });

  // ─── List response envelope ──────────────────────────────────

  it('CRITICAL list response shape — { data, has_more, next_cursor }. The 3-field paged envelope shape is shared across the admin surface; next_cursor carries the acc_-prefixed id when present.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts'));
    expect(p).toMatch(/data: page\.data\.map\(publicAccount\),/);
    expect(p).toMatch(/has_more: page\.hasMore,/);
    expect(p).toMatch(
      /next_cursor: page\.nextCursor !== null \? `acc_\$\{page\.nextCursor\}` : null,/,
    );
  });
});
