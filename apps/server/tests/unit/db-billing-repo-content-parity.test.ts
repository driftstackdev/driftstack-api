// W442.A — drift guard for apps/server/src/db/billing-repo.ts.
// V-082 Drizzle BillingRepo. Drift here either drops the W197
// narrow-dependency (Pick<Database, 'db'>) — making e2e fixtures
// require the full Database envelope — or breaks the "most-recent
// first; don't filter to active" rationale on findCurrentSubscription
// (dashboard loses the "your last subscription was canceled on X"
// surface).
//
//   • V-082 framing pinned.
//   • toAccount mapper: 9-field BillingAccountSnapshot (incl. trial-
//     pack ledger fields).
//   • toSubscription mapper: 10-field SubscriptionMirror.
//   • W197 narrow-dep rationale: only the `db` handle is read; narrow
//     to make e2e fixtures composable without full Database envelope.
//   • findCurrentSubscription: most-recent first by createdAt DESC;
//     route layer filters to active if it cares; don't filter here
//     so dashboard can surface "your last subscription was canceled
//     on X" without an extra query.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/billing-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W442.A apps/server/src/db/billing-repo.ts content parity', () => {
  const body = read(LIB);

  it("V-082 framing pinned: 'Drizzle-backed BillingRepo (V-082).'", () => {
    expect(body).toMatch(/\/\/ Drizzle-backed BillingRepo \(V-082\)\./);
  });

  it('imports: desc/eq from drizzle-orm; BillingAccountSnapshot/BillingRepo/SubscriptionMirror from services/billing; Database type; accounts + subscriptions schema', () => {
    // V-741 — and/inArray joined for findActiveSubscription, which filters the
    // status SET rather than picking the newest row and inspecting it.
    expect(body).toMatch(/import \{ and, desc, eq, inArray \} from 'drizzle-orm';/);
    expect(body).toMatch(
      /import type \{\s*BillingAccountSnapshot,\s*BillingRepo,\s*SubscriptionMirror,\s*\} from '\.\.\/services\/billing\.js';/,
    );
    expect(body).toMatch(/import type \{ Database \} from '\.\/client\.js';/);
    expect(body).toMatch(/import \{ accounts, subscriptions \} from '\.\/schema\.js';/);
  });

  it('toAccount mapper: 5-field BillingAccountSnapshot (id, email, name, tier, stripeCustomerId)', () => {
    expect(body).toMatch(
      /function toAccount\(r: typeof accounts\.\$inferSelect\): BillingAccountSnapshot \{\s*return \{\s*id: r\.id,\s*email: r\.email,\s*name: r\.name,\s*tier: r\.tier,\s*stripeCustomerId: r\.stripeCustomerId,\s*\};\s*\}/,
    );
  });

  it('toSubscription mapper: 10-field (id + accountId + stripeSubscriptionId + stripePriceId + tier + status + currentPeriodEnd + cancelAtPeriodEnd + canceledAt + created/updated_at)', () => {
    expect(body).toMatch(
      /function toSubscription\(r: typeof subscriptions\.\$inferSelect\): SubscriptionMirror \{\s*return \{\s*id: r\.id,\s*accountId: r\.accountId,\s*stripeSubscriptionId: r\.stripeSubscriptionId,\s*stripePriceId: r\.stripePriceId,\s*tier: r\.tier,\s*status: r\.status,\s*currentPeriodEnd: r\.currentPeriodEnd,\s*cancelAtPeriodEnd: r\.cancelAtPeriodEnd,\s*canceledAt: r\.canceledAt,\s*createdAt: r\.createdAt,\s*updatedAt: r\.updatedAt,\s*\};\s*\}/,
    );
  });

  it("W197 framing pinned: only `db` handle is read; narrow the dependency to make e2e fixtures composable without the full Database envelope ({ client, db, close }); class constructor takes Pick<Database, 'db'>", () => {
    expect(body).toMatch(
      /\/\/ W197 — only the `db` handle is read; narrow the dependency to make\s*\/\/ e2e fixtures composable without the full Database envelope\s*\/\/ \(`\{ client, db, close \}`\)\./,
    );
    expect(body).toMatch(
      /export class DrizzleBillingRepo implements BillingRepo \{\s*constructor\(private readonly database: Pick<Database, 'db'>\) \{\}/,
    );
  });

  it('getAccount: select * from accounts where id + limit 1; returns toAccount(row) or null', () => {
    expect(body).toMatch(
      /async getAccount\(accountId: string\): Promise<BillingAccountSnapshot \| null> \{\s*const \[row\] = await this\.database\.db\s*\.select\(\)\s*\.from\(accounts\)\s*\.where\(eq\(accounts\.id, accountId\)\)\s*\.limit\(1\);\s*return row \? toAccount\(row\) : null;\s*\}/,
    );
  });

  it('setStripeCustomerId: update accounts set stripeCustomerId + updatedAt:new Date() where id matches', () => {
    expect(body).toMatch(
      /async setStripeCustomerId\(args: \{ accountId: string; customerId: string \}\): Promise<void> \{\s*await this\.database\.db\s*\.update\(accounts\)\s*\.set\(\{ stripeCustomerId: args\.customerId, updatedAt: new Date\(\) \}\)\s*\.where\(eq\(accounts\.id, args\.accountId\)\);\s*\}/,
    );
  });

  it('findCurrentSubscription framing pinned: most-recent first by created_at; route layer can filter to active statuses if it cares; do NOT filter here so the dashboard can surface "your last subscription was canceled on X" without an extra query; orderBy desc createdAt + limit 1', () => {
    expect(body).toMatch(
      /\/\/ Most-recent first by created_at; route layer can filter to active\s*\/\/ statuses if it cares\. We don't filter here so the dashboard can\s*\/\/ surface "your last subscription was canceled on X" without an\s*\/\/ extra query\./,
    );
    expect(body).toMatch(
      /const \[row\] = await this\.database\.db\s*\.select\(\)\s*\.from\(subscriptions\)\s*\.where\(eq\(subscriptions\.accountId, accountId\)\)\s*\.orderBy\(desc\(subscriptions\.createdAt\)\)\s*\.limit\(1\);\s*return row \? toSubscription\(row\) : null;/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
