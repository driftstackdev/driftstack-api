// W397.C — drift guard for apps/server/src/services/rate-limit-overrides.ts.
// Admin-only set/clear of per-(account, bucket) rate-limit overrides.
// V-016 centi-rate quantization framing — schema stores 100× actual
// rate to avoid float drift. Pairs with the W395.B services/rate-limit
// effectiveBucketConfig consumer. Drift here either lets a non-admin
// raise their own limit (catastrophic) or fails to invalidate the
// auth cache (override invisible to next 30s of requests).
//
//   • V-016 centi-rate quantization framing pinned.
//   • Service: set / clear / listAll — 3 admin-gated methods.
//   • Set / clear / listAll require the exact
//     'driftstack_internal_admin' staff scope; legacy customer 'admin'
//     is deliberately insufficient.
//   • Validation cascade: capacity≥1 + finite, refillPerSecond bounds
//     (MIN=0.01 — matches centi quantum, MAX=100_000 — enterprise
//     global is 1000/s).
//   • expires_at must be strictly in the future.
//   • Cache invalidation on every mutation; failure absorbed silently
//     (override committed; cache TTLs out within 30s worst-case).
//   • setByKeyId pulled from ctx.apiKey.id (audit trail).
//   • clear: 404 when no active override.
//   • RateLimitOverrideRecord: 9 fields snake-cased at the route layer
//     but camelCased in the repo Record type.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/rate-limit-overrides.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W397.C apps/server/src/services/rate-limit-overrides.ts content parity', () => {
  const body = read(LIB);

  it('Module framing pinned: admin-only set/clear, AccountContext-loaded, invalidate-cache-on-mutation', () => {
    expect(body).toMatch(
      /Rate-limit override service \(admin-only\)\.\s*\n?\s*\/\/\s*\n?\s*\/\/\s*Sets \/ clears per-account, per-bucket overrides of the rate-limit\s*\n?\s*\/\/\s*config\. Override storage is a separate table \(rate_limit_overrides\);\s*\n?\s*\/\/\s*the consume path picks them up via AccountContext, which is loaded\s*\n?\s*\/\/\s*at auth time and cached\. Set \/ clear invalidate the auth cache so\s*\n?\s*\/\/\s*the next auth read picks up the change/,
    );
  });

  it('V-016 centi-rate quantization framing pinned (1/60 → 2 → 1/50 effective; numeric(10,4) migration path)', () => {
    expect(body).toMatch(
      /Centi-rate quantization: the schema stores refill_per_second as 100×\s*\n?\s*\/\/\s*the actual rate \(centi-rate\) to avoid float drift\./,
    );
    expect(body).toMatch(
      /V-016 documented the quantization caveat \(1\/60 → 2 → 1\/50 effective\)\.\s*\n?\s*\/\/\s*Acceptable for overrides because they're more permissive than tier\s*\n?\s*\/\/\s*defaults; if exact tier matching is ever required, migrate the column\s*\n?\s*\/\/\s*to numeric\(10,4\)/,
    );
  });

  it('RateLimitOverrideRecord: 9 camelCased fields (id, accountId, bucketKey, capacity, refillPerSecond, reason?, expiresAt, setByKeyId, createdAt, updatedAt)', () => {
    expect(body).toMatch(/export interface RateLimitOverrideRecord \{/);
    expect(body).toMatch(/id: string;/);
    expect(body).toMatch(/accountId: string;/);
    expect(body).toMatch(/bucketKey: string;/);
    expect(body).toMatch(/capacity: number;/);
    expect(body).toMatch(/refillPerSecond: number;/);
    expect(body).toMatch(/reason: string \| null;/);
    expect(body).toMatch(/expiresAt: Date;/);
    expect(body).toMatch(/setByKeyId: string;/);
    expect(body).toMatch(/createdAt: Date;/);
    expect(body).toMatch(/updatedAt: Date;/);
  });

  it('RateLimitOverridesRepo: 3 methods (upsert / clear / listAll with cursor pagination + includeExpired)', () => {
    expect(body).toMatch(/export interface RateLimitOverridesRepo \{/);
    expect(body).toMatch(/Upsert by \(account_id, bucket_key\)\./);
    expect(body).toMatch(/upsert\(input: SetOverrideInput\): Promise<RateLimitOverrideRecord>;/);
    expect(body).toMatch(/Returns true if a row was deleted, false if no override existed\./);
    expect(body).toMatch(/clear\(accountId: string, bucketKey: string\): Promise<boolean>;/);
    expect(body).toMatch(
      /Cross-account list for admin tooling\. Filters by accountId\s*\n?\s*\*\s*optionally; supports cursor pagination by createdAt DESC\./,
    );
    expect(body).toMatch(
      /listAll\(opts: \{\s*\n?\s*limit: number;\s*\n?\s*cursor\?: string;\s*\n?\s*accountId\?: string;\s*\n?\s*includeExpired\?: boolean;\s*\n?\s*\}\): Promise<\{ items: RateLimitOverrideRecord\[\]; nextCursor: string \| null \}>;/,
    );
  });

  it('Constants: MIN_REFILL=0.01 (matches centi quantum) + MAX_REFILL=100_000 (enterprise global is 1000/s sanity cap)', () => {
    expect(body).toMatch(/const MIN_REFILL = 0\.01; \/\/ matches centi quantum/);
    expect(body).toMatch(
      /const MAX_REFILL = 100_000; \/\/ sanity cap; enterprise tier global is 1000\/s/,
    );
  });

  it('RateLimitOverridesService: constructor takes repo + authCache?', () => {
    expect(body).toMatch(/export class RateLimitOverridesService \{/);
    expect(body).toMatch(
      /constructor\(\s*\n?\s*private readonly repo: RateLimitOverridesRepo,\s*\n?\s*private readonly authCache: AuthCache \| null = null,\s*\n?\s*\) \{\}/,
    );
  });

  it('set: requires exact "driftstack_internal_admin" staff scope; legacy customer admin is insufficient', () => {
    expect(body).toMatch(/throwIfMissingScope\(ctx, 'driftstack_internal_admin'\);/);
  });

  it('set validation: capacity≥1 + finite → ConflictError', () => {
    expect(body).toMatch(
      /if \(input\.capacity < 1 \|\| !Number\.isFinite\(input\.capacity\)\) \{\s*\n?\s*throw new ConflictError\('capacity must be a positive integer\.'\);\s*\n?\s*\}/,
    );
  });

  it('set validation: refillPerSecond between MIN_REFILL and MAX_REFILL → ConflictError', () => {
    expect(body).toMatch(
      /if \(input\.refillPerSecond < MIN_REFILL \|\| input\.refillPerSecond > MAX_REFILL\) \{\s*\n?\s*throw new ConflictError\(\s*\n?\s*`refill_per_second must be between \$\{MIN_REFILL\.toString\(\)\} and \$\{MAX_REFILL\.toString\(\)\}\.`,\s*\n?\s*\);\s*\n?\s*\}/,
    );
  });

  it('set validation: expiresAt strictly in the future → ConflictError', () => {
    expect(body).toMatch(
      /if \(input\.expiresAt\.getTime\(\) <= Date\.now\(\)\) \{\s*\n?\s*throw new ConflictError\('expires_at must be in the future\.'\);\s*\n?\s*\}/,
    );
  });

  it('set upsert: capacity floored, reason spread-included only when defined, setByKeyId=ctx.apiKey.id (audit)', () => {
    expect(body).toMatch(
      /const record = await this\.repo\.upsert\(\{\s*\n?\s*accountId: input\.accountId,\s*\n?\s*bucketKey: input\.bucketKey,\s*\n?\s*capacity: Math\.floor\(input\.capacity\),\s*\n?\s*refillPerSecond: input\.refillPerSecond,\s*\n?\s*expiresAt: input\.expiresAt,\s*\n?\s*\.\.\.\(input\.reason !== undefined \? \{ reason: input\.reason \} : \{\}\),\s*\n?\s*setByKeyId: ctx\.apiKey\.id,\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(/await this\.invalidateCache\(input\.accountId\);/);
  });

  it('clear: driftstack_internal_admin scope, NotFoundError when no row removed, then invalidate cache', () => {
    expect(body).toMatch(
      /async clear\(ctx: AccountContext, accountId: string, bucketKey: string\): Promise<void> \{\s*\n?\s*throwIfMissingScope\(ctx, 'driftstack_internal_admin'\);\s*\n?\s*const removed = await this\.repo\.clear\(accountId, bucketKey\);\s*\n?\s*if \(!removed\) \{\s*\n?\s*throw new NotFoundError\(\s*\n?\s*`No active override for account "\$\{accountId\}" bucket "\$\{bucketKey\}"\.`,\s*\n?\s*\);\s*\n?\s*\}\s*\n?\s*await this\.invalidateCache\(accountId\);/,
    );
  });

  it('listAll: requires "driftstack_internal_admin" scope', () => {
    expect(body).toMatch(/throwIfMissingScope\(ctx, 'driftstack_internal_admin'\);/);
    expect(body).toMatch(/return this\.repo\.listAll\(opts\);/);
  });

  it('invalidateCache: try/catch absorbs failure (override committed; cache TTLs out within 30s)', () => {
    expect(body).toMatch(
      /private async invalidateCache\(accountId: string\): Promise<void> \{\s*\n?\s*if \(!this\.authCache\) return;\s*\n?\s*try \{\s*\n?\s*await this\.authCache\.invalidateAccount\(accountId\);\s*\n?\s*\} catch \{\s*\n?\s*\/\/ Cache failure must not propagate as admin-action failure —\s*\n?\s*\/\/ override is committed; cache TTLs out within 30s in worst case\./,
    );
  });

  it('imports: AuthCache type + AccountContext type + ConflictError/NotFoundError + requireScope aliased as throwIfMissingScope', () => {
    expect(body).toMatch(/import type \{ AuthCache \} from '\.\/auth-cache\.js';/);
    expect(body).toMatch(/import type \{ AccountContext \} from '\.\/auth\.js';/);
    expect(body).toMatch(/import \{ ConflictError, NotFoundError \} from '\.\.\/lib\/errors\.js';/);
    expect(body).toMatch(
      /import \{ requireScope as throwIfMissingScope \} from '\.\.\/lib\/errors-helpers\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
