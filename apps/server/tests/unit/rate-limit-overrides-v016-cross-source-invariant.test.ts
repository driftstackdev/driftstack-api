// W931 — rate-limit-overrides V-016 admin-only cross-source
// invariant. Two-hundred-fifty-seventh in the drift-guard series.
// Pins the admin-only per-account rate-limit override service:
//
//   Admin-only service framing — 'Sets / clears per-account, per-bucket
//   overrides of the rate-limit config'.
//
//   Override storage — separate rate_limit_overrides table. Consume
//   path picks them up via AccountContext (loaded at auth time +
//   cached). Set/clear invalidate auth cache so next read sees change.
//
//   V-016 centi-rate quantization framing — 'schema stores
//   refill_per_second as 100× the actual rate (centi-rate) to avoid
//   float drift. The service accepts a float at the API boundary and
//   converts at write time. V-016 documented the quantization caveat
//   (1/60 → 2 → 1/50 effective). Acceptable for overrides because
//   they're more permissive than tier defaults; if exact tier matching
//   is ever required, migrate the column to numeric(10,4)'.
//
//   Validation bounds:
//     - MIN_REFILL = 0.01 (matches centi quantum).
//     - MAX_REFILL = 100_000 (sanity cap; enterprise tier global is
//       1000/s).
//     - capacity must be positive integer + Number.isFinite.
//     - expiresAt must be in the future.
//
//   RateLimitOverrideRecord (10 fields):
//     - id + accountId + bucketKey + capacity + refillPerSecond
//       + reason (nullable) + expiresAt + setByKeyId + createdAt
//       + updatedAt.
//
//   set(), clear(), and listAll() require the exact
//     'driftstack_internal_admin' scope because every operation is
//     cross-account staff tooling; legacy customer 'admin' is not a
//     staff-authority alias.
//
//   Cache invalidation graceful-degradation framing — 'Cache failure
//     must not propagate as admin-action failure — override is
//     committed; cache TTLs out within 30s in worst case'. Matches
//     D-020 auth-cache 30s-worst-case contract.
//
//   capacity flooring via Math.floor(input.capacity) — integer
//     storage.
//
// stays in lockstep across apps/server/src/services/rate-limit-overrides.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W931 rate-limit-overrides V-016 centi-quantum cross-source invariant', () => {
  // ─── Admin-only intro framing ────────────────────────────────

  it("CRITICAL apps/server/src/services/rate-limit-overrides.ts header pins 'Rate-limit override service (admin-only)'. The admin-only intro is the access-control provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit-overrides.ts'));
    expect(p).toMatch(/Rate-limit override service \(admin-only\)/);
  });

  // ─── Storage + AccountContext + cache-invalidation flow ──────

  it("CRITICAL storage + flow framing — 'Sets / clears per-account, per-bucket overrides of the rate-limit config. Override storage is a separate table (rate_limit_overrides); the consume path picks them up via AccountContext, which is loaded at auth time and cached. Set / clear invalidate the auth cache so the next auth read picks up the change'. The set→invalidate→consume flow is the central propagation contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit-overrides.ts'));
    expect(p).toMatch(/Sets \/ clears per-account, per-bucket overrides of the rate-limit/);
    expect(p).toMatch(/config\. Override storage is a separate table \(rate_limit_overrides\);/);
    expect(p).toMatch(/the consume path picks them up via AccountContext, which is loaded/);
    expect(p).toMatch(/at auth time and cached\. Set \/ clear invalidate the auth cache so/);
    expect(p).toMatch(/the next auth read picks up the change/);
  });

  // ─── V-016 centi-rate quantization framing ───────────────────

  it("CRITICAL V-016 centi-rate framing — 'Centi-rate quantization: the schema stores refill_per_second as 100× the actual rate (centi-rate) to avoid float drift. The service accepts a float at the API boundary and converts at write time. V-016 documented the quantization caveat (1/60 → 2 → 1/50 effective). Acceptable for overrides because they're more permissive than tier defaults; if exact tier matching is ever required, migrate the column to numeric(10,4)'. The V-016 anchor + 1/60→1/50 example is the float-drift policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit-overrides.ts'));
    expect(p).toMatch(/Centi-rate quantization: the schema stores refill_per_second as 100×/);
    expect(p).toMatch(/the actual rate \(centi-rate\) to avoid float drift\. The service/);
    expect(p).toMatch(/accepts a float at the API boundary and converts at write time/);
    expect(p).toMatch(/V-016 documented the quantization caveat \(1\/60 → 2 → 1\/50 effective\)/);
    expect(p).toMatch(/Acceptable for overrides because they're more permissive than tier/);
    expect(p).toMatch(/defaults; if exact tier matching is ever required, migrate the column/);
    expect(p).toMatch(/to numeric\(10,4\)/);
  });

  // ─── MIN_REFILL + MAX_REFILL bounds ──────────────────────────

  it("CRITICAL MIN_REFILL = 0.01 (matches centi quantum) + MAX_REFILL = 100_000 (sanity cap; enterprise tier global is 1000/s). The 0.01 → 100000 bounds are 7 orders of magnitude — 'enterprise tier global is 1000/s' framing means MAX_REFILL is 100× the highest legitimate tier default.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit-overrides.ts'));
    expect(p).toMatch(/const MIN_REFILL = 0\.01;\s*\/\/ matches centi quantum/);
    expect(p).toMatch(
      /const MAX_REFILL = 100_000;\s*\/\/ sanity cap; enterprise tier global is 1000\/s/,
    );
  });

  // ─── RateLimitOverrideRecord 10-field shape ──────────────────

  it('CRITICAL RateLimitOverrideRecord has 10 fields — id + accountId + bucketKey + capacity + refillPerSecond + reason (nullable) + expiresAt + setByKeyId + createdAt + updatedAt. The 10-field shape carries the audit provenance (setByKeyId + reason) + the runtime values (capacity + refillPerSecond + expiresAt).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit-overrides.ts'));
    expect(p).toMatch(/export interface RateLimitOverrideRecord \{/);
    expect(p).toMatch(/id: string;/);
    expect(p).toMatch(/accountId: string;/);
    expect(p).toMatch(/bucketKey: string;/);
    expect(p).toMatch(/capacity: number;/);
    expect(p).toMatch(/refillPerSecond: number;/);
    expect(p).toMatch(/reason: string \| null;/);
    expect(p).toMatch(/expiresAt: Date;/);
    expect(p).toMatch(/setByKeyId: string;/);
    expect(p).toMatch(/createdAt: Date;/);
    expect(p).toMatch(/updatedAt: Date;/);
  });

  // ─── set() 3-condition validation ────────────────────────────

  it("CRITICAL set() validates capacity — 'capacity must be a positive integer' (ConflictError on capacity < 1 OR !Number.isFinite). The positive-integer requirement is what makes the rate-limit storage-stable.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit-overrides.ts'));
    expect(p).toMatch(/if \(input\.capacity < 1 \|\| !Number\.isFinite\(input\.capacity\)\) \{/);
    expect(p).toMatch(/throw new ConflictError\('capacity must be a positive integer\.'\);/);
  });

  it('CRITICAL set() validates refillPerSecond ∈ [MIN_REFILL, MAX_REFILL] with ConflictError + interpolated bounds. The bounds-validation prevents subtle accidental rate-limit-bypasses via too-large values.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit-overrides.ts'));
    expect(p).toMatch(
      /if \(input\.refillPerSecond < MIN_REFILL \|\| input\.refillPerSecond > MAX_REFILL\) \{/,
    );
    expect(p).toMatch(
      /`refill_per_second must be between \$\{MIN_REFILL\.toString\(\)\} and \$\{MAX_REFILL\.toString\(\)\}\.`,/,
    );
  });

  it("CRITICAL set() validates expiresAt is in the future — 'expires_at must be in the future' ConflictError. The future-only requirement prevents accidentally-creating-already-expired overrides.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit-overrides.ts'));
    expect(p).toMatch(/if \(input\.expiresAt\.getTime\(\) <= Date\.now\(\)\) \{/);
    expect(p).toMatch(/throw new ConflictError\('expires_at must be in the future\.'\);/);
  });

  // ─── capacity flooring ───────────────────────────────────────

  it('CRITICAL set() applies Math.floor(input.capacity) at write time. The floor avoids subtle storage-vs-input mismatches when callers pass float capacities (e.g. 100.5 → 100 stored).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit-overrides.ts'));
    expect(p).toMatch(/capacity: Math\.floor\(input\.capacity\),/);
  });

  // ─── set/clear/listAll scope requirements ────────────────────

  it("CRITICAL set() + clear() + listAll() all require exact 'driftstack_internal_admin' (V-174 staff cross-account tooling); legacy customer 'admin' cannot pass", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit-overrides.ts'));
    // No literal-'admin' gate remains — all three methods use the staff scope.
    expect(p).not.toMatch(/throwIfMissingScope\(ctx, 'admin'\);/);
    expect(
      (p.match(/throwIfMissingScope\(ctx, 'driftstack_internal_admin'\);/g) ?? []).length,
    ).toBe(3);
  });

  // ─── clear() returns 404 when no override exists ─────────────

  it("CRITICAL clear() throws NotFoundError 'No active override for account X bucket Y' when no row exists. The 404 message + 2-field interpolation is the customer-facing error contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit-overrides.ts'));
    expect(p).toMatch(
      /`No active override for account "\$\{accountId\}" bucket "\$\{bucketKey\}"\.`,/,
    );
  });

  // ─── repo.upsert by (account_id, bucket_key) ─────────────────

  it("CRITICAL repo.upsert framing — 'Upsert by (account_id, bucket_key)'. The 2-column dedup is what makes set() idempotent for repeated calls.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit-overrides.ts'));
    expect(p).toMatch(/Upsert by \(account_id, bucket_key\)/);
  });

  // ─── listAll cross-account + includeExpired framing ──────────

  it("CRITICAL listAll JSDoc — 'Cross-account list for admin tooling. Filters by accountId optionally; supports cursor pagination by createdAt DESC. Optional includeExpired (default false) — when false, only overrides whose expiresAt is in the future are returned'. The default-exclude-expired keeps admin reads scoped to actionable rows.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit-overrides.ts'));
    expect(p).toMatch(/Cross-account list for admin tooling\. Filters by accountId/);
    expect(p).toMatch(/optionally; supports cursor pagination by createdAt DESC\. Optional/);
    expect(p).toMatch(/`includeExpired` \(default false\) — when false, only overrides/);
    expect(p).toMatch(/whose expiresAt is in the future are returned/);
  });

  // ─── Cache invalidation graceful-degradation ─────────────────

  it("CRITICAL cache invalidation graceful-degradation framing — 'Cache failure must not propagate as admin-action failure — override is committed; cache TTLs out within 30s in worst case'. The 30s-worst-case ties back to D-020 auth-cache TTL.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit-overrides.ts'));
    expect(p).toMatch(/Cache failure must not propagate as admin-action failure —/);
    expect(p).toMatch(/override is committed; cache TTLs out within 30s in worst case/);
  });

  it('CRITICAL invalidateCache no-op when authCache is null — for tests that skip cache wiring. Mechanically verified via early return.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit-overrides.ts'));
    expect(p).toMatch(
      /private async invalidateCache\(accountId: string\): Promise<void> \{\s*\n\s*if \(!this\.authCache\) return;/,
    );
  });

  // ─── setByKeyId provenance from ctx.apiKey.id ────────────────

  it("CRITICAL setByKeyId provenance — 'setByKeyId: ctx.apiKey.id'. The audit-provenance traces the override back to the specific admin API key that set it.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit-overrides.ts'));
    expect(p).toMatch(/setByKeyId: ctx\.apiKey\.id,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/rate-limit-overrides-v016-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
