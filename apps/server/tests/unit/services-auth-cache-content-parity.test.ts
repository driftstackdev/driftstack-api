// W403.C — drift guard for apps/server/src/services/auth-cache.ts.
// D-020 auth cache — amortises scrypt verification cost across 30s
// TTL. Drift here either weakens the security model (cached
// plaintext, no version gate) or breaks the V-247 / V-246-P0-001
// revocation race resolution (cached-revoke window).
//
//   • D-020 framing pinned: V-010 scrypt logN=15 cost amortised;
//     cache key = sha256(plaintext) — non-reversible mapping;
//     30s TTL; key revocation takes effect within 30s worst case
//     (most invalidations immediate via explicit paths).
//   • V-247 / V-246-P0-001 framing: per-key version counter INCR'd
//     by invalidateKey; checked by get(); pre-V-247 entries treat
//     absent as 0; 30s TTL drains old entries.
//   • expires_at re-checked on every cache read (not just write) —
//     no clock-bound leak past deadline.
//   • Graceful degradation: any Redis error → warn-log + treat as
//     no-op (auth still works, slower, service stays up).
//   • Account version counter: invalidateAccount INCR atomic; stale
//     entries TTL out cheaply.
//   • SerializedAccount: 11 fields with V-352 timezone? + V-352b
//     avatarR2Key? + V-298a slug? + V-298b region? all optional
//     (pre-version defaults to null).
//   • SerializedTeamMembership: V-326 — pre-V-326 entries treat
//     teams absence as empty array (no implicit grants).
//   • SerializedContext: optional webSession (V-353e) — pre-V-353e
//     defaults to null → step-up gate refuses; 30s TTL covers
//     rollout window.
//   • Redis key shapes: auth:apikey:<sha> entry / auth:keyid:
//     <keyId> reverse / auth:account:<id>:v version / auth:keyid:
//     <id>:v key-version (V-247).
//   • InMemoryAuthCache: 4-map test seam (entries / reverse /
//     accountVersions / keyVersions) + size() test helper.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/auth-cache.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W403.C apps/server/src/services/auth-cache.ts content parity', () => {
  const body = read(LIB);

  it('D-020 framing pinned: scrypt logN=15 V-010 cost amortisation + 30s TTL + cache key = sha256(plaintext)', () => {
    expect(body).toMatch(
      /Auth cache — amortises scrypt verification cost across the 30-second\s*\/\/\s*TTL window\. Without this, every authenticated request re-runs scrypt\s*\/\/\s*\(logN=15, ~50–100 ms on dev hardware\), which dominated the API's p50\/p99\s*\/\/\s*latency under load \(V-010 finding 2\)\./,
    );
    expect(body).toMatch(/Security model \(D-020\):/);
    expect(body).toMatch(
      /At-rest hash strength is preserved: scrypt logN=15 stays in\s*\/\/\s*`lib\/api-keys\.ts`\. The cache is a performance optimisation only\./,
    );
    expect(body).toMatch(
      /The cache key is `sha256\(plaintext\)` — a deterministic but\s*\/\/\s*non-reversible mapping\./,
    );
    // V-886 — this froze "Customers are documented that key revocation takes
    // effect within 30s in the worst case". No customer page states any such
    // window (the audit's P2-002 records that gap), and the V-247 key-version
    // gate makes revocation take effect on the next read rather than at TTL.
    // One negative per half of the removed claim.
    expect(body, 'the customer-documentation claim is gone').not.toMatch(
      /Customers are documented that key revocation takes effect/,
    );
    expect(body, 'and the 30s worst-case framing with it').not.toMatch(
      /within 30s in the worst case/,
    );
    expect(body, 'the TTL is described as an entry lifetime, not a revocation budget').toMatch(
      /TTL is 30s\. That bounds how long an entry LIVES; it is not a/,
    );
    expect(body, 'and the version gate is named as what actually revokes').toMatch(
      /`get\(\)` compares it on EVERY\s*\/\/\s*read/,
    );
  });

  it('expires_at re-check + graceful-degradation framing pinned: any Redis error → warn-log + no-op', () => {
    expect(body).toMatch(
      /`expiresAt` is re-checked on every cache read \(not just on cache\s*\/\/\s*write\) so a key cached just before its expiry doesn't leak past the\s*\/\/\s*clock-bound deadline\./,
    );
    expect(body).toMatch(
      /Graceful degradation: any Redis error during get\/set\/invalidate is\s*\/\/\s*logged and treated as a no-op\. Auth still works \(slower\), service\s*\/\/\s*stays up\./,
    );
  });

  it('AuthCache: cache read/write, optional generation capture, and key/account invalidation', () => {
    expect(body).toMatch(/export interface AuthCache \{/);
    expect(body).toMatch(
      /\/\*\* Returns a cached context for this plaintext sha if one is fresh, else null\. \*\/\s*get\(plaintextSha256: string\): Promise<AccountContext \| null>;/,
    );
    expect(body).toMatch(
      /captureVersions\?\(accountId: string, keyId: string\): Promise<AuthCacheVersions \| null>;/,
    );
    expect(body).toMatch(
      /\/\*\* Cache the context; reverse-indexes by keyId for invalidation\. \*\/\s*set\(\s*plaintextSha256: string,\s*keyId: string,\s*accountId: string,\s*context: AccountContext,\s*ttlSec: number,\s*capturedVersions\?: AuthCacheVersions,\s*\): Promise<void>;/,
    );
    expect(body).toMatch(
      /\/\*\* Invalidate the cached entry for one specific API key \(used by revocation\)\. \*\/\s*invalidateKey\(keyId: string\): Promise<void>;/,
    );
    expect(body).toMatch(
      /\/\*\* Bump the account-version counter so all cached entries for the account miss on next read\. \*\/\s*invalidateAccount\(accountId: string\): Promise<void>;/,
    );
  });

  it("sha256Hex exported helper: createHash('sha256').update(plaintext).digest('hex')", () => {
    expect(body).toMatch(
      /export function sha256Hex\(plaintext: string\): string \{\s*return createHash\('sha256'\)\.update\(plaintext\)\.digest\('hex'\);\s*\}/,
    );
  });

  it('SerializedAccount: pre-V-352 timezone? + pre-V-352b avatarR2Key? + pre-V-298a slug? + pre-V-298b region? all optional (defaults to null)', () => {
    expect(body).toMatch(/interface SerializedAccount \{/);
    expect(body).toMatch(
      /\/\*\* V-352 — optional\. Pre-V-352 cache entries lack this; deserialize defaults to null\. \*\/\s*timezone\?: string \| null;/,
    );
    expect(body).toMatch(
      /\/\*\* V-352b — optional\. Pre-V-352b cache entries lack this; deserialize defaults to null\. \*\/\s*avatarR2Key\?: string \| null;/,
    );
    expect(body).toMatch(
      /\/\*\* V-298a — optional\. Pre-V-298a cache entries lack this; deserialize defaults to null\. \*\/\s*slug\?: string \| null;/,
    );
    expect(body).toMatch(
      /\/\*\* V-298b — optional\. Pre-V-298b cache entries lack this; deserialize defaults to null\. \*\/\s*region\?: 'us' \| 'eu' \| 'apac' \| null;/,
    );
  });

  it('V-326 SerializedTeamMembership: pre-V-326 absence treated as empty array (no implicit team grants)', () => {
    expect(body).toMatch(
      /\/\/ V-326 — team membership entries serialized as plain JSON\. Older\s*\/\/ pre-V-326 cache entries lack this field; deserialize\(\) treats\s*\/\/ absence as an empty array \(safe default — no implicit team grants\)\./,
    );
    expect(body).toMatch(/interface SerializedTeamMembership \{/);
    expect(body).toMatch(/membershipId: string;/);
    expect(body).toMatch(/ownerAccountId: string;/);
    expect(body).toMatch(/role: 'member' \| 'admin';/);
  });

  it('security-sensitive provenance + webSession are explicit and version-gated', () => {
    expect(body).toMatch(/provenance: string \| null;/);
    expect(body).toMatch(
      /\/\*\* V-353e — populated when the request authed via web session\. Explicit\s*\*\s*null means API-key auth\. Missing is ambiguous and makes the versioned\s*\*\s*cache envelope invalid rather than silently bypassing MFA step-up\. \*\/\s*webSession: \{ id: string; mfaSatisfiedAt: string \| null \} \| null;/,
    );
    expect(body).toMatch(/const AUTH_CACHE_SCHEMA_VERSION = 1;/);
    expect(body).toMatch(/schemaVersion: typeof AUTH_CACHE_SCHEMA_VERSION;/);
    expect(body).toMatch(/provenance: ctx\.apiKey\.provenance \?\? null,/);
  });

  it('V-247 CachedEntry.keyVersion framing pinned (revocation race resolution + 30s TTL drain)', () => {
    expect(body).toMatch(
      /V-247 \/ V-246-P0-001 — per-key version counter\. Bumped on\s*\*\s*revocation so an in-flight slow-path `set\(\)` that captured the\s*\*\s*pre-revoke version produces an entry that the next `get\(\)`\s*\*\s*detects as stale \(currentKeyVersion !== entry\.keyVersion\)\. Closes\s*\*\s*the API-key revocation cache window\./,
    );
  });

  it('Redis key shapes: auth:apikey:<sha> / auth:keyid:<keyId> / auth:account:<id>:v / auth:keyid:<id>:v (V-247 key-version)', () => {
    expect(body).toMatch(/const KEY_ENTRY = \(sha: string\): string => `auth:apikey:\$\{sha\}`;/);
    expect(body).toMatch(
      /const KEY_REVERSE = \(keyId: string\): string => `auth:keyid:\$\{keyId\}`;/,
    );
    expect(body).toMatch(
      /const KEY_ACCOUNT_VERSION = \(accountId: string\): string => `auth:account:\$\{accountId\}:v`;/,
    );
    expect(body).toMatch(
      /const KEY_KEY_VERSION = \(keyId: string\): string => `auth:keyid:\$\{keyId\}:v`;/,
    );
  });

  it('RedisAuthCache.get: entry + security schema + accountVersion + keyVersion gates; err → warn + null', () => {
    expect(body).toMatch(
      /const raw = await this\.redis\.get\(KEY_ENTRY\(plaintextSha256\)\);\s*if \(!raw\) return null;/,
    );
    expect(body).toMatch(
      /const parsed: unknown = JSON\.parse\(raw\);[\s\S]*?if \(!isCurrentCachedEntry\(parsed\)\) return null;/,
    );
    expect(body).toMatch(/if \(!Object\.hasOwn\(context, 'webSession'\)\) return false;/);
    expect(body).toMatch(
      /const currentAccountVersion = accountVersionRaw \? Number\(accountVersionRaw\) : 0;\s*if \(currentAccountVersion !== entry\.accountVersion\) return null;/,
    );
    expect(body).toMatch(
      /const currentKeyVersion = keyVersionRaw \? Number\(keyVersionRaw\) : 0;\s*if \(currentKeyVersion !== entry\.keyVersion\) return null;/,
    );
    expect(body).toMatch(
      /this\.logger\.warn\(\{ err: errSummary\(err\) \}, 'auth cache get failed; degrading to scrypt path'\);/,
    );
  });

  it('RedisAuthCache.set: preserves caller-captured account and key generations', () => {
    expect(body).toMatch(
      /\/\/ V-591 — authentication supplies both generations captured before its\s*\/\/ authoritative DB recheck\./,
    );
    expect(body).toMatch(/const \[accountVersionRaw, keyVersionRaw\] = capturedVersions/);
    expect(body).toMatch(/capturedVersions\?\.accountVersion/);
    expect(body).toMatch(/capturedVersions\?\.keyVersion/);
    expect(body).toMatch(
      /this\.redis\.set\(KEY_ENTRY\(plaintextSha256\), JSON\.stringify\(entry\), 'PX', ttlMs\),\s*\/\/ Reverse-index so revocation can find the cache entry by keyId\.\s*this\.redis\.set\(KEY_REVERSE\(keyId\), plaintextSha256, 'PX', ttlMs\),/,
    );
  });

  it('invalidateKey: V-247 INCR-key-version FIRST (race resolution); then del REVERSE + ENTRY for fast-path eviction', () => {
    expect(body).toMatch(
      /\/\/ V-247 — INCR the key-version counter FIRST \(atomic in Redis\); any\s*\/\/ in-flight `set\(\)` that captured the pre-INCR value will land an\s*\/\/ entry the next `get\(\)` detects as stale\./,
    );
    expect(body).toMatch(
      /const ops: Array<Promise<unknown>> = \[\s*this\.redis\.incr\(KEY_KEY_VERSION\(keyId\)\),\s*this\.redis\.del\(KEY_REVERSE\(keyId\)\),\s*\];/,
    );
    expect(body).toMatch(/if \(sha\) ops\.push\(this\.redis\.del\(KEY_ENTRY\(sha\)\)\);/);
  });

  it('invalidateAccount: redis.incr KEY_ACCOUNT_VERSION; err → warn-only no-op', () => {
    expect(body).toMatch(
      /async invalidateAccount\(accountId: string\): Promise<void> \{\s*try \{\s*await this\.redis\.incr\(KEY_ACCOUNT_VERSION\(accountId\)\);\s*\} catch \(err\) \{\s*this\.logger\.warn\(\{ err: errSummary\(err\) \}, 'auth cache invalidateAccount failed'\);/,
    );
  });

  it('deserialize: display-only legacy fields keep safe defaults; security fields are direct', () => {
    expect(body).toMatch(
      /\/\/ Older serialised entries \(pre-OT7\) may not carry the rateLimitOverrides\s*\/\/ field — treat absence as empty rather than throwing\.\s*if \(s\.rateLimitOverrides\) \{/,
    );
    expect(body).toMatch(/timezone: s\.account\.timezone \?\? null,/);
    expect(body).toMatch(/avatarR2Key: s\.account\.avatarR2Key \?\? null,/);
    expect(body).toMatch(/slug: s\.account\.slug \?\? null,/);
    expect(body).toMatch(/region: s\.account\.region \?\? null,/);
    expect(body).toMatch(/teams: \(s\.teams \?\? \[\]\)\.map\(\(t\) => \(\{/);
    expect(body).toMatch(/provenance: s\.apiKey\.provenance,/);
    expect(body).toMatch(/webSession: s\.webSession\s*\?\s*\{/);
  });

  it('InMemoryAuthCache: 4-map seam + V-247 invalidateKey INCR-first + size() test helper', () => {
    expect(body).toMatch(/export class InMemoryAuthCache implements AuthCache \{/);
    expect(body).toMatch(/private readonly entries = new Map<string, MemEntry>\(\);/);
    expect(body).toMatch(/private readonly reverse = new Map<string, string>\(\);/);
    expect(body).toMatch(/private readonly accountVersions = new Map<string, number>\(\);/);
    expect(body).toMatch(
      /\/\/ V-247 — mirror Redis key-version counter\.\s*private readonly keyVersions = new Map<string, number>\(\);/,
    );
    expect(body).toMatch(
      /\/\/ V-247 — INCR key-version FIRST so any in-flight set\(\) that\s*\/\/ captured the pre-INCR value lands a stale entry\. Then drop\s*\/\/ the existing entry for fast-path eviction\./,
    );
    expect(body).toMatch(
      /\/\*\* Test helper: report the entry count\. \*\/\s*size\(\): number \{\s*return this\.entries\.size;\s*\}/,
    );
  });

  it('errSummary: Error → {name, message, stack, cause}; non-Error → {message: String(err)}', () => {
    expect(body).toMatch(
      /function errSummary\(err: unknown\): \{\s*name\?: string;\s*message\?: string;\s*stack\?: string;\s*cause\?: unknown;\s*\} \{\s*if \(err instanceof Error\) \{\s*return \{ name: err\.name, message: err\.message, stack: err\.stack, cause: err\.cause \};\s*\}\s*return \{ message: String\(err\) \};\s*\}/,
    );
  });

  it('imports: Redis + createHash + Logger + AccountContext types', () => {
    expect(body).toMatch(/import type \{ Redis \} from 'ioredis';/);
    expect(body).toMatch(/import \{ createHash \} from 'node:crypto';/);
    expect(body).toMatch(/import type \{ Logger \} from '\.\.\/lib\/logger\.js';/);
    expect(body).toMatch(/import type \{ AccountContext \} from '\.\/auth\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
