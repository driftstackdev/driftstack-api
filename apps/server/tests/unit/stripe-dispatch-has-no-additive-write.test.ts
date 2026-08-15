// No write on the Stripe dispatch path may be additive.
//
// `StripeWebhooksService.handle` runs `dispatch(event)` BEFORE the
// `INSERT … ON CONFLICT DO NOTHING` whose `inserted` flag resolves a concurrent
// delivery. The comment there is accurate about what that flag does — it decides
// which delivery OWNS the event — but it is worth being exact about what it does
// not do: under a real race both deliveries have already executed the side
// effects. Only the reported outcome is deduped.
//
// That is safe today, and for a specific reason rather than by luck: every handler
// on the path is an upsert or a set — `upsertSubscription`, `setAccountTier`,
// `activateCryptoEntitlement` under a row lock with documented lock ordering — so
// running it twice lands on the same state. Measured when the SQL-level replay
// guard was written: eleven write statements across the two files, seven `.set(`
// calls, zero additive writes.
//
// The property is therefore CONDITIONAL, and nothing enforced the condition. Add
// one `balance = balance + delta` to a handler and the documented, accepted race
// silently becomes a double-credit — with the idempotency test still green,
// because that test asserts the flag, not the arithmetic.
//
// Scope is deliberately the Stripe dispatch path only. The NowPayments/crypto IPN
// path has its own idempotency and its own race analysis; asserting over it here
// would make this guard about a property it has not established.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

const DISPATCH_PATH_FILES = ['services/stripe-webhooks.ts', 'db/stripe-webhooks-repo.ts'] as const;

/**
 * An additive write: a column read back into its own update, a compound
 * assignment, or an explicitly named increment. Matches the SHAPE of accumulation
 * rather than any particular column, so a new balance-like field is covered the
 * day it appears.
 */
const ADDITIVE = /sql`[^`]*\$\{[^}]*\}\s*[+-]|[+-]=\s|\bincrement\b|\bdecrement\b/;

function read(rel: string): string {
  return readFileSync(resolve(SRC, rel), 'utf8');
}

describe('Stripe dispatch path carries no additive write', () => {
  it('the detector detects — a guard whose pattern matches nothing would pass forever', () => {
    // Anti-vacuity on the INSTRUMENT, which is the part that silently rots. Both
    // directions: it must catch the shapes that would break the race analysis, and
    // must ignore the ordinary writes that fill these files.
    expect(
      ADDITIVE.test('.set({ balanceMinutes: sql`${accounts.balanceMinutes} + ${delta}` })'),
    ).toBe(true);
    expect(ADDITIVE.test('totalCredits += args.amount;')).toBe(true);
    expect(ADDITIVE.test('.set({ tier: args.tier, updatedAt: now })')).toBe(false);
    expect(ADDITIVE.test('const label = prefix + suffix;')).toBe(false);
  });

  it('the scan reaches real files with real writes, so "clean" means checked rather than not looked', () => {
    const writes = DISPATCH_PATH_FILES.reduce(
      (n, rel) => n + (read(rel).match(/\.(insert|update)\(/g)?.length ?? 0),
      0,
    );
    // Floors below the measured 11 writes / 7 sets, so ordinary edits do not trip
    // them while a scan that stopped seeing the files does.
    expect(writes, 'write statements found on the dispatch path').toBeGreaterThanOrEqual(8);
    expect(read('db/stripe-webhooks-repo.ts')).toContain('onConflictDoNothing');
  });

  it('CRITICAL no additive write exists on the path. dispatch() runs BEFORE the idempotency insert, so a concurrent delivery executes every handler twice — that is only harmless while each one is an upsert or a set. One accumulation here turns an accepted race into a double-credit, and the idempotency test stays green because it asserts the flag, not the arithmetic.', () => {
    const offenders: string[] = [];
    for (const rel of DISPATCH_PATH_FILES) {
      read(rel)
        .split('\n')
        .forEach((line, i) => {
          if (ADDITIVE.test(line)) offenders.push(`${rel}:${i + 1} ${line.trim()}`);
        });
    }
    expect(offenders, 'additive write(s) on a path that runs twice under a race').toEqual([]);
  });
});
