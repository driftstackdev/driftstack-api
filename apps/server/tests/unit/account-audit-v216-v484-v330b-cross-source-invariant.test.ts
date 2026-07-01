// W937 — V-216 + V-484 + V-330b customer-facing account-audit
// cross-source invariant. Two-hundred-sixty-third in the drift-
// guard series. Pins the customer-scoped audit service:
//
//   V-216 anchor — 'customer-facing audit log service'.
//
//   Mirrors admin-audit service shape but customer-scoped:
//     - 'list(accountId) returns only the calling account's own
//       entries, gated on account_owner scope'.
//     - list() itself is gated on the granular read:audit scope
//       (V-553.B-21; account_owner still satisfies it via V-481
//       broad-satisfies-granular).
//     - Append-only contract: insert + list, no update / delete.
//     - 'Same posture as admin_audit_log per D-025'.
//
//   AccountAuditEntryRow (11 fields):
//     - id + accountId + actorType + actorAccountId (nullable) +
//       actorKeyId (nullable) + action + targetResourceId (nullable)
//       + payload (nullable jsonb) + ipAddress (nullable) +
//       userAgent (nullable) + timestamp.
//
//   ListAccountAuditOpts:
//     - limit (required) + cursor.
//     - V-484 filter extensions: from (inclusive lower) + to
//       (inclusive upper) + actorType ('customer' | 'system' |
//       'staff') + targetResourceId (exact-match).
//     - action (single-action filter).
//
//   V-330b effectiveAccountId framing — when route layer resolved
//   X-Driftstack-Account to a team owner the caller is a member of,
//   list returns OWNER's audit. Scope check stays on caller's
//   apiKey (being a team member doesn't waive the read:audit gate).
//
//   record() service-internal fire-and-forget intent — 'Call sites
//   swallow errors so audit failures never break the underlying
//   customer action'.
//
//   AccountAuditAction + AccountAuditActorType imported from
//   @driftstack/api-types (single source of truth).
//
// stays in lockstep across apps/server/src/services/account-audit.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W937 V-216 + V-484 + V-330b account-audit cross-source invariant', () => {
  // ─── V-216 anchor + customer-facing framing ──────────────────

  it("CRITICAL apps/server/src/services/account-audit.ts header pins V-216 anchor — 'V-216 — customer-facing audit log service. Records customer-visible events on the account: api-key mint / revoke, session create / destroy, profile lifecycle, subscription changes, webhook-endpoint lifecycle'. The V-216 anchor + 5-domain coverage is the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-audit.ts'));
    expect(p).toMatch(/V-216 — customer-facing audit log service/);
    expect(p).toMatch(/Records customer-visible events on the account: api-key mint \//);
    expect(p).toMatch(/revoke, session create \/ destroy, profile lifecycle, subscription/);
    expect(p).toMatch(/changes, webhook-endpoint lifecycle/);
  });

  // ─── account_owner-scoped customer-only read ─────────────────

  it("CRITICAL customer-scope framing — 'Mirrors the admin-audit service shape but customer-scoped — list(accountId) returns only the calling account's own entries, gated on account_owner scope'. The customer-scoped read + account_owner-gate is what makes the audit user-readable.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-audit.ts'));
    expect(p).toMatch(/Mirrors the admin-audit/);
    expect(p).toMatch(/service shape but customer-scoped — `list\(accountId\)` returns only/);
    expect(p).toMatch(/the calling account's own entries, gated on account_owner scope/);
  });

  // ─── D-025 append-only mirror ────────────────────────────────

  it("CRITICAL append-only framing — 'Append-only contract: insert + list, no update / delete. Same posture as admin_audit_log per D-025'. The D-025 mirror enforces the same invariant on account_audit_log as on admin_audit_log.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-audit.ts'));
    expect(p).toMatch(/Append-only contract: insert \+ list, no update \/ delete\. Same/);
    expect(p).toMatch(/posture as admin_audit_log per D-025/);
  });

  // ─── AccountAuditEntryRow 11-field shape ─────────────────────

  it('CRITICAL AccountAuditEntryRow has 11 fields — id + accountId + actorType + actorAccountId (nullable) + actorKeyId (nullable) + action + targetResourceId (nullable) + payload (nullable Record) + ipAddress (nullable) + userAgent (nullable) + timestamp. The 11-field shape mirrors admin-audit + adds userAgent for browser-session correlation.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-audit.ts'));
    expect(p).toMatch(/export interface AccountAuditEntryRow \{/);
    expect(p).toMatch(/id: string;/);
    expect(p).toMatch(/accountId: string;/);
    expect(p).toMatch(/actorType: AccountAuditActorType;/);
    expect(p).toMatch(/actorAccountId: string \| null;/);
    expect(p).toMatch(/actorKeyId: string \| null;/);
    expect(p).toMatch(/action: AccountAuditAction;/);
    expect(p).toMatch(/targetResourceId: string \| null;/);
    expect(p).toMatch(/payload: Record<string, unknown> \| null;/);
    expect(p).toMatch(/ipAddress: string \| null;/);
    expect(p).toMatch(/userAgent: string \| null;/);
    expect(p).toMatch(/timestamp: Date;/);
  });

  // ─── ListAccountAuditOpts shape + V-484 filters ──────────────

  it('CRITICAL ListAccountAuditOpts pinned base fields — limit (required) + cursor + action. The 3-base + 4-V-484 filter surface is the audit query API.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-audit.ts'));
    expect(p).toMatch(/export interface ListAccountAuditOpts \{/);
    expect(p).toMatch(/limit: number;/);
    expect(p).toMatch(/cursor\?: string;/);
    expect(p).toMatch(/action\?: AccountAuditAction;/);
  });

  it("CRITICAL V-484 filter extensions — 'V-484 — additional filters layered on the base shape' + from (Inclusive lower) + to (Inclusive upper) + actorType filter ('customer' / 'system' / 'staff') + targetResourceId (exact-match). The 4-filter V-484 layer is the per-resource audit query primitive.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-audit.ts'));
    expect(p).toMatch(/\/\/ V-484 — additional filters layered on the base shape\./);
    expect(p).toMatch(/Inclusive lower bound on `timestamp`/);
    expect(p).toMatch(/from\?: Date;/);
    expect(p).toMatch(/Inclusive upper bound on `timestamp`/);
    expect(p).toMatch(/to\?: Date;/);
    expect(p).toMatch(/Filter by actor — `customer` \(most common\), `system`, `staff`/);
    expect(p).toMatch(/actorType\?: AccountAuditActorType;/);
    expect(p).toMatch(/Filter by exact target resource id \(e\.g\. `webhook_endpoint_<id>`\)/);
    expect(p).toMatch(/targetResourceId\?: string;/);
  });

  // ─── Both-inclusive bounds (vs admin-audit half-open) ────────

  it("CRITICAL account-audit V-484 uses [from, to] INCLUSIVE bounds (both 'Inclusive') — DIFFERENT from admin-audit's [from, to) half-open. The 2-inclusive semantics matches V-484 admin filter docs; drift would break cross-source parity tests.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-audit.ts'));
    expect(p).toMatch(/Inclusive lower bound on `timestamp`/);
    expect(p).toMatch(/Inclusive upper bound on `timestamp`/);
  });

  // ─── 3-value AccountAuditActorType ───────────────────────────

  it("CRITICAL actorType 3-value union framing — 'customer (most common), system, staff'. The 3-value union is what distinguishes user-action / system-fired / staff-impersonation entries.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-audit.ts'));
    expect(p).toMatch(/Filter by actor — `customer` \(most common\), `system`, `staff`/);
  });

  // ─── AccountAuditRepo append-only 2-method ───────────────────

  it('CRITICAL AccountAuditRepo declares EXACTLY 2 methods — insert + list. Append-only invariant enforced at interface level (matches admin_audit_log D-025 posture).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-audit.ts'));
    expect(p).toMatch(/export interface AccountAuditRepo \{/);
    expect(p).toMatch(/insert\(input: RecordAccountAuditInput\): Promise<AccountAuditEntryRow>;/);
    expect(p).toMatch(
      /list\(accountId: string, opts: ListAccountAuditOpts\): Promise<ListAccountAuditPage>;/,
    );
    const repoBlock = p.match(/export interface AccountAuditRepo \{[\s\S]+?\}/)?.[0] ?? '';
    expect(repoBlock).not.toMatch(/update\s*\(/);
    expect(repoBlock).not.toMatch(/delete\s*\(/);
  });

  // ─── list() read:audit scope check ───────────────────────────
  // V-553.B-21 — widened from a hard account_owner-only gate to the
  // granular read:audit scope (account_owner still satisfies it via
  // V-481 broad-satisfies-granular, so this is a strict widening).

  it('CRITICAL list() requires read:audit scope (or a satisfying broad scope) via throwIfMissingScope. The scope gate prevents un-scoped API keys reading the audit log.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-audit.ts'));
    expect(p).toMatch(/throwIfMissingScope\(ctx, 'read:audit'\);/);
  });

  // ─── V-330b effectiveAccountId team-RBAC framing ─────────────

  it("CRITICAL V-330b framing — 'when opts.effectiveAccountId is set (route layer resolved X-Driftstack-Account to a team owner the caller is a member of), the audit entries returned are the OWNER's, not the caller's. The scope check stays on the caller's apiKey — being a team member doesn't waive the scope requirement on the calling principal'. The team-member-doesn't-waive-scope is the V-330b principal-vs-target distinction.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-audit.ts'));
    expect(p).toMatch(/V-330b — when `opts\.effectiveAccountId` is set \(route layer/);
    expect(p).toMatch(/resolved X-Driftstack-Account to a team owner the caller is a/);
    expect(p).toMatch(/member of\), the audit entries returned are the OWNER's, not the/);
    expect(p).toMatch(/caller's\. The scope check stays on the caller's apiKey — being a/);
    expect(p).toMatch(/team member doesn't waive the scope requirement on the calling/);
    expect(p).toMatch(/principal\./);
  });

  it("CRITICAL effectiveAccountId resolution — 'opts.effectiveAccountId ?? ctx.account.id'. The fallback-to-caller is what makes effectiveAccountId an optional team-RBAC override.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-audit.ts'));
    expect(p).toMatch(/const accountId = opts\.effectiveAccountId \?\? ctx\.account\.id;/);
  });

  // ─── record() service-internal fire-and-forget intent ───────

  it("CRITICAL record() JSDoc framing — 'Service-internal record-on-event. Callers (api-keys service, sessions service, etc.) invoke this to drop a customer-visible event into the account's audit log. Fire-and-forget intent — call sites swallow errors so audit failures never break the underlying customer action'. The fire-and-forget contract is what makes record() safe to call from any service.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-audit.ts'));
    expect(p).toMatch(/Service-internal record-on-event\. Callers \(api-keys service,/);
    expect(p).toMatch(/sessions service, etc\.\) invoke this to drop a customer-visible/);
    expect(p).toMatch(/event into the account's audit log\. Fire-and-forget intent —/);
    expect(p).toMatch(/call sites swallow errors so audit failures never break the/);
    expect(p).toMatch(/underlying customer action/);
  });

  // ─── api-types single-source-of-truth imports ────────────────

  it('CRITICAL AccountAuditAction + AccountAuditActorType imported from @driftstack/api-types. The api-types import is the single-source-of-truth for both customer action vocabulary + actor type union (matches the V-216 canonical schema).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-audit.ts'));
    expect(p).toMatch(
      /import type \{ AccountAuditAction, AccountAuditActorType \} from '@driftstack\/api-types';/,
    );
  });

  // ─── ListAccountAuditPage 2-field shape ──────────────────────

  it('CRITICAL ListAccountAuditPage has 2 fields — items + nextCursor (nullable). The 2-field page is the customer paginator shape; nextCursor null signals end-of-results.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-audit.ts'));
    expect(p).toMatch(/export interface ListAccountAuditPage \{/);
    expect(p).toMatch(/items: AccountAuditEntryRow\[\];/);
    expect(p).toMatch(/nextCursor: string \| null;/);
  });

  // ─── RecordAccountAuditInput 9-field write shape ─────────────

  it('CRITICAL RecordAccountAuditInput has 9 fields — accountId + actorType + actorAccountId? + actorKeyId? + action + targetResourceId? + payload? + ipAddress? + userAgent?. The 9-field write-shape is what services pass to record(); id + timestamp are server-assigned.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-audit.ts'));
    expect(p).toMatch(/export interface RecordAccountAuditInput \{/);
    expect(p).toMatch(/accountId: string;/);
    expect(p).toMatch(/actorType: AccountAuditActorType;/);
    expect(p).toMatch(/actorAccountId\?: string \| null;/);
    expect(p).toMatch(/actorKeyId\?: string \| null;/);
    expect(p).toMatch(/action: AccountAuditAction;/);
    expect(p).toMatch(/targetResourceId\?: string \| null;/);
    expect(p).toMatch(/payload\?: Record<string, unknown> \| null;/);
    expect(p).toMatch(/ipAddress\?: string \| null;/);
    expect(p).toMatch(/userAgent\?: string \| null;/);
  });

  // ─── Newest-first read order ─────────────────────────────────

  it("CRITICAL list() framing — 'Returns the calling account's own audit entries in newest-first order. Requires the granular `read:audit` scope (or a satisfying broad scope)'. The newest-first ordering is the customer-dashboard read expectation.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/account-audit.ts'));
    expect(p).toMatch(/Returns the calling account's own audit/);
    expect(p).toMatch(/entries in newest-first order\. Requires the granular `read:audit`/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/account-audit-v216-v484-v330b-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
