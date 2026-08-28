// W992 — db/billing-repo V-082 + W197 cross-source invariant. Three-
// hundred-eighteenth in the drift-guard series. Pins the apps/server/
// src/db/billing-repo.ts Drizzle billing repo primitive:
//
//   V-082 anchor — 'Drizzle-backed BillingRepo (V-082)'.
//
//   W197 narrow-dep framing — 'W197 — only the db handle is read;
//   narrow the dependency to make e2e fixtures composable without
//   the full Database envelope ({ client, db, close })'.
//
//   Constructor — 'private readonly database: Pick<Database, db>'.
//
//   3-method surface — getAccount + setStripeCustomerId +
//     findCurrentSubscription.
//
//   findCurrentSubscription no-status-filter framing — 'Most-recent
//   first by created_at; route layer can filter to active statuses
//   if it cares. We don't filter here so the dashboard can surface
//   your last subscription was canceled on X without an extra query'.
//
//   setStripeCustomerId updates 2 fields — stripeCustomerId + updatedAt
//     (touch-on-change semantics).
//
//   toAccount mapper has 9 fields — id + email + name + tier +
//     stripeCustomerId + trialPackPurchasedAt + trialPackCreditCents +
//     trialPackExpiresAt + trialPackRedeemed.
//
//   toSubscription mapper has 11 fields — id + accountId +
//     stripeSubscriptionId + stripePriceId + tier + status +
//     currentPeriodEnd + cancelAtPeriodEnd + canceledAt + createdAt +
//     updatedAt.
//
// stays in lockstep across apps/server/src/db/billing-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W992 db/billing-repo V-082 + W197 cross-source invariant', () => {
  // ─── V-082 anchor ────────────────────────────────────────────

  it("CRITICAL apps/server/src/db/billing-repo.ts header pins V-082 anchor — 'Drizzle-backed BillingRepo (V-082)'. The V-082 anchor is the billing-mirror policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/billing-repo.ts'));
    expect(p).toMatch(/\/\/ Drizzle-backed BillingRepo \(V-082\)\./);
  });

  // ─── W197 narrow-dep framing ─────────────────────────────────

  it("CRITICAL W197 narrow-dep framing — 'W197 — only the db handle is read; narrow the dependency to make e2e fixtures composable without the full Database envelope ({ client, db, close })'. The Pick<Database, 'db'> design is the W197 fixture-composability contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/billing-repo.ts'));
    expect(p).toMatch(/W197 — only the `db` handle is read; narrow the dependency to make/);
    expect(p).toMatch(/e2e fixtures composable without the full Database envelope/);
    expect(p).toMatch(/\(`\{ client, db, close \}`\)\./);
    expect(p).toMatch(/constructor\(private readonly database: Pick<Database, 'db'>\) \{\}/);
  });

  // ─── 3-method surface ────────────────────────────────────────

  it('CRITICAL 3-method surface — getAccount + setStripeCustomerId + findCurrentSubscription. The 3-method surface is the BillingRepo contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/billing-repo.ts'));
    expect(p).toMatch(
      /async getAccount\(accountId: string\): Promise<BillingAccountSnapshot \| null> \{/,
    );
    expect(p).toMatch(
      /async setStripeCustomerId\(args: \{ accountId: string; customerId: string \}\): Promise<void> \{/,
    );
    expect(p).toMatch(
      /async findCurrentSubscription\(accountId: string\): Promise<SubscriptionMirror \| null> \{/,
    );
  });

  // ─── findCurrentSubscription no-status-filter framing ────────

  it("CRITICAL no-status-filter framing — 'Most-recent first by created_at; route layer can filter to active statuses if it cares. We don't filter here so the dashboard can surface your last subscription was canceled on X without an extra query'. The no-filter-in-repo + filter-in-route design avoids an extra query for the dashboard.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/billing-repo.ts'));
    expect(p).toMatch(/\/\/ Most-recent first by created_at; route layer can filter to active/);
    expect(p).toMatch(/\/\/ statuses if it cares\. We don't filter here so the dashboard can/);
    expect(p).toMatch(/\/\/ surface "your last subscription was canceled on X" without an/);
    expect(p).toMatch(/\/\/ extra query\./);
  });

  it("CRITICAL findCurrentSubscription orders desc(createdAt), desc(id) + limit(1). V-2131 added the id tiebreak so a created_at tie is deterministic. The most-recent-first + limit-1 pattern is what makes 'last subscription' semantics correct.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/billing-repo.ts'));
    expect(p).toMatch(/\.where\(eq\(subscriptions\.accountId, accountId\)\)/);
    expect(p).toMatch(/\.orderBy\(desc\(subscriptions\.createdAt\), desc\(subscriptions\.id\)\)/);
    expect(p).toMatch(/\.limit\(1\);/);
  });

  // ─── setStripeCustomerId 2-field touch ───────────────────────

  it('CRITICAL setStripeCustomerId updates stripeCustomerId + updatedAt (touch-on-change). The updatedAt-bump preserves the standard 2-timestamp audit pattern.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/billing-repo.ts'));
    expect(p).toMatch(/\.update\(accounts\)/);
    expect(p).toMatch(/\.set\(\{ stripeCustomerId: args\.customerId, updatedAt: new Date\(\) \}\)/);
    expect(p).toMatch(/\.where\(eq\(accounts\.id, args\.accountId\)\)/);
  });

  // ─── toAccount 9-field mapper ────────────────────────────────

  it('CRITICAL toAccount 5-field mapper — id + email + name + tier + stripeCustomerId. The 5-field BillingAccountSnapshot covers identity + tier (trial-pack ledger quartet removed 2026-05-27).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/billing-repo.ts'));
    expect(p).toMatch(
      /function toAccount\(r: typeof accounts\.\$inferSelect\): BillingAccountSnapshot \{/,
    );
    expect(p).toMatch(/id: r\.id,/);
    expect(p).toMatch(/email: r\.email,/);
    expect(p).toMatch(/name: r\.name,/);
    expect(p).toMatch(/tier: r\.tier,/);
    expect(p).toMatch(/stripeCustomerId: r\.stripeCustomerId,/);
    expect(p).not.toMatch(/trialPackPurchasedAt/);
  });

  // ─── toSubscription 11-field mapper ──────────────────────────

  it('CRITICAL toSubscription 11-field mapper — id + accountId + stripeSubscriptionId + stripePriceId + tier + status + currentPeriodEnd + cancelAtPeriodEnd + canceledAt + createdAt + updatedAt. The 11-field SubscriptionMirror is the V-082 mirror-from-Stripe shape.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/billing-repo.ts'));
    expect(p).toMatch(
      /function toSubscription\(r: typeof subscriptions\.\$inferSelect\): SubscriptionMirror \{/,
    );
    expect(p).toMatch(/id: r\.id,/);
    expect(p).toMatch(/accountId: r\.accountId,/);
    expect(p).toMatch(/stripeSubscriptionId: r\.stripeSubscriptionId,/);
    expect(p).toMatch(/stripePriceId: r\.stripePriceId,/);
    expect(p).toMatch(/tier: r\.tier,/);
    expect(p).toMatch(/status: r\.status,/);
    expect(p).toMatch(/currentPeriodEnd: r\.currentPeriodEnd,/);
    expect(p).toMatch(/cancelAtPeriodEnd: r\.cancelAtPeriodEnd,/);
    expect(p).toMatch(/canceledAt: r\.canceledAt,/);
    expect(p).toMatch(/createdAt: r\.createdAt,/);
    expect(p).toMatch(/updatedAt: r\.updatedAt,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/db-billing-repo-v082-w197-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
