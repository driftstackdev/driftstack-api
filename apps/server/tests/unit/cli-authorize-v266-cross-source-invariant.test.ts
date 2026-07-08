// W934 — V-266 cli-authorize browser-OAuth-style flow cross-source
// invariant. Two-hundred-sixtieth in the drift-guard series. Pins
// the CLI / GUI activation flow:
//
//   V-266 anchor — 'Browser-OAuth-style activation flow for the CLI
//   / GUI client'.
//
//   State storage: pure Redis with 5-minute TTL on every code. Keys
//   follow 'cli-auth:code:{codeId}'. JSON-serialised value carries
//   state + status + (post-bind) API key plaintext + accountId.
//
//   REDIS_KEY_PREFIX = 'cli-auth:code:'.
//   TTL_SECONDS = 5 * 60 (300 seconds).
//
//   One-shot semantics — 'exchange deletes the key on successful
//   retrieval, so a second call returns expired. A code that's still
//   pending after TTL expiry naturally returns expired because Redis
//   evicted it'.
//
//   Public-facing browser URL: built from configured dashboardOrigin
//   (e.g. https://app.driftstack.dev) so dev / staging / production
//   wire correctly.
//
//   dashboardPath default = '/cli/authorize' →
//     ${dashboardOrigin}/cli/authorize?code=…&state=….
//
//   CliCodeStatus 2-value union: 'pending' | 'bound'.
//
//   ExchangeResult 3-state discriminated union:
//     { status: 'pending' } | { status: 'bound'; api_key; account_id }
//       | { status: 'expired' }.
//
//   CliAuthorizeError 5-code union — 'invalid_code' | 'state_mismatch'
//     | 'already_bound' | 'not_found' | 'expired'.
//
//   StoredCode (7-field shape): state + status + client_label
//     (nullable) + secret_blob (nullable, bound-only, encrypted at rest
//     per D1) + encrypted flag + account_id (nullable, bound-only) +
//     created_at.
//
//   2 store impls — RedisStore + InMemoryCliAuthorizeStore.
//
//   CliAuthorizeStore 4-method interface: get + setEx + del + getDel
//     (atomic one-shot claim, C2).
//
// stays in lockstep across apps/server/src/services/cli-authorize.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryCliAuthorizeStore } from '../../src/services/cli-authorize.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W934 V-266 cli-authorize cross-source invariant', () => {
  // ─── V-266 anchor + browser-OAuth framing ────────────────────

  it("CRITICAL apps/server/src/services/cli-authorize.ts header pins V-266 anchor — 'V-266 — Browser-OAuth-style activation flow for the CLI / GUI client'. The V-266 anchor is the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cli-authorize.ts'));
    expect(p).toMatch(/V-266 — Browser-OAuth-style activation flow for the CLI \/ GUI client/);
  });

  // ─── Redis storage + 5-min TTL + key prefix ──────────────────

  it("CRITICAL storage framing — 'State storage: pure Redis with a 5-minute TTL on every code. Keys follow cli-auth:code:{codeId}. JSON-serialised value carries the state, status, and (post-bind) the API key plaintext + accountId the GUI will pull on its next poll'. The Redis-only + 5-min TTL is the V-266 storage contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cli-authorize.ts'));
    expect(p).toMatch(/State storage: pure Redis with a 5-minute TTL on every code\. Keys/);
    expect(p).toMatch(/follow `cli-auth:code:\{codeId\}`\. JSON-serialised value carries the/);
    expect(p).toMatch(/state, status, and \(post-bind\) the API key plaintext \+ accountId/);
    expect(p).toMatch(/the GUI will pull on its next poll/);
  });

  it("CRITICAL REDIS_KEY_PREFIX = 'cli-auth:code:' + TTL_SECONDS = 5 * 60. The 2 constants are the Redis-keyspace fingerprint.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cli-authorize.ts'));
    expect(p).toMatch(/const REDIS_KEY_PREFIX = 'cli-auth:code:';/);
    expect(p).toMatch(/const TTL_SECONDS = 5 \* 60;/);
  });

  // ─── One-shot exchange framing ───────────────────────────────

  it("CRITICAL one-shot framing — 'exchange deletes the key on successful retrieval, so a second call returns expired. A code that's still pending after TTL expiry naturally returns expired because Redis evicted it'. The delete-on-retrieve + TTL-expiry-equals-expired contract is what bounds replay-attack window.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cli-authorize.ts'));
    expect(p).toMatch(/One-shot semantics: `exchange` deletes the key on successful/);
    expect(p).toMatch(/retrieval, so a second call returns `expired`\. A code that's still/);
    expect(p).toMatch(/`pending` after TTL expiry naturally returns `expired` because/);
    expect(p).toMatch(/Redis evicted it\./);
  });

  // ─── dashboardOrigin URL framing ─────────────────────────────

  it("CRITICAL dashboardOrigin framing — 'Public-facing browser URL: built from the configured dashboardOrigin (e.g. https://app.driftstack.dev) so dev / staging / production all wire correctly'. The DASHBOARD_ORIGIN-driven URL keeps the CLI flow environment-agnostic.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cli-authorize.ts'));
    expect(p).toMatch(/Public-facing browser URL: built from the configured/);
    expect(p).toMatch(/`dashboardOrigin` \(e\.g\. `https:\/\/app\.driftstack\.dev`\) so dev \//);
    expect(p).toMatch(/staging \/ production all wire correctly/);
  });

  it("CRITICAL dashboardPath default = '/cli/authorize' → ${dashboardOrigin}/cli/authorize?code=…&state=…. The 2-param query (code + state) is the OAuth-style CSRF defence.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cli-authorize.ts'));
    expect(p).toMatch(/defaults to `\/cli\/authorize` so the URL becomes/);
    expect(p).toMatch(/`\$\{dashboardOrigin\}\/cli\/authorize\?code=…&state=…`/);
  });

  // ─── CliCodeStatus 2-value union ─────────────────────────────

  it("CRITICAL CliCodeStatus = 'pending' | 'bound'. The 2-value union is the state-machine vocabulary; drift to 3+ states would require updating ExchangeResult.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cli-authorize.ts'));
    expect(p).toMatch(/export type CliCodeStatus = 'pending' \| 'bound';/);
  });

  // ─── ExchangeResult 3-state discriminated union ──────────────

  it("CRITICAL ExchangeResult is 3-state discriminated union — { status: 'pending' } | { status: 'bound'; api_key; account_id } | { status: 'expired' }. The 3-state union covers all polling outcomes; bound carries the 2-field payload the CLI consumes.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cli-authorize.ts'));
    expect(p).toMatch(/export type ExchangeResult =/);
    expect(p).toMatch(/\| \{ status: 'pending' \}/);
    expect(p).toMatch(/\| \{ status: 'bound'; api_key: string; account_id: string \}/);
    expect(p).toMatch(/\| \{ status: 'expired' \};/);
  });

  // ─── CliAuthorizeError 5-code union ──────────────────────────

  it("CRITICAL CliAuthorizeError 5 codes — 'invalid_code' | 'state_mismatch' | 'already_bound' | 'not_found' | 'expired'. The 5-code taxonomy distinguishes user-error (invalid_code/state_mismatch) from race outcomes (already_bound/expired/not_found).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cli-authorize.ts'));
    expect(p).toMatch(/export class CliAuthorizeError extends Error \{/);
    expect(p).toMatch(/\| 'invalid_code'/);
    expect(p).toMatch(/\| 'state_mismatch'/);
    expect(p).toMatch(/\| 'already_bound'/);
    expect(p).toMatch(/\| 'not_found'/);
    expect(p).toMatch(/\| 'expired',/);
  });

  // ─── StoredCode 6-field shape ────────────────────────────────

  it("CRITICAL StoredCode has 7 fields — state + status + client_label (nullable) + secret_blob (nullable, bound-only, encrypted at rest per D1) + encrypted flag + account_id (nullable, bound-only) + created_at. The JSON shape is what's serialised to Redis.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cli-authorize.ts'));
    expect(p).toMatch(/interface StoredCode \{/);
    expect(p).toMatch(/state: string;/);
    expect(p).toMatch(/status: CliCodeStatus;/);
    expect(p).toMatch(/client_label: string \| null;/);
    expect(p).toMatch(/secret_blob: string \| null;/);
    expect(p).toMatch(/encrypted: boolean;/);
    expect(p).toMatch(/account_id: string \| null;/);
    expect(p).toMatch(/created_at: number;/);
  });

  // ─── CliAuthorizeStore 4-method interface ────────────────────

  it('CRITICAL CliAuthorizeStore has 4 methods — get + setEx + del + getDel (atomic one-shot claim, C2). The KV-store contract; tests pass InMemoryCliAuthorizeStore.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cli-authorize.ts'));
    expect(p).toMatch(/export interface CliAuthorizeStore \{/);
    expect(p).toMatch(/get\(key: string\): Promise<string \| null>;/);
    expect(p).toMatch(/setEx\(key: string, value: string, ttlSeconds: number\): Promise<void>;/);
    expect(p).toMatch(/del\(key: string\): Promise<void>;/);
    expect(p).toMatch(/getDel\(key: string\): Promise<string \| null>;/);
  });

  // ─── 2 store impls ───────────────────────────────────────────

  it('CRITICAL 2 impls — RedisStore + InMemoryCliAuthorizeStore. The dual-impl pattern mirrors auth-cache / rate-limit / mfa-challenge / cli-authorize V-353d Redis/Memory parity.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cli-authorize.ts'));
    expect(p).toMatch(/class RedisStore implements CliAuthorizeStore \{/);
    expect(p).toMatch(/export class InMemoryCliAuthorizeStore implements CliAuthorizeStore \{/);
  });

  // ─── InMemory store runtime parity ───────────────────────────

  it('CRITICAL InMemoryCliAuthorizeStore get returns null for missing entry. The default-null contract mirrors Redis GET null-on-miss.', async () => {
    const store = new InMemoryCliAuthorizeStore();
    expect(await store.get('k')).toBeNull();
  });

  it('CRITICAL InMemoryCliAuthorizeStore setEx + get round-trip. Mirrors Redis SET … EX semantics.', async () => {
    const store = new InMemoryCliAuthorizeStore();
    await store.setEx('k', 'v', 60);
    expect(await store.get('k')).toBe('v');
  });

  it('CRITICAL InMemoryCliAuthorizeStore del removes entry. After del, subsequent get returns null.', async () => {
    const store = new InMemoryCliAuthorizeStore();
    await store.setEx('k', 'v', 60);
    expect(await store.get('k')).toBe('v');
    await store.del('k');
    expect(await store.get('k')).toBeNull();
  });

  it('CRITICAL InMemoryCliAuthorizeStore getDel returns the value once then null — the atomic one-shot claim (C2) that stops double-delivery of a bound key.', async () => {
    const store = new InMemoryCliAuthorizeStore();
    await store.setEx('k', 'v', 60);
    expect(await store.getDel('k')).toBe('v');
    // A second claim on the same key sees null (already removed).
    expect(await store.getDel('k')).toBeNull();
    expect(await store.get('k')).toBeNull();
  });

  it('CRITICAL InMemoryCliAuthorizeStore respects TTL — entry with 0s ttl is evicted on next get. Mirrors Redis EX expiry semantics.', async () => {
    const store = new InMemoryCliAuthorizeStore();
    await store.setEx('k', 'v', 0); // 0s ttl → expiresAt = now
    expect(await store.get('k')).toBeNull();
  });

  // ─── CliAuthorizeServiceOptions shape ────────────────────────

  it("CRITICAL CliAuthorizeServiceOptions framing — 'Either a Redis client (production) or an explicit store (tests)' + required dashboardOrigin + optional dashboardPath. The 2-option dependency-injection lets test bootstrap skip Redis without separate factories.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cli-authorize.ts'));
    expect(p).toMatch(/Either a Redis client \(production\) or an explicit store \(tests\)/);
    expect(p).toMatch(/redis\?: Redis;/);
    expect(p).toMatch(/store\?: CliAuthorizeStore;/);
    expect(p).toMatch(/dashboardOrigin: string;/);
    expect(p).toMatch(/dashboardPath\?: string;/);
  });

  // ─── BindInput 5-field shape ─────────────────────────────────

  it('CRITICAL BindInput has 5 fields — code + state + account_id + api_key_plaintext + scopes (readonly ApiKeyScope[]). The 5-field bind carries everything the GUI poll needs to retrieve.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cli-authorize.ts'));
    expect(p).toMatch(/export interface BindInput \{/);
    expect(p).toMatch(/code: string;/);
    expect(p).toMatch(/state: string;/);
    expect(p).toMatch(/account_id: string;/);
    expect(p).toMatch(/api_key_plaintext: string;/);
    expect(p).toMatch(/scopes: readonly ApiKeyScope\[\];/);
  });

  it("CRITICAL BindInput.scopes framing — 'Recorded for observability; the actual scopes live on the minted key'. The observability-only framing prevents the bind path from being treated as a scope-storage path.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cli-authorize.ts'));
    expect(p).toMatch(/Recorded for observability; the actual scopes live on the minted key/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/cli-authorize-v266-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
