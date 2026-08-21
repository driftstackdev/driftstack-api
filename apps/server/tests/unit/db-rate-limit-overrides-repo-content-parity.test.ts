// W444.B — drift guard for apps/server/src/db/rate-limit-overrides-repo.ts.
// RateLimitOverrides upsert-by-(account_id,bucket_key) repo. Drift
// here either drops the centi-scale conversion on refillPerSecond
// (DB stores integer hundredths; floating-point divergence silently
// rounds rate limits to wrong values) or the >=1 floor (zero-refill
// override locks bucket forever; intent-preserving Math.max(1, ...)).
//
//   • Upsert-by-(account_id, bucket_key) framing pinned: re-setting
//     same bucket REPLACES the prior override.
//   • Centi-scale storage: refillPerSecondCenti = Math.max(1,
//     Math.round(refillPerSecond * 100)); read-side divides by 100.
//   • onConflictDoUpdate target = [accountId, bucketKey]; updatedAt
//     bumped on conflict.
//   • clear: account+bucket-scoped delete returning {id}; boolean.
//   • listAll: filters (accountId, includeExpired gt(expiresAt, now)),
//     cursor lt(createdAt, parsed-date), orderBy desc(createdAt),
//     limit+1 hasMore + nextCursor = last.createdAt.toISOString().

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/rate-limit-overrides-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W444.B apps/server/src/db/rate-limit-overrides-repo.ts content parity', () => {
  const body = read(LIB);

  it('Upsert-by-(account_id,bucket_key) framing pinned: "Drizzle-backed RateLimitOverridesRepo. Upsert by (account_id, bucket_key) — re-setting the same bucket replaces the prior override."', () => {
    expect(body).toMatch(
      /\/\/ Drizzle-backed RateLimitOverridesRepo\. Upsert by \(account_id,\s*\n?\s*\/\/ bucket_key\) — re-setting the same bucket replaces the prior override\./,
    );
  });

  it('imports: SQL type + and/desc/eq/gt/lt; RateLimitOverrideRecord/Repo + SetOverrideInput; Database; rateLimitOverrides schema', () => {
    expect(body).toMatch(/import \{ type SQL, and, desc, eq, gt, lt, or \} from 'drizzle-orm';/);
    expect(body).toMatch(
      /import type \{\s*\n?\s*RateLimitOverrideRecord,\s*\n?\s*RateLimitOverridesRepo,\s*\n?\s*SetOverrideInput,\s*\n?\s*\} from '\.\.\/services\/rate-limit-overrides\.js';/,
    );
    expect(body).toMatch(/import \{ rateLimitOverrides \} from '\.\/schema\.js';/);
  });

  it('upsert centi-scale floor, now via toRefillCenti: Math.max(1, Math.round(refillPerSecond * REFILL_CENTI_SCALE))', () => {
    expect(body).toMatch(/const REFILL_CENTI_SCALE = 100;/);
    // V-1241 — the arithmetic moved into `toRefillCenti` so the double and the contract
    // can share it instead of each restating it. Same floor, same scale, one home.
    expect(body).toMatch(
      /return Math\.max\(1, Math\.round\(refillPerSecond \* REFILL_CENTI_SCALE\)\);/,
    );
    expect(body).toMatch(/const refillCenti = toRefillCenti\(input\.refillPerSecond\);/);
  });

  it("upsert: 7-field values (accountId + bucketKey + capacity + refillPerSecondCenti + reason nullable + expiresAt + setByKeyId); onConflictDoUpdate target=[accountId, bucketKey] + updatedAt:new Date() on conflict; throws 'rate_limit_overrides upsert returned no row'", () => {
    expect(body).toMatch(
      /\.values\(\{\s*\n?\s*accountId: input\.accountId,\s*\n?\s*bucketKey: input\.bucketKey,\s*\n?\s*capacity: input\.capacity,\s*\n?\s*refillPerSecondCenti: refillCenti,\s*\n?\s*reason: input\.reason \?\? null,\s*\n?\s*expiresAt: input\.expiresAt,\s*\n?\s*setByKeyId: input\.setByKeyId,\s*\n?\s*\}\)\s*\n?\s*\.onConflictDoUpdate\(\{\s*\n?\s*target: \[rateLimitOverrides\.accountId, rateLimitOverrides\.bucketKey\],\s*\n?\s*set: \{\s*\n?\s*capacity: input\.capacity,\s*\n?\s*refillPerSecondCenti: refillCenti,\s*\n?\s*reason: input\.reason \?\? null,\s*\n?\s*expiresAt: input\.expiresAt,\s*\n?\s*setByKeyId: input\.setByKeyId,\s*\n?\s*updatedAt: new Date\(\),\s*\n?\s*\},\s*\n?\s*\}\)\s*\n?\s*\.returning\(\);\s*\n?\s*if \(!row\) throw new Error\('rate_limit_overrides upsert returned no row'\);/,
    );
  });

  it('clear: account+bucket-scoped delete returning {id}; returns result.length > 0', () => {
    expect(body).toMatch(
      /async clear\(accountId: string, bucketKey: string\): Promise<boolean> \{\s*\n?\s*const result = await this\.database\.db\s*\n?\s*\.delete\(rateLimitOverrides\)\s*\n?\s*\.where\(\s*\n?\s*and\(\s*\n?\s*eq\(rateLimitOverrides\.accountId, accountId\),\s*\n?\s*eq\(rateLimitOverrides\.bucketKey, bucketKey\),\s*\n?\s*\),\s*\n?\s*\)\s*\n?\s*\.returning\(\{ id: rateLimitOverrides\.id \}\);\s*\n?\s*return result\.length > 0;\s*\n?\s*\}/,
    );
  });

  it('listAll: keyset cursor (createdAt,id) + accountId eq + !includeExpired → gt(expiresAt, new Date()); orderBy (createdAt desc, id desc); nextCursor = last.id', () => {
    expect(body).toMatch(/const filters: SQL\[\] = \[\];/);
    // Keyset cursor (createdAt, id) — looked up by cursor id.
    expect(body).toMatch(/lt\(rateLimitOverrides\.createdAt, c\.createdAt\),/);
    expect(body).toMatch(
      /and\(eq\(rateLimitOverrides\.createdAt, c\.createdAt\), lt\(rateLimitOverrides\.id, c\.id\)\),/,
    );
    expect(body).toMatch(
      /if \(opts\.accountId\) filters\.push\(eq\(rateLimitOverrides\.accountId, opts\.accountId\)\);/,
    );
    expect(body).toMatch(
      /if \(!opts\.includeExpired\) filters\.push\(gt\(rateLimitOverrides\.expiresAt, new Date\(\)\)\);/,
    );
    expect(body).toMatch(
      /\.orderBy\(desc\(rateLimitOverrides\.createdAt\), desc\(rateLimitOverrides\.id\)\)/,
    );
    expect(body).toMatch(/nextCursor: hasMore && last \? last\.id : null,/);
  });

  it('toRecord: read-side divides centi by 100 (refillPerSecond: r.refillPerSecondCenti / 100); 9-field record', () => {
    expect(body).toMatch(
      /function toRecord\(r: typeof rateLimitOverrides\.\$inferSelect\): RateLimitOverrideRecord \{\s*\n?\s*return \{\s*\n?\s*id: r\.id,\s*\n?\s*accountId: r\.accountId,\s*\n?\s*bucketKey: r\.bucketKey,\s*\n?\s*capacity: r\.capacity,\s*\n?\s*refillPerSecond: r\.refillPerSecondCenti \/ REFILL_CENTI_SCALE,\s*\n?\s*reason: r\.reason,\s*\n?\s*expiresAt: r\.expiresAt,\s*\n?\s*setByKeyId: r\.setByKeyId,\s*\n?\s*createdAt: r\.createdAt,\s*\n?\s*updatedAt: r\.updatedAt,\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
