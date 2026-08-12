// W399.C — drift guard for apps/server/src/services/admin-accounts.ts.
// Admin-only account-state mutations (tier / suspend / unsuspend +
// read paths). Every mutation invalidates the auth cache for the
// target account so cached AccountContext picks up the new state on
// the next request (D-020 + D-025 cache-invalidation pattern). Audit
// logging is the route's responsibility, NOT the service's. Drift
// here either lets a non-admin mutate (catastrophic) or leaves a
// stale AccountContext cached after a state change.
//
//   • Module-comment framing pinned: audit ownership stays on routes,
//     service stays focused on the mutation.
//   • D-020 + D-025 cache-invalidation framing pinned.
//   • All 9 methods require driftstack_internal_admin scope (GDPR
//     Article 17 deleteAccount added 2026-07-01).
//   • Read methods (getAccount / list / countByStatus / countByTier /
//     signupCounts) don't invalidate cache.
//   • Mutate methods (changeTier / suspend / unsuspend): repo update
//     → NotFoundError when row missing → invalidateCache.
//   • status union: 'active' | 'suspended' | 'deleted'.
//   • ListAccountsArgs: cursor (created_at desc + id desc tie-break)
//     + limit + status/tier/emailContains optional filters.
//   • invalidateCache: try/catch absorbs failure (mutation committed;
//     30s TTL out worst-case).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/admin-accounts.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W399.C apps/server/src/services/admin-accounts.ts content parity', () => {
  const body = read(LIB);

  it('Module framing: D-020 + D-025 cache-invalidation pattern + audit-ownership-on-route', () => {
    expect(body).toMatch(/Account-state mutations \(admin-only\)\./);
    expect(body).toMatch(
      /Each mutation invalidates the auth\s*\n?\s*\/\/\s*cache for the target account so cached AccountContext reads pick up\s*\n?\s*\/\/\s*the new state on the next request \(D-020 \+ D-025 cache invalidation\s*\n?\s*\/\/\s*pattern\)/,
    );
    expect(body).toMatch(
      /Audit logging is the route's responsibility — the route writes the\s*\n?\s*\/\/\s*audit row in the same handler that calls the service\. The service\s*\n?\s*\/\/\s*stays focused on the mutation; the route owns the request\/response\s*\n?\s*\/\/\s*envelope\./,
    );
  });

  it('ListAccountsArgs: cursor (created_at desc + id desc tie-break) + limit + status/tier/emailContains optional', () => {
    expect(body).toMatch(/export interface ListAccountsArgs \{/);
    expect(body).toMatch(
      /\/\*\* Cursor is the prior page's last `id` \(created_at desc \+ id desc tie-break\)\. \*\/\s*\n?\s*cursor\?: string;/,
    );
    expect(body).toMatch(/limit\?: number;/);
    expect(body).toMatch(
      /\/\*\* Filter by account status\. Default: no filter\. \*\/\s*\n?\s*status\?: 'active' \| 'suspended' \| 'deleted';/,
    );
    expect(body).toMatch(
      /\/\*\* Filter by tier\. Default: no filter\. \*\/\s*\n?\s*tier\?: AccountTier;/,
    );
    expect(body).toMatch(
      /\/\*\* Substring filter on email \(lowercased\)\. Default: no filter\. \*\/\s*\n?\s*emailContains\?: string;/,
    );
  });

  it('ListAccountsPage: 3 fields (data + hasMore + nextCursor)', () => {
    expect(body).toMatch(
      /export interface ListAccountsPage \{\s*\n?\s*data: AccountRow\[\];\s*\n?\s*hasMore: boolean;\s*\n?\s*nextCursor: string \| null;\s*\n?\s*\}/,
    );
  });

  it('AccountsAdminRepo: 7 methods (findById / setTier / setStatus / list / countByStatus / countByTier / countCreatedSince)', () => {
    expect(body).toMatch(/export interface AccountsAdminRepo \{/);
    expect(body).toMatch(/findById\(id: string\): Promise<AccountRow \| null>;/);
    expect(body).toMatch(
      /setTier\(id: string, tier: AccountTier, at: Date\): Promise<AccountRow \| null>;/,
    );
    expect(body).toMatch(
      /setStatus\(\s*\n?\s*id: string,\s*\n?\s*status: 'active' \| 'suspended' \| 'deleted',\s*\n?\s*at: Date,\s*\n?\s*\): Promise<AccountRow \| null>;/,
    );
    expect(body).toMatch(/list\(args: ListAccountsArgs\): Promise<ListAccountsPage>;/);
    expect(body).toMatch(
      /countByStatus\(status: 'active' \| 'suspended' \| 'deleted'\): Promise<number>;/,
    );
    expect(body).toMatch(/countByTier\(\): Promise<Record<AccountTier, number>>;/);
    expect(body).toMatch(/countCreatedSince\(since: Date\): Promise<number>;/);
  });

  it('AccountsAdminService.signupCounts: windowed signup stats (today/7d/30d) backed by countCreatedSince', () => {
    expect(body).toMatch(/export interface SignupWindowCounts \{/);
    expect(body).toMatch(/today: number;/);
    expect(body).toMatch(/last_7d: number;/);
    expect(body).toMatch(/last_30d: number;/);
    expect(body).toMatch(
      /async signupCounts\(ctx: AccountContext, now: Date\): Promise<SignupWindowCounts> \{/,
    );
    expect(body).toMatch(/this\.repo\.countCreatedSince\(startOfToday\)/);
  });

  it("signupCounts windows use UTC day boundaries — 'today' from Date.UTC(getUTCFullYear/Month/Date), NOT local time; 7d/30d are now-minus-N-days rolling. Regression guard for the b70366ea bug class (admin daily-breakdown was off-by-a-day on a non-UTC server before being aligned to UTC). A UTC CI runner can't catch a UTC->local-midnight regression behaviorally (local==UTC midnight there), so the UTC construction is pinned at the source level here.", () => {
    // The UTC day-boundary construction — the core regression guard. Drift
    // to `new Date(now.getFullYear(), now.getMonth(), now.getDate())` (local
    // midnight) would silently re-introduce b70366ea for non-UTC server time.
    expect(body).toMatch(
      /Date\.UTC\(now\.getUTCFullYear\(\), now\.getUTCMonth\(\), now\.getUTCDate\(\)\)/,
    );
    // 7d / 30d are timezone-agnostic rolling windows (now - N days in ms).
    expect(body).toMatch(
      /const sevenDaysAgo = new Date\(now\.getTime\(\) - 7 \* 24 \* 60 \* 60 \* 1000\)/,
    );
    expect(body).toMatch(
      /const thirtyDaysAgo = new Date\(now\.getTime\(\) - 30 \* 24 \* 60 \* 60 \* 1000\)/,
    );
  });

  it('AccountsAdminService: constructor takes repo + optional authCache + optional sessions reclaimer + optional GDPR Article 17 delete-reclaim trio (web sessions / API keys / webhooks)', () => {
    expect(body).toMatch(/export class AccountsAdminService \{/);
    expect(body).toMatch(
      /constructor\(\s*\n?\s*private readonly repo: AccountsAdminRepo,\s*\n?\s*private readonly authCache: AuthCache \| null = null,\s*\n?\s*private readonly sessions: SuspendSessionReclaimer \| null = null,\s*\n?\s*private readonly webSessions: DeleteWebSessionReclaimer \| null = null,\s*\n?\s*private readonly apiKeys: DeleteApiKeyReclaimer \| null = null,\s*\n?\s*private readonly webhooks: DeleteWebhookReclaimer \| null = null,[\s\S]*?private readonly logger: \{[\s\S]*?\} \| null = null,[\s\S]*?private readonly billing: BillingCollectionPauser \| null = null,\s*\n?\s*\) \{\}/,
    );
    // V-758 — the pauser is the dependency that makes AUP §5.2 true. Optional so every
    // existing construction site and test double keeps working; when absent, suspension
    // behaves exactly as before.
    expect(body).toMatch(/export interface BillingCollectionPauser \{/);
    expect(body).toMatch(
      /pauseCollectionForAccount\(accountId: string\): Promise<'paused' \| 'no_subscription'>;/,
    );
    expect(body).toMatch(
      /resumeCollectionForAccount\(accountId: string\): Promise<'resumed' \| 'no_subscription'>;/,
    );
    // Both halves must be wired: a pause with no resume leaves a reinstated customer
    // permanently unbilled, which is worse than the defect the pause fixes.
    expect(body).toMatch(/this\.reclaim\('billing_pause'/);
    expect(body).toMatch(/this\.reclaim\('billing_resume'/);
    expect(body).toMatch(
      /export interface SuspendSessionReclaimer \{\s*\n?\s*destroyAllForAccount\(accountId: string\): Promise<number>;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface DeleteWebSessionReclaimer \{\s*\n?\s*revokeAllWebSessionsForAccount\(accountId: string, now: Date\): Promise<number>;\s*\n?\s*\}/,
    );
    // V-727 — the reclaimer now has TWO methods. revokeAllForAccount filters on
    // account_id and so can only reach credentials ON the account; a team
    // member's keys live on the OWNER's account, so terminating the member
    // needs the minted-by sweep as well. Losing it silently restores the hole.
    expect(body).toMatch(
      /export interface DeleteApiKeyReclaimer \{\s*revokeAllForAccount\(ctx: AccountContext, accountId: string\): Promise<number>;[\s\S]*?revokeAllMintedByAccount\(ctx: AccountContext, minterAccountId: string\): Promise<number>;\s*\}/,
    );
    expect(body).toMatch(
      /export interface DeleteWebhookReclaimer \{\s*\n?\s*deleteAllForAccount\(ctx: AccountContext, accountId: string\): Promise<number>;\s*\n?\s*\}/,
    );
  });

  it('All 9 methods require driftstack_internal_admin scope (throwIfMissingScope first)', () => {
    // Count occurrences — should be 9 (one per method: getAccount, list,
    // countByStatus, countByTier, signupCounts, changeTier, suspend,
    // unsuspend, deleteAccount).
    const scopeChecks = body.match(/throwIfMissingScope\(ctx, 'driftstack_internal_admin'\);/g);
    expect(scopeChecks?.length).toBe(9);
  });

  it('deleteAccount (GDPR Article 17): scope check → setStatus(deleted) → NotFoundError on null → 4 best-effort reclaim steps (sessions/webSessions/apiKeys/webhooks) → invalidateCache', () => {
    expect(body).toMatch(
      /async deleteAccount\(ctx: AccountContext, accountId: string\): Promise<AccountRow> \{\s*\n?\s*throwIfMissingScope\(ctx, 'driftstack_internal_admin'\);\s*\n?\s*const now = new Date\(\);\s*\n?\s*const updated = await this\.repo\.setStatus\(accountId, 'deleted', now\);\s*\n?\s*if \(!updated\) throw new NotFoundError\(`Account "\$\{accountId\}" not found\.`\);/,
    );
    // Each surface must go through reclaim(), which is what keeps the step
    // best-effort AND recorded. Pinning the step NAMES matters as much as the
    // calls: "the account was terminated" is true whichever step failed, and
    // only the name tells an operator whether live API keys are still
    // authenticating or a browser is merely still running.
    expect(body).toMatch(/await this\.reclaim\('sessions', accountId, \(\) =>/);
    expect(body).toMatch(/await this\.reclaim\('web_sessions', accountId, \(\) =>/);
    expect(body).toMatch(/await this\.reclaim\('api_keys', accountId, \(\) =>/);
    expect(body).toMatch(/await this\.reclaim\('api_keys_minted_elsewhere', accountId, \(\) =>/);
    expect(body).toMatch(/await this\.reclaim\('webhooks', accountId, \(\) =>/);
    // reclaim() swallows so the admin action still succeeds, but reports first.
    expect(body).toMatch(
      /private async reclaim\([\s\S]*?\} catch \(err\) \{[\s\S]*?event: 'account_reclaim_failed',/,
    );
  });

  it('getAccount: scope check → repo.findById → NotFoundError-or-row', () => {
    expect(body).toMatch(
      /async getAccount\(ctx: AccountContext, accountId: string\): Promise<AccountRow> \{\s*\n?\s*throwIfMissingScope\(ctx, 'driftstack_internal_admin'\);\s*\n?\s*const row = await this\.repo\.findById\(accountId\);\s*\n?\s*if \(!row\) throw new NotFoundError\(`Account "\$\{accountId\}" not found\.`\);\s*\n?\s*return row;\s*\n?\s*\}/,
    );
  });

  it('changeTier / suspend / unsuspend: repo update with new Date() at → NotFoundError on null → invalidateCache', () => {
    expect(body).toMatch(
      /async changeTier\(\s*\n?\s*ctx: AccountContext,\s*\n?\s*accountId: string,\s*\n?\s*newTier: AccountTier,\s*\n?\s*\): Promise<AccountRow> \{[\s\S]+?const updated = await this\.repo\.setTier\(accountId, newTier, new Date\(\)\);\s*\n?\s*if \(!updated\) throw new NotFoundError\(`Account "\$\{accountId\}" not found\.`\);\s*\n?\s*await this\.invalidateCache\(accountId\);\s*\n?\s*return updated;/,
    );
    expect(body).toMatch(
      /async suspend\(ctx: AccountContext, accountId: string\): Promise<AccountRow> \{[\s\S]+?const updated = await this\.repo\.setStatus\(accountId, 'suspended', new Date\(\)\);\s*\n?\s*if \(!updated\) throw new NotFoundError\(`Account "\$\{accountId\}" not found\.`\);\s*\n?\s*await this\.invalidateCache\(accountId\);/,
    );
    expect(body).toMatch(
      /async unsuspend\(ctx: AccountContext, accountId: string\): Promise<AccountRow> \{[\s\S]+?const updated = await this\.repo\.setStatus\(accountId, 'active', new Date\(\)\);\s*\n?\s*if \(!updated\) throw new NotFoundError\(`Account "\$\{accountId\}" not found\.`\);\s*\n?\s*await this\.invalidateCache\(accountId\);/,
    );
  });

  it('invalidateCache: try/catch absorbs failure (mutation committed; cache TTLs out within 30s worst-case)', () => {
    expect(body).toMatch(
      /private async invalidateCache\(accountId: string\): Promise<void> \{\s*\n?\s*if \(!this\.authCache\) return;\s*\n?\s*try \{\s*\n?\s*await this\.authCache\.invalidateAccount\(accountId\);\s*\n?\s*\} catch \{\s*\n?\s*\/\/ Cache failures must not propagate as admin-action failures —\s*\n?\s*\/\/ the underlying mutation is committed\. The next auth-path read\s*\n?\s*\/\/ will TTL out the stale entry within 30s in the worst case\./,
    );
  });

  it('imports: AccountTier + AccountContext + AccountRow + AuthCache + NotFoundError/requireScope-aliased', () => {
    expect(body).toMatch(/import type \{ AccountTier \} from '@driftstack\/api-types';/);
    expect(body).toMatch(/import type \{ AccountContext \} from '\.\/auth\.js';/);
    expect(body).toMatch(/import type \{ AccountRow \} from '\.\/auth\.js';/);
    expect(body).toMatch(/import type \{ AuthCache \} from '\.\/auth-cache\.js';/);
    expect(body).toMatch(
      /import \{ NotFoundError, requireScope as throwIfMissingScope \} from '\.\.\/lib\/errors-helpers\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
