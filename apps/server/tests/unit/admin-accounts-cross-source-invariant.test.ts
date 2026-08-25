// W940 — admin-accounts internal-admin cross-source invariant.
// Two-hundred-sixty-sixth in the drift-guard series. Pins the
// account-state mutation service:
//
//   Service framing — 'Account-state mutations (admin-only). These
//   services back the admin endpoints under /v1/admin/accounts/:id
//   (tier change, suspend, unsuspend)'.
//
//   D-020 + D-025 cache invalidation pattern — 'Each mutation
//   invalidates the auth cache for the target account so cached
//   AccountContext reads pick up the new state on the next request'.
//
//   Audit framing — 'Audit logging is the route's responsibility —
//   the route writes the audit row in the same handler that calls
//   the service. The service stays focused on the mutation; the
//   route owns the request/response envelope'.
//
//   AccountsAdminService 8 methods + 1 private:
//     - getAccount(ctx, accountId) — 404 on missing.
//     - list(ctx, args) — paginated cross-account.
//     - countByStatus(ctx, status).
//     - countByTier(ctx) — account distribution per tier.
//     - signupCounts(ctx, now) — new-signup windows (today/7d/30d).
//     - changeTier(ctx, accountId, newTier) — invalidates cache.
//     - suspend(ctx, accountId) → status='suspended', invalidates.
//     - unsuspend(ctx, accountId) → status='active', invalidates.
//
//   All 8 methods require 'driftstack_internal_admin' scope (not
//   plain 'admin' — internal-admin is stricter, cross-account
//   access).
//
//   3-value status enum: 'active' | 'suspended' | 'deleted'.
//
//   ListAccountsArgs cursor — 'prior page's last id (created_at
//   desc + id desc tie-break)'.
//
//   AccountsAdminRepo 7-method interface: findById + setTier +
//     setStatus + list + countByStatus + countByTier + countCreatedSince.
//
//   invalidateCache graceful-degradation framing — 'Cache failures
//   must not propagate as admin-action failures — the underlying
//   mutation is committed. The next auth-path read will TTL out
//   the stale entry within 30s in the worst case'. (Matches D-020
//   30s-worst-case contract; same posture as
//   rate-limit-overrides.invalidateCache.)
//
// stays in lockstep across apps/server/src/services/admin-accounts.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W940 admin-accounts cross-source invariant', () => {
  // ─── Service intro framing ───────────────────────────────────

  it("CRITICAL apps/server/src/services/admin-accounts.ts header pins 'Account-state mutations (admin-only). These services back the admin endpoints under /v1/admin/accounts/:id (tier change, suspend, unsuspend)'. The 3-mutation surface is the admin API contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-accounts.ts'));
    expect(p).toMatch(/Account-state mutations \(admin-only\)\./);
    expect(p).toMatch(/These services back the admin endpoints under \/v1\/admin\/accounts\/:id/);
    expect(p).toMatch(/\(tier change, suspend, unsuspend\)/);
  });

  // ─── D-020 + D-025 cache-invalidation pattern ────────────────

  it("CRITICAL D-020 + D-025 framing — 'Each mutation invalidates the auth cache for the target account so cached AccountContext reads pick up the new state on the next request (D-020 + D-025 cache invalidation pattern)'. The both-anchor invalidation contract is what makes mutations visible to next-request auth path.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-accounts.ts'));
    expect(p).toMatch(/Each mutation invalidates the auth/);
    expect(p).toMatch(/cache for the target account so cached AccountContext reads pick up/);
    expect(p).toMatch(/the new state on the next request \(D-020 \+ D-025 cache invalidation/);
    expect(p).toMatch(/pattern\)\./);
  });

  // ─── Service-vs-route audit split ────────────────────────────

  it("CRITICAL service-vs-route audit framing — 'Audit logging is the route's responsibility — the route writes the audit row in the same handler that calls the service. The service stays focused on the mutation; the route owns the request/response envelope'. The audit-in-route + mutation-in-service split keeps services request-shape-agnostic.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-accounts.ts'));
    expect(p).toMatch(/Audit logging is the route's responsibility — the route writes the/);
    expect(p).toMatch(/audit row in the same handler that calls the service\. The service/);
    expect(p).toMatch(/stays focused on the mutation; the route owns the request\/response/);
    expect(p).toMatch(/envelope/);
  });

  // ─── 5 methods all require driftstack_internal_admin ─────────

  it("CRITICAL all 8 service methods require 'driftstack_internal_admin' scope — getAccount + list + countByStatus + countByTier + signupCounts + changeTier + suspend + unsuspend. The internal-admin (not plain 'admin') scope keeps cross-account mutations internal-only.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-accounts.ts'));
    // Was `>= 8`, which is satisfied with slack and therefore cannot see a NEW
    // unguarded method: adding a tenth ctx-taking method with no scope call left
    // the count at 9 and the whole admin suite green (1711 tests, measured).
    // The roster is derived from the source instead and compared for PARITY —
    // one scope check per method that takes a caller context.
    const methods = [...p.matchAll(/^ {2}async (\w+)\(\s*ctx: AccountContext/gm)].map((m) => m[1]);
    const matches = p.match(/throwIfMissingScope\(ctx, 'driftstack_internal_admin'\);/g) ?? [];
    // A floor as well as the parity, because parity alone is satisfied by 0 === 0
    // if every method is ever renamed out of the pattern.
    expect(methods.length, 'the derived roster must not collapse').toBeGreaterThanOrEqual(9);
    expect(
      matches.length,
      `every ctx-taking admin method needs the internal-admin gate; roster: ${methods.join(', ')}`,
    ).toBe(methods.length);
  });

  // ─── 3-value account status enum ─────────────────────────────

  it("CRITICAL 3-value status enum — 'active' | 'suspended' | 'deleted'. Pinned in ListAccountsArgs.status filter + AccountsAdminRepo.setStatus + countByStatus method signatures.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-accounts.ts'));
    expect(p).toMatch(/status\?: 'active' \| 'suspended' \| 'deleted';/);
    expect(p).toMatch(
      /setStatus\(\s*\n\s*id: string,\s*\n\s*status: 'active' \| 'suspended' \| 'deleted',\s*\n\s*at: Date,\s*\n\s*\): Promise<AccountRow \| null>;/,
    );
    expect(p).toMatch(
      /countByStatus\(status: 'active' \| 'suspended' \| 'deleted'\): Promise<number>;/,
    );
  });

  // ─── suspend / unsuspend map to status setter ───────────────

  it("CRITICAL suspend() sets status='suspended' + unsuspend() sets status='active'. The 2-method abstraction hides the 3-value status enum from callers — drift to status='deleted' on suspend would silently break.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-accounts.ts'));
    expect(p).toMatch(/await this\.repo\.setStatus\(accountId, 'suspended', new Date\(\)\);/);
    expect(p).toMatch(/await this\.repo\.setStatus\(accountId, 'active', new Date\(\)\);/);
  });

  // ─── ListAccountsArgs cursor + 4-filter shape ────────────────

  it("CRITICAL ListAccountsArgs has 5 fields — cursor + limit + status (3-value) + tier (AccountTier) + emailContains (substring, lowercased). The 5-field args support admin-console paginated filtered list. cursor framing: 'prior page's last id (created_at desc + id desc tie-break)'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-accounts.ts'));
    expect(p).toMatch(/export interface ListAccountsArgs \{/);
    expect(p).toMatch(
      /Cursor is the prior page's last `id` \(created_at desc \+ id desc tie-break\)/,
    );
    expect(p).toMatch(/cursor\?: string;/);
    expect(p).toMatch(/limit\?: number;/);
    expect(p).toMatch(/Filter by account status\. Default: no filter/);
    expect(p).toMatch(/Filter by tier\. Default: no filter/);
    expect(p).toMatch(/tier\?: AccountTier;/);
    expect(p).toMatch(/Substring filter on email \(lowercased\)\. Default: no filter/);
    expect(p).toMatch(/emailContains\?: string;/);
  });

  // ─── ListAccountsPage 3-field shape ──────────────────────────

  it('CRITICAL ListAccountsPage has 3 fields — data (AccountRow[]) + hasMore (boolean) + nextCursor (nullable). The 3-field paginator shape mirrors other admin-list endpoints.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-accounts.ts'));
    expect(p).toMatch(/export interface ListAccountsPage \{/);
    expect(p).toMatch(/data: AccountRow\[\];/);
    expect(p).toMatch(/hasMore: boolean;/);
    expect(p).toMatch(/nextCursor: string \| null;/);
  });

  // ─── AccountsAdminRepo 5-method interface ────────────────────

  it('CRITICAL AccountsAdminRepo has 7 methods — findById + setTier + setStatus + list + countByStatus + countByTier + countCreatedSince. The 7-method interface is the storage seam; setTier + setStatus return AccountRow | null (null = row missing).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-accounts.ts'));
    expect(p).toMatch(/export interface AccountsAdminRepo \{/);
    expect(p).toMatch(/findById\(id: string\): Promise<AccountRow \| null>;/);
    expect(p).toMatch(
      /setTier\(id: string, tier: AccountTier, at: Date\): Promise<AccountRow \| null>;/,
    );
    expect(p).toMatch(/setStatus\(/);
    expect(p).toMatch(/list\(args: ListAccountsArgs\): Promise<ListAccountsPage>;/);
    expect(p).toMatch(
      /countByStatus\(status: 'active' \| 'suspended' \| 'deleted'\): Promise<number>;/,
    );
    expect(p).toMatch(/countByTier\(\): Promise<Record<AccountTier, number>>;/);
    expect(p).toMatch(/countCreatedSince\(since: Date\): Promise<number>;/);
  });

  // ─── 404 on missing account ──────────────────────────────────

  it('CRITICAL 404 framing — \'Account "X" not found.\' interpolated message thrown by getAccount + changeTier + suspend + unsuspend on missing row. The interpolated-id message gives admin tooling the bad-id back for debugging.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-accounts.ts'));
    expect(p).toMatch(/throw new NotFoundError\(`Account "\$\{accountId\}" not found\.`\);/);
  });

  // ─── 4 mutate operations call invalidateCache ────────────────

  it('CRITICAL all 3 mutations invoke await this.invalidateCache(accountId) — changeTier + suspend + unsuspend. The invalidate-on-mutate makes the next auth-cache read see fresh state.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-accounts.ts'));
    const matches = p.match(/await this\.invalidateCache\(accountId\);/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  // ─── invalidateCache graceful-degradation framing ────────────

  it("CRITICAL invalidateCache graceful-degradation framing — 'Cache failures must not propagate as admin-action failures — the underlying mutation is committed. The next auth-path read will TTL out the stale entry within 30s in the worst case'. Matches D-020 auth-cache 30s-worst-case (same posture as rate-limit-overrides.invalidateCache).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-accounts.ts'));
    expect(p).toMatch(/Cache failures must not propagate as admin-action failures —/);
    expect(p).toMatch(/the underlying mutation is committed\. The next auth-path read/);
    expect(p).toMatch(/will TTL out the stale entry within 30s in the worst case/);
  });

  it('CRITICAL invalidateCache no-op when authCache is null — for tests that skip cache wiring. Mechanically verified via early return.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-accounts.ts'));
    expect(p).toMatch(
      /private async invalidateCache\(accountId: string\): Promise<void> \{\s*\n\s*if \(!this\.authCache\) return;/,
    );
  });

  // ─── AuthCache injection optional ────────────────────────────

  it('CRITICAL AccountsAdminService constructor — repo (required) + authCache (optional, default null). The optional cache mirrors rate-limit-overrides constructor + lets tests skip cache wiring.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-accounts.ts'));
    expect(p).toMatch(/export class AccountsAdminService \{/);
    expect(p).toMatch(/private readonly authCache: AuthCache \| null = null,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/admin-accounts-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
