// W924 — D-020 auth-cache scrypt-amortise cross-source invariant.
// Two-hundred-fiftieth in the drift-guard series. Pins the auth-
// cache security + performance model:
//
//   Performance framing — 'amortises scrypt verification cost
//   across the 30-second TTL window. Without this, every
//   authenticated request re-runs scrypt (logN=15, ~50–100 ms on
//   dev hardware), which dominated the API's p50/p99 latency under
//   load (V-010 finding 2)'.
//
//   D-020 security model:
//     - At-rest hash strength preserved: scrypt logN=15 stays in
//       lib/api-keys.ts. Cache is performance optimisation only.
//     - Cache key is sha256(plaintext) — non-reversible. Storing
//       raw plaintext would weaken posture if Redis compromised.
//     - TTL 30s. Customers documented: key revocation takes effect
//       within 30s worst case.
//     - Revocation triggers invalidateKey(keyId) immediately;
//       cached entry deleted via reverse-index lookup.
//     - Account tier/status changes trigger
//       invalidateAccount(accountId) which atomically bumps an
//       account-version counter; subsequent get() reads detect
//       version mismatch and treat cache as missed (stale entry
//       TTLs out cheaply).
//     - expiresAt re-checked on EVERY cache read (not just write)
//       so a key cached just before expiry doesn't leak past
//       clock-bound deadline.
//     - Graceful degradation: any Redis error logged + treated as
//       no-op. Auth still works (slower); service stays up.
//
//   AuthCache (4-method interface): get + set + invalidateKey +
//     invalidateAccount.
//
//   sha256Hex(plaintext) — exported helper; the canonical cache-
//     key derivation.
//
//   2 store impls — RedisAuthCache + InMemoryAuthCache.
//
//   SerializedAccount V-NNN forward-compat optional fields:
//     - timezone (V-352).
//     - avatarR2Key (V-352b).
//     - slug (V-298a).
//     - region (V-298b).
//     Pre-VNNN cache entries lack these; deserialize defaults to
//     null without forcing cache flush on version upgrade.
//
//   SerializedTeamMembership V-326 — older pre-V-326 entries lack
//     teams field; deserialize treats absence as empty array (safe
//     default — no implicit team grants).
//
// stays in lockstep across apps/server/src/services/auth-cache.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/services/auth-cache.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W924 D-020 auth-cache cross-source invariant', () => {
  // ─── D-020 anchor + performance rationale ────────────────────

  it("CRITICAL apps/server/src/services/auth-cache.ts header pins 'Security model (D-020)'. The D-020 anchor is the policy-provenance for the cache design.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-cache.ts'));
    expect(p).toMatch(/Security model \(D-020\):/);
  });

  it("CRITICAL performance framing — 'amortises scrypt verification cost across the 30-second TTL window. Without this, every authenticated request re-runs scrypt (logN=15, ~50–100 ms on dev hardware), which dominated the API's p50/p99 latency under load (V-010 finding 2)'. The V-010 finding-2 anchor is the load-test motivation.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-cache.ts'));
    expect(p).toMatch(/amortises scrypt verification cost across the 30-second/);
    expect(p).toMatch(/TTL window\. Without this, every authenticated request re-runs scrypt/);
    expect(p).toMatch(
      /\(logN=15, ~50–100 ms on dev hardware\), which dominated the API's p50\/p99/,
    );
    expect(p).toMatch(/latency under load \(V-010 finding 2\)/);
  });

  // ─── sha256(plaintext) key + non-reversible framing ──────────

  it("CRITICAL cache-key framing — 'The cache key is sha256(plaintext) — a deterministic but non-reversible mapping. Storing raw plaintext in cache would weaken the security posture if Redis were compromised; storing only the hash means a Redis dump alone doesn't yield usable plaintext keys'. The Redis-dump threat model is the D-020 motivation.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-cache.ts'));
    expect(p).toMatch(/The cache key is `sha256\(plaintext\)` — a deterministic but/);
    expect(p).toMatch(/non-reversible mapping\. Storing raw plaintext in cache would weaken/);
    expect(p).toMatch(/the security posture if Redis were compromised; storing only the/);
    expect(p).toMatch(/hash means a Redis dump alone doesn't yield usable plaintext keys/);
  });

  it('CRITICAL sha256Hex runtime — sha256Hex(plaintext) returns 64-char hex digest. Mechanically verified.', () => {
    const out = sha256Hex('ds_test_abc');
    const expected = createHash('sha256').update('ds_test_abc').digest('hex');
    expect(out).toBe(expected);
    expect(out).toHaveLength(64);
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it('CRITICAL sha256Hex produces distinct hashes for distinct inputs + deterministic for same input. The deterministic + non-reversible properties are what make it a safe cache key.', () => {
    expect(sha256Hex('a')).toBe(sha256Hex('a'));
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
  });

  // ─── At-rest hash strength preserved ─────────────────────────

  it("CRITICAL D-020 framing — 'At-rest hash strength is preserved: scrypt logN=15 stays in lib/api-keys.ts. The cache is a performance optimisation only'. The cache-is-perf-only invariant is what prevents drift to weaker at-rest hashes.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-cache.ts'));
    expect(p).toMatch(/At-rest hash strength is preserved: scrypt logN=15 stays in/);
    expect(p).toMatch(/`lib\/api-keys\.ts`\. The cache is a performance optimisation only/);
  });

  // ─── 30s TTL + revocation documented worst-case ──────────────

  it("V-886 CRITICAL 30s TTL framing — the TTL bounds an entry's lifetime and is NOT a revocation budget. This arm used to pin the opposite: that customers are documented a 30s worst-case revocation window. No customer page states one, and since V-247 a revocation INCRs the per-key version counter which get() compares on every read, so a revoked key stops authenticating on the next request. The old text understated the guarantee AND asserted a customer commitment that does not exist.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-cache.ts'));
    expect(p, 'the customer-documentation claim is gone').not.toMatch(
      /Customers are documented that key revocation takes effect/,
    );
    expect(p, 'and the worst-case window with it').not.toMatch(/within 30s in the worst case/);
    expect(p, 'the TTL is framed as an entry lifetime').toMatch(
      /it is not a\s*\n?\s*\/\/\s*revocation budget/,
    );
    expect(p, 'and the failure mode is named as closed, not stale').toMatch(
      /degrades to the authoritative scrypt path/,
    );
  });

  // ─── invalidateKey immediate + reverse-index ─────────────────

  it("CRITICAL invalidateKey framing — 'Revocation triggers invalidateKey(keyId) immediately; the cached entry is deleted via reverse-index lookup'. The reverse-index lookup is what makes keyId → cache-key invalidation O(1) without a full scan.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-cache.ts'));
    expect(p).toMatch(/Revocation triggers `invalidateKey\(keyId\)` immediately; the cached/);
    expect(p).toMatch(/entry is deleted via reverse-index lookup/);
  });

  // ─── invalidateAccount account-version counter ───────────────

  it("CRITICAL invalidateAccount framing — 'Account tier / status changes trigger invalidateAccount(accountId) which atomically increments an account-version counter; subsequent get() reads detect the version mismatch and treat the cache as missed (the stale entry then TTLs out cheaply)'. The version-bump is what makes account-wide invalidation O(1) without enumerating all per-key cache entries.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-cache.ts'));
    expect(p).toMatch(/Account tier \/ status changes trigger `invalidateAccount\(accountId\)`/);
    expect(p).toMatch(/which atomically increments an account-version counter; subsequent/);
    expect(p).toMatch(/`get\(\)` reads detect the version mismatch and treat the cache as/);
    expect(p).toMatch(/missed \(the stale entry then TTLs out cheaply\)/);
  });

  // ─── expiresAt re-check on every read ────────────────────────

  it("CRITICAL expiresAt framing — 'expiresAt is re-checked on every cache read (not just on cache write) so a key cached just before its expiry doesn't leak past the clock-bound deadline'. The re-check-on-read prevents 30s-TTL from extending a key's effective expiry past its real expiresAt.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-cache.ts'));
    expect(p).toMatch(/`expiresAt` is re-checked on every cache read \(not just on cache/);
    expect(p).toMatch(/write\) so a key cached just before its expiry doesn't leak past the/);
    expect(p).toMatch(/clock-bound deadline/);
  });

  // ─── Graceful degradation on Redis error ─────────────────────

  it("CRITICAL graceful-degradation framing — 'Graceful degradation: any Redis error during get/set/invalidate is logged and treated as a no-op. Auth still works (slower), service stays up'. The Redis-down-still-works contract is what keeps API uptime independent of Redis.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-cache.ts'));
    expect(p).toMatch(/Graceful degradation: any Redis error during get\/set\/invalidate is/);
    expect(p).toMatch(/logged and treated as a no-op\. Auth still works \(slower\), service/);
    expect(p).toMatch(/stays up/);
  });

  // ─── AuthCache authority-generation interface ───────────────

  it('CRITICAL AuthCache interface includes optional account+key generation capture for race-safe credential writes.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-cache.ts'));
    expect(p).toMatch(/export interface AuthCache \{/);
    expect(p).toMatch(/get\(plaintextSha256: string\): Promise<AccountContext \| null>;/);
    expect(p).toMatch(
      /captureVersions\?\(accountId: string, keyId: string\): Promise<AuthCacheVersions \| null>;/,
    );
    expect(p).toMatch(/set\(/);
    expect(p).toMatch(/invalidateKey\(keyId: string\): Promise<void>;/);
    expect(p).toMatch(/invalidateAccount\(accountId: string\): Promise<void>;/);
  });

  it('CRITICAL set() optionally accepts both generations captured before authoritative recheck.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-cache.ts'));
    expect(p).toMatch(
      /set\(\s*\n\s*plaintextSha256: string,\s*\n\s*keyId: string,\s*\n\s*accountId: string,\s*\n\s*context: AccountContext,\s*\n\s*ttlSec: number,\s*\n\s*capturedVersions\?: AuthCacheVersions,\s*\n\s*\): Promise<void>;/,
    );
  });

  // ─── 2 store impls (Redis + Memory) ──────────────────────────

  it('CRITICAL 2 impls — RedisAuthCache + InMemoryAuthCache. The dual-impl mirrors the rate-limit + mfa-challenge V-353d pattern.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-cache.ts'));
    expect(p).toMatch(/export class RedisAuthCache implements AuthCache \{/);
    expect(p).toMatch(/export class InMemoryAuthCache implements AuthCache \{/);
  });

  // ─── SerializedAccount V-NNN forward-compat fields ───────────

  it("CRITICAL SerializedAccount V-NNN forward-compat optional fields — timezone (V-352), avatarR2Key (V-352b), slug (V-298a), region (V-298b). Each marked 'Pre-VNNN cache entries lack this; deserialize defaults to null'. The forward-compat-optional design avoids forced cache flushes on V-NNN feature rollouts.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-cache.ts'));
    expect(p).toMatch(
      /V-352 — optional\. Pre-V-352 cache entries lack this; deserialize defaults to null/,
    );
    expect(p).toMatch(
      /V-352b — optional\. Pre-V-352b cache entries lack this; deserialize defaults to null/,
    );
    expect(p).toMatch(
      /V-298a — optional\. Pre-V-298a cache entries lack this; deserialize defaults to null/,
    );
    expect(p).toMatch(
      /V-298b — optional\. Pre-V-298b cache entries lack this; deserialize defaults to null/,
    );
    expect(p).toMatch(/timezone\?: string \| null;/);
    expect(p).toMatch(/avatarR2Key\?: string \| null;/);
    expect(p).toMatch(/slug\?: string \| null;/);
    expect(p).toMatch(/region\?: 'us' \| 'eu' \| 'apac' \| null;/);
  });

  // ─── V-326 team membership safe-default ──────────────────────

  it("CRITICAL V-326 team-membership safe-default framing — 'V-326 — team membership entries serialized as plain JSON. Older pre-V-326 cache entries lack this field; deserialize() treats absence as an empty array (safe default — no implicit team grants)'. The empty-array-on-absent is the V-326 forward-compat policy.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-cache.ts'));
    expect(p).toMatch(/V-326 — team membership entries serialized as plain JSON\. Older/);
    expect(p).toMatch(/pre-V-326 cache entries lack this field; deserialize\(\) treats/);
    expect(p).toMatch(/absence as an empty array \(safe default — no implicit team grants\)/);
  });

  it('CRITICAL SerializedTeamMembership has 5 fields, and this arm pins 3 of them — membershipId + ownerAccountId + role (member|admin). The 3-field shape mirrors AccountContext.teams element shape.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth-cache.ts'));
    expect(p).toMatch(/interface SerializedTeamMembership \{/);
    expect(p).toMatch(/membershipId: string;/);
    expect(p).toMatch(/ownerAccountId: string;/);
    expect(p).toMatch(/role: 'member' \| 'admin';/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/auth-cache-d020-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
