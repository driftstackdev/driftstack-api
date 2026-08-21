// W1009 — db/rate-limit-overrides-repo V-016 cross-source invariant.
// Three-hundred-thirty-fifth in the drift-guard series. Pins the
// apps/server/src/db/rate-limit-overrides-repo.ts admin rate-limit
// override repo:
//
//   Header — 'Drizzle-backed RateLimitOverridesRepo. Upsert by
//   (account_id, bucket_key) — re-setting the same bucket replaces
//   the prior override'.
//
//   3-method surface — upsert + clear + listAll.
//
//   V-016 centi-rate quantization — 'refillCenti = Math.max(1, Math.
//   round(input.refillPerSecond * 100))'. The max(1, ...) floor
//   prevents the 0-refill-rate edge case + the *100 keeps centi-rate
//   storage precision.
//
//   upsert onConflictDoUpdate target — compound [accountId, bucketKey]
//   + 6-field SET (capacity + refillPerSecondCenti + reason +
//   expiresAt + setByKeyId + updatedAt).
//
//   clear deletes by (accountId, bucketKey) tuple + returning length
//   > 0 boolean.
//
//   listAll 3-filter — cursor (lt createdAt) + accountId (eq) +
//   !includeExpired → gt(expiresAt, new Date()). The default-exclude-
//   expired design lets admin dashboards show active-only without
//   special-casing.
//
//   listAll orderBy desc(createdAt) + limit+1 hasMore + ISO cursor.
//
//   toRecord 10-field shape with refillPerSecond = centi/100
//   dequantization (V-016 caveat).
//
// stays in lockstep across apps/server/src/db/rate-limit-overrides-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1009 db/rate-limit-overrides-repo V-016 cross-source invariant', () => {
  it("CRITICAL header — 'Drizzle-backed RateLimitOverridesRepo. Upsert by (account_id, bucket_key) — re-setting the same bucket replaces the prior override'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/rate-limit-overrides-repo.ts'));
    expect(p).toMatch(/\/\/ Drizzle-backed RateLimitOverridesRepo\. Upsert by \(account_id,/);
    expect(p).toMatch(
      /\/\/ bucket_key\) — re-setting the same bucket replaces the prior override\./,
    );
    expect(p).toMatch(
      /export class DrizzleRateLimitOverridesRepo implements RateLimitOverridesRepo \{/,
    );
  });

  it('CRITICAL 3-method surface — upsert + clear + listAll.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/rate-limit-overrides-repo.ts'));
    expect(p).toMatch(
      /async upsert\(input: SetOverrideInput\): Promise<RateLimitOverrideRecord> \{/,
    );
    expect(p).toMatch(/async clear\(accountId: string, bucketKey: string\): Promise<boolean> \{/);
    expect(p).toMatch(/async listAll\(opts: \{/);
  });

  it("CRITICAL V-016 centi-rate quantization, now via toRefillCenti — 'Math.max(1, Math.round(refillPerSecond * REFILL_CENTI_SCALE))'. The max(1) floor prevents the 0-refill edge case, which is a permanent lockout rather than a rate limit.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/rate-limit-overrides-repo.ts'));
    expect(p).toMatch(/const REFILL_CENTI_SCALE = 100;/);
    // V-1241 — the floor and the scale now live in `toRefillCenti`, which the in-memory
    // double and the parity contract import rather than restate. The invariant this arm
    // guards is unchanged: max(1) still prevents a zero refill, which is a permanent lockout.
    expect(p).toMatch(
      /return Math\.max\(1, Math\.round\(refillPerSecond \* REFILL_CENTI_SCALE\)\);/,
    );
    expect(p).toMatch(/const refillCenti = toRefillCenti\(input\.refillPerSecond\);/);
  });

  it('CRITICAL upsert onConflictDoUpdate target — [accountId, bucketKey] compound + 6-field SET.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/rate-limit-overrides-repo.ts'));
    expect(p).toMatch(/target: \[rateLimitOverrides\.accountId, rateLimitOverrides\.bucketKey\],/);
    expect(p).toMatch(/capacity: input\.capacity,/);
    expect(p).toMatch(/refillPerSecondCenti: refillCenti,/);
    expect(p).toMatch(/reason: input\.reason \?\? null,/);
    expect(p).toMatch(/expiresAt: input\.expiresAt,/);
    expect(p).toMatch(/setByKeyId: input\.setByKeyId,/);
    expect(p).toMatch(/updatedAt: new Date\(\),/);
    expect(p).toMatch(
      /if \(!row\) throw new Error\('rate_limit_overrides upsert returned no row'\);/,
    );
  });

  it('CRITICAL clear deletes by (accountId, bucketKey) + returning length > 0 boolean.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/rate-limit-overrides-repo.ts'));
    expect(p).toMatch(/\.delete\(rateLimitOverrides\)/);
    expect(p).toMatch(/eq\(rateLimitOverrides\.accountId, accountId\),/);
    expect(p).toMatch(/eq\(rateLimitOverrides\.bucketKey, bucketKey\),/);
    expect(p).toMatch(/\.returning\(\{ id: rateLimitOverrides\.id \}\);/);
    expect(p).toMatch(/return result\.length > 0;/);
  });

  it('CRITICAL listAll 3-filter — cursor (lt createdAt) + accountId (eq) + !includeExpired → gt(expiresAt, new Date()). The default-exclude-expired design.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/rate-limit-overrides-repo.ts'));
    // Keyset cursor (createdAt, id) — looked up by cursor id, compound filter.
    expect(p).toMatch(/lt\(rateLimitOverrides\.createdAt, c\.createdAt\),/);
    expect(p).toMatch(
      /and\(eq\(rateLimitOverrides\.createdAt, c\.createdAt\), lt\(rateLimitOverrides\.id, c\.id\)\),/,
    );
    expect(p).toMatch(
      /if \(opts\.accountId\) filters\.push\(eq\(rateLimitOverrides\.accountId, opts\.accountId\)\);/,
    );
    expect(p).toMatch(
      /if \(!opts\.includeExpired\) filters\.push\(gt\(rateLimitOverrides\.expiresAt, new Date\(\)\)\);/,
    );
  });

  it('CRITICAL listAll orderBy (createdAt desc, id desc) + limit+1 hasMore + id keyset cursor.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/rate-limit-overrides-repo.ts'));
    expect(p).toMatch(
      /\.orderBy\(desc\(rateLimitOverrides\.createdAt\), desc\(rateLimitOverrides\.id\)\)/,
    );
    expect(p).toMatch(/\.limit\(opts\.limit \+ 1\);/);
    expect(p).toMatch(/nextCursor: hasMore && last \? last\.id : null,/);
  });

  it('CRITICAL toRecord 10-field shape with V-016 refillPerSecond = centi/100 dequantization.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/rate-limit-overrides-repo.ts'));
    expect(p).toMatch(
      /function toRecord\(r: typeof rateLimitOverrides\.\$inferSelect\): RateLimitOverrideRecord \{/,
    );
    expect(p).toMatch(/id: r\.id,/);
    expect(p).toMatch(/accountId: r\.accountId,/);
    expect(p).toMatch(/bucketKey: r\.bucketKey,/);
    expect(p).toMatch(/capacity: r\.capacity,/);
    expect(p).toMatch(/refillPerSecond: r\.refillPerSecondCenti \/ REFILL_CENTI_SCALE,/);
    expect(p).toMatch(/reason: r\.reason,/);
    expect(p).toMatch(/expiresAt: r\.expiresAt,/);
    expect(p).toMatch(/setByKeyId: r\.setByKeyId,/);
    expect(p).toMatch(/createdAt: r\.createdAt,/);
    expect(p).toMatch(/updatedAt: r\.updatedAt,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/db-rate-limit-overrides-repo-v016-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
