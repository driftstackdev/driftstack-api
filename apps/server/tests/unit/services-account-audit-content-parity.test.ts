// W399.A — drift guard for apps/server/src/services/account-audit.ts.
// V-216 customer-facing audit log. Mirrors admin-audit shape but
// customer-scoped — list(accountId) returns ONLY the calling account's
// own entries, gated on account_owner scope. Drift either leaks
// cross-account entries (catastrophic) or breaks the customer-visible
// /v1/account/audit list contract.
//
//   • V-216 framing + customer-visible event coverage (api-key mint /
//     revoke, session create / destroy, profile lifecycle, subscription
//     changes, webhook-endpoint lifecycle).
//   • D-025 append-only contract: insert + list, no UPDATE / DELETE.
//   • AccountAuditEntryRow: 11 camelCased fields with actorType
//     discriminator (V-216 ActorType union).
//   • RecordAccountAuditInput: required (accountId, actorType, action)
//     + 6 optional fields.
//   • ListAccountAuditOpts: base (limit/cursor/action) + V-484 filters
//     (from/to/actorType/targetResourceId).
//   • read:audit scope (or a satisfying broad scope) required for list
//     (V-553.B-21 widened from a hard account_owner-only gate).
//   • V-330b effectiveAccountId: team-member case — entries returned
//     are OWNER's, not caller's; scope check stays on calling apiKey.
//   • record: service-internal fire-and-forget; call sites swallow
//     errors (audit failure ≠ underlying-action failure).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/account-audit.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W399.A apps/server/src/services/account-audit.ts content parity', () => {
  const body = read(LIB);

  it('V-216 framing pinned + customer-visible event coverage list', () => {
    expect(body).toMatch(/V-216 — customer-facing audit log service\./);
    expect(body).toMatch(
      /Records customer-visible events on the account: api-key mint \/\s*\n?\s*\/\/\s*revoke, session create \/ destroy, profile lifecycle, subscription\s*\n?\s*\/\/\s*changes, webhook-endpoint lifecycle\./,
    );
  });

  it("Customer-scoped framing: list(accountId) returns only calling account's entries, account_owner-gated", () => {
    expect(body).toMatch(
      /Mirrors the admin-audit\s*\n?\s*\/\/\s*service shape but customer-scoped — `list\(accountId\)` returns only\s*\n?\s*\/\/\s*the calling account's own entries, gated on account_owner scope\./,
    );
  });

  it('D-025 append-only contract framing: insert + list, no UPDATE/DELETE', () => {
    expect(body).toMatch(
      /Append-only contract: insert \+ list, no update \/ delete\. Same\s*\n?\s*\/\/\s*posture as admin_audit_log per D-025\./,
    );
  });

  it('AccountAuditEntryRow: 11 camelCased fields (id, accountId, actorType, actorAccountId?, actorKeyId?, action, targetResourceId?, payload?, ipAddress?, userAgent?, timestamp)', () => {
    expect(body).toMatch(/export interface AccountAuditEntryRow \{/);
    expect(body).toMatch(/id: string;/);
    expect(body).toMatch(/accountId: string;/);
    expect(body).toMatch(/actorType: AccountAuditActorType;/);
    expect(body).toMatch(/actorAccountId: string \| null;/);
    expect(body).toMatch(/actorKeyId: string \| null;/);
    expect(body).toMatch(/action: AccountAuditAction;/);
    expect(body).toMatch(/targetResourceId: string \| null;/);
    expect(body).toMatch(/payload: Record<string, unknown> \| null;/);
    expect(body).toMatch(/ipAddress: string \| null;/);
    expect(body).toMatch(/userAgent: string \| null;/);
    expect(body).toMatch(/timestamp: Date;/);
  });

  it('RecordAccountAuditInput: 3 required (accountId, actorType, action) + 6 optional', () => {
    expect(body).toMatch(/export interface RecordAccountAuditInput \{/);
    expect(body).toMatch(/accountId: string;/);
    expect(body).toMatch(/actorType: AccountAuditActorType;/);
    expect(body).toMatch(/actorAccountId\?: string \| null;/);
    expect(body).toMatch(/actorKeyId\?: string \| null;/);
    expect(body).toMatch(/action: AccountAuditAction;/);
    expect(body).toMatch(/targetResourceId\?: string \| null;/);
    expect(body).toMatch(/payload\?: Record<string, unknown> \| null;/);
    expect(body).toMatch(/ipAddress\?: string \| null;/);
    expect(body).toMatch(/userAgent\?: string \| null;/);
  });

  it('ListAccountAuditOpts: base (limit/cursor/action) + V-484 filters (from/to/actorType/targetResourceId)', () => {
    expect(body).toMatch(/export interface ListAccountAuditOpts \{/);
    expect(body).toMatch(/limit: number;/);
    expect(body).toMatch(/cursor\?: string;/);
    expect(body).toMatch(/action\?: AccountAuditAction;/);
    expect(body).toMatch(/\/\/ V-484 — additional filters layered on the base shape\./);
    expect(body).toMatch(
      /\/\*\* Inclusive lower bound on `timestamp`\. \*\/\s*\n?\s*from\?: Date;/,
    );
    expect(body).toMatch(/\/\*\* Inclusive upper bound on `timestamp`\. \*\/\s*\n?\s*to\?: Date;/);
    expect(body).toMatch(
      /\/\*\* Filter by actor — `customer` \(most common\), `system`, `staff`\. \*\/\s*\n?\s*actorType\?: AccountAuditActorType;/,
    );
    expect(body).toMatch(
      /\/\*\* Filter by exact target resource id \(e\.g\. `webhook_endpoint_<id>`\)\. \*\/\s*\n?\s*targetResourceId\?: string;/,
    );
  });

  it('AccountAuditRepo: 2 methods (insert + list — append-only enforced)', () => {
    expect(body).toMatch(/export interface AccountAuditRepo \{/);
    expect(body).toMatch(
      /insert\(input: RecordAccountAuditInput\): Promise<AccountAuditEntryRow>;/,
    );
    expect(body).toMatch(
      /list\(accountId: string, opts: ListAccountAuditOpts\): Promise<ListAccountAuditPage>;/,
    );
  });

  // V-553.B-21 — list() was widened from a hard `account_owner`-only
  // gate to the granular `read:audit` scope (account_owner still
  // satisfies it via broad-satisfies-granular, so this is a strict
  // widening, not a behavior change for existing account_owner callers).
  it('list: requires read:audit scope (or a satisfying broad scope); effectiveAccountId fallback to ctx.account.id', () => {
    expect(body).toMatch(
      /Customer-facing read\. Returns the calling account's own audit\s*\n?\s*\*\s*entries in newest-first order\. Requires the granular `read:audit`\s*\n?\s*\*\s*scope \(or a satisfying broad scope — `read` \/ `account_owner`; see\s*\n?\s*\*\s*V-481 broad-satisfies-granular in `lib\/errors-helpers\.ts`\)\./,
    );
    expect(body).toMatch(/throwIfMissingScope\(ctx, 'read:audit'\);/);
    expect(body).toMatch(/const accountId = opts\.effectiveAccountId \?\? ctx\.account\.id;/);
    expect(body).toMatch(/return this\.repo\.list\(accountId, opts\);/);
  });

  it("V-330b effectiveAccountId framing: team-member case → entries are OWNER's; scope check stays on caller apiKey", () => {
    expect(body).toMatch(
      /V-330b — when `opts\.effectiveAccountId` is set \(route layer\s*\n?\s*\*\s*resolved X-Driftstack-Account to a team owner the caller is a\s*\n?\s*\*\s*member of\), the audit entries returned are the OWNER's, not the\s*\n?\s*\*\s*caller's\. The scope check stays on the caller's apiKey — being a\s*\n?\s*\*\s*team member doesn't waive the scope requirement on the calling\s*\n?\s*\*\s*principal\./,
    );
  });

  it('record: fire-and-forget intent — call sites swallow errors so audit failures never break customer action', () => {
    expect(body).toMatch(
      /Service-internal record-on-event\. Callers \(api-keys service,\s*\n?\s*\*\s*sessions service, etc\.\) invoke this to drop a customer-visible\s*\n?\s*\*\s*event into the account's audit log\. Fire-and-forget intent —\s*\n?\s*\*\s*call sites swallow errors so audit failures never break the\s*\n?\s*\*\s*underlying customer action\./,
    );
    // Arc 7 obs.10 added a best-effort metrics bump labelled by
    // action prefix + actor type after the insert.
    // Re-pinned when the counter gained an `outcome` dimension so a FAILED
    // audit write is counted instead of showing up only as a success rate that
    // quietly stops rising. Asserted as the PROPERTIES that matter — the insert
    // is awaited inside a try, a failure is counted as error and re-thrown so
    // callers keep swallowing it, and success is counted as ok — rather than as
    // one exact rendering of the method, which a formatter or a refactor breaks
    // while proving nothing.
    expect(body).toMatch(/row = await this\.repo\.insert\(input\);/);
    expect(body).toMatch(/outcome: 'error',/);
    expect(body).toMatch(/throw err;/);
    expect(body).toMatch(/\.\.\.labels, outcome: 'ok'/);
    expect(body).toMatch(/prefix: auditActionPrefix\(input\.action\)/);
    expect(body).toMatch(/actor_type: input\.actorType/);
  });

  it('imports: AccountAuditAction + AccountAuditActorType from api-types + AccountContext + requireScope alias', () => {
    expect(body).toMatch(
      /import type \{ AccountAuditAction, AccountAuditActorType \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ AccountContext \} from '\.\/auth\.js';/);
    expect(body).toMatch(
      /import \{ requireScope as throwIfMissingScope \} from '\.\.\/lib\/errors-helpers\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
