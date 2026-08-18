// W950 — api-keys service V-174 + V-296 cross-source invariant.
// Two-hundred-seventy-sixth in the drift-guard series. Pins the
// customer-facing API key management service:
//
//   Surface framing — 'API key management service'. Operations:
//     - create: generates new key, hashes it, stores prefix+hash,
//       returns plaintext ONCE. After creation plaintext is
//       unrecoverable.
//     - list: returns all keys for account (no plaintext).
//     - revoke: marks key revoked (idempotent — revoking a revoked
//       key is no-op, but revoking non-existent is 404).
//
//   V-174 scope-split framing — 'V-174 — both create and revoke
//   require account_owner scope on the calling key. Pre-V-174 this
//   was admin; the new scope split carved admin into account_owner
//   (customer-account control) and driftstack_internal_admin
//   (Driftstack-staff-only). The admin scope retains compat-alias
//   semantics during migration via requireScope() — existing admin-
//   scoped keys keep working'.
//
//   LegalAcceptanceGate — 'Gate interface for blocking API key
//   issuance on pending legal acceptances. Production wiring
//   supplies a LegalService instance; tests can pass null to skip
//   the check (used by tests that don't exercise the legal track)'.
//
//   NewApiKeyInput (6 fields): accountId + name + scopes
//     (ApiKeyScope[]) + keyPrefix + keyHash + expiresAt (nullable).
//
//   ApiKeysRepo 6+-method interface: insertApiKey + listApiKeys
//     + findApiKey (account-scoped) + findApiKeyUnscoped (admin
//     force-actions only) + atomic scoped/unscoped revoke outcome +
//     setExpiresAt + atomic rotation + listAcrossAccounts (admin tool).
//
//   V-296 setExpiresAt framing — 'set expires_at on an existing
//   key. Used by rotate() to schedule the old key's automatic
//   revocation at the end of the grace period. Idempotent — last
//   write wins'.
//
//   findApiKeyUnscoped admin-only framing — 'WITHOUT account
//   scoping (admin force-actions only)'.
//
//   3 lib/api-keys primitive imports: generateApiKey + hashApiKey
//     + keyPrefixFromPlaintext.
//
//   Errors: BadRequestError + LegalAcceptanceRequiredError +
//     NotFoundError + requireScope as throwIfMissingScope.
//
// stays in lockstep across apps/server/src/services/api-keys.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W950 api-keys service V-174 + V-296 cross-source invariant', () => {
  // ─── Service intro + 3-operation framing ─────────────────────

  it("CRITICAL apps/server/src/services/api-keys.ts header pins surface — 'API key management service'. The intro header is the policy-anchor.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'));
    expect(p).toMatch(/API key management service/);
  });

  it("CRITICAL 3-operation framing — '- create: generates a new key, hashes it, stores prefix+hash, returns plaintext ONCE in the response. After creation the plaintext is unrecoverable. - list: returns all keys for the caller's account (no plaintext). - revoke: marks a key revoked (idempotent — revoking a revoked key is a no-op, but revoking a non-existent key is 404)'. The 3-op + show-once + idempotent-revoke semantics is the customer-facing API.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'));
    expect(p).toMatch(/- create: generates a new key, hashes it, stores prefix\+hash, returns/);
    expect(p).toMatch(/plaintext ONCE in the response\. After creation the plaintext is/);
    expect(p).toMatch(/unrecoverable\./);
    expect(p).toMatch(/- list: returns all keys for the caller's account \(no plaintext\)/);
    expect(p).toMatch(/- revoke: marks a key revoked \(idempotent — revoking a revoked key is/);
    expect(p).toMatch(/a no-op, but revoking a non-existent key is 404\)/);
  });

  // ─── V-174 scope-split framing ───────────────────────────────

  it("CRITICAL V-174 scope-split framing — 'V-174 — both create and revoke require account_owner scope on the calling key. Pre-V-174 this was admin; the new scope split carved admin into account_owner (customer-account control) and driftstack_internal_admin (Driftstack-staff-only). The admin scope retains compat-alias semantics during migration via requireScope() — existing admin-scoped keys keep working'. The V-174 + compat-alias is the migration-safety policy.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'));
    expect(p).toMatch(/V-174 — both create and revoke require 'account_owner' scope on the/);
    expect(p).toMatch(/calling key\. Pre-V-174 this was 'admin'; the new scope split carved/);
    expect(p).toMatch(/'admin' into 'account_owner' \(customer-account control\) and/);
    expect(p).toMatch(/'driftstack_internal_admin' \(Driftstack-staff-only\)\. The 'admin'/);
    expect(p).toMatch(/scope retains compat-alias semantics during migration via/);
    expect(p).toMatch(/requireScope\(\) — existing 'admin'-scoped keys keep working\./);
  });

  // ─── LegalAcceptanceGate framing ─────────────────────────────

  it("CRITICAL LegalAcceptanceGate JSDoc — 'Gate interface for blocking API key issuance on pending legal acceptances. Production wiring supplies a LegalService instance; tests can pass null to skip the check (used by tests that don't exercise the legal track)'. The optional + nullable-in-tests pattern is the legal-track decoupling.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'));
    expect(p).toMatch(/Gate interface for blocking API key issuance on pending legal/);
    expect(p).toMatch(/acceptances\. Production wiring supplies a LegalService instance;/);
    expect(p).toMatch(/tests can pass `null` to skip the check \(used by tests that don't/);
    expect(p).toMatch(/exercise the legal track\)\./);
  });

  it('CRITICAL LegalAcceptanceGate has 1 method — required(accountId) → Array<{ documentKey, currentVersion }>. The 1-method gate is what the create-path checks before issuing keys.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'));
    expect(p).toMatch(/export interface LegalAcceptanceGate \{/);
    expect(p).toMatch(
      /required\(accountId: string\): Promise<Array<\{ documentKey: string; currentVersion: string \}>>;/,
    );
  });

  // ─── NewApiKeyInput 6-field shape ────────────────────────────

  it('CRITICAL NewApiKeyInput has 6 fields — accountId + name + scopes (ApiKeyScope[]) + keyPrefix + keyHash + expiresAt (nullable). The 6-field write shape is what insertApiKey consumes; id + revokedAt + createdAt are server-assigned.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'));
    expect(p).toMatch(/export interface NewApiKeyInput \{/);
    expect(p).toMatch(/accountId: string;/);
    expect(p).toMatch(/name: string;/);
    expect(p).toMatch(/scopes: ApiKeyScope\[\];/);
    expect(p).toMatch(/keyPrefix: string;/);
    expect(p).toMatch(/keyHash: string;/);
    expect(p).toMatch(/expiresAt: Date \| null;/);
  });

  // ─── ApiKeysRepo 7+-method interface ─────────────────────────

  it('CRITICAL ApiKeysRepo declares CRUD, atomic rotate, and admin cross-account primitives.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'));
    expect(p).toMatch(/export interface ApiKeysRepo \{/);
    expect(p).toMatch(/insertApiKey\(input: NewApiKeyInput\): Promise<ApiKeyRow>;/);
    expect(p).toMatch(/listApiKeys\(accountId: string\): Promise<ApiKeyRow\[\]>;/);
    expect(p).toMatch(/findApiKey\(id: string, accountId: string\): Promise<ApiKeyRow \| null>;/);
    expect(p).toMatch(/findApiKeyUnscoped\(id: string\): Promise<ApiKeyRow \| null>;/);
    expect(p).toMatch(
      /revokeApiKeyAtomic\(input: RevokeApiKeyInput\): Promise<RevokeApiKeyRepoResult>;/,
    );
    expect(p).toMatch(/setExpiresAt\(id: string, expiresAt: Date\): Promise<void>;/);
    expect(p).toMatch(
      /rotateApiKeyAtomic\(input: RotateApiKeyInput\): Promise<RotateApiKeyRepoResult>;/,
    );
  });

  it('CRITICAL revoke input makes tenant scoping explicit and the result carries persisted authority', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'));
    expect(p).toMatch(/export interface RevokeApiKeyInput \{/);
    expect(p).toMatch(/accountId: string \| null;/);
    expect(p).toMatch(/revokedAt: Date;/);
    expect(p).toContain('export type RevokeApiKeyRepoResult =');
    expect(p).toContain("{ kind: 'revoked' | 'already_revoked'; key: ApiKeyRow }");
    expect(p).toContain("{ kind: 'not_found' };");
  });

  // ─── findApiKeyUnscoped admin-only framing ───────────────────

  it("CRITICAL findApiKeyUnscoped JSDoc — 'Find an API key by id WITHOUT account scoping (admin force-actions only)'. The admin-only unscoped read mirrors W946 sessions findSessionUnscoped pattern.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'));
    expect(p).toMatch(/Find an API key by id WITHOUT account scoping \(admin force-actions only\)/);
  });

  // ─── V-296 atomic rotation framing ───────────────────────────

  it('CRITICAL rotation JSDoc requires the atomic repository method while retaining a narrow compatibility setter.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'));
    expect(p).toContain('Narrow expiration update retained for compatibility. Rotation must use');
    expect(p).toContain('rotateApiKeyAtomic() so its authority check and both writes serialize.');
  });

  // ─── listAcrossAccounts admin-tool framing ───────────────────

  it("CRITICAL listAcrossAccounts JSDoc — 'Cross-account list for admin tooling. Filters by accountId optionally; supports cursor pagination by createdAt DESC. Optional revoked filter — true = only revoked keys, false = only active, undefined = both'. The 3-state revoked-filter matches W931 rate-limit-overrides listAll + admin paginator pattern.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'));
    expect(p).toMatch(/Cross-account list for admin tooling\. Filters by accountId/);
    expect(p).toMatch(/optionally; supports cursor pagination by createdAt DESC\. Optional/);
    expect(p).toMatch(/`revoked` filter — true = only revoked keys, false = only active,/);
    expect(p).toMatch(/undefined = both/);
  });

  // ─── lib/api-keys 3-primitive import ─────────────────────────

  it('CRITICAL imports 3 lib/api-keys primitives — generateApiKey + hashApiKey + keyPrefixFromPlaintext. The 3-primitive import bridges service-layer coordination to lib/ crypto primitives (matches W912 api-key-generation invariant).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'));
    // Four now: `apiKeyEnvForTier` joined them when the test/live decision
    // moved out of an inline `tier === 'free' ? …` ternary and into
    // TIER_FEATURES, which had declared itself the source of truth for that
    // while being read by no runtime code.
    for (const primitive of [
      'apiKeyEnvForTier',
      'generateApiKey',
      'hashApiKey',
      'keyPrefixFromPlaintext',
    ]) {
      expect(p, `${primitive} imported from lib/api-keys`).toMatch(
        new RegExp(
          `import \\{[\\s\\S]*?\\b${primitive}\\b[\\s\\S]*?\\} from '\\.\\./lib/api-keys\\.js';`,
        ),
      );
    }
  });

  // ─── Error class imports ─────────────────────────────────────

  it('CRITICAL imports error/helper symbols — BadRequestError + ForbiddenError + LegalAcceptanceRequiredError from errors.js; NotFoundError + hasScope + requireScope (aliased throwIfMissingScope) + requireTierFeature from errors-helpers.js. ForbiddenError + hasScope back the V-174 scope de-escalation on mint; requireTierFeature backs the Free customer-API boundary (3202fdb17) on mint + rotate.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'));
    expect(p).toMatch(
      /import \{ BadRequestError, ForbiddenError, LegalAcceptanceRequiredError \} from '\.\.\/lib\/errors\.js';/,
    );
    expect(p).toMatch(
      /import \{\s*\n?\s*NotFoundError,\s*\n?\s*hasScope,\s*\n?\s*requireScope as throwIfMissingScope,\s*\n?\s*requireTierFeature,\s*\n?\s*\} from '\.\.\/lib\/errors-helpers\.js';/,
    );
  });

  // ─── api-types type imports ──────────────────────────────────

  it('CRITICAL imports AccountTier + ApiKeyScope types from @driftstack/api-types — single-source-of-truth for tier + scope vocabularies.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'));
    // AccountTier left this import when the effective-owner PAIR became one
    // type: the tier now arrives inside `EffectiveOwner` rather than as a
    // second loose optional, so the file no longer names it directly. The
    // vocabulary claim this arm makes is about ApiKeyScope; the tier one is
    // made where the tier now lives.
    expect(p).toMatch(/import type \{ ApiKeyScope \} from '@driftstack\/api-types';/);
    expect(p).toMatch(
      /import type \{ EffectiveOwner \} from '\.\.\/lib\/effective-account-header\.js';/,
    );
  });

  // ─── AuthCache import (for revoke cache-invalidation) ────────

  it('CRITICAL imports AuthCache type from auth-cache — used by revoke() to invalidate the cached key after marking it revoked (matches D-020 cache-invalidation pattern; same as W931 rate-limit-overrides).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'));
    expect(p).toMatch(/import type \{ AuthCache \} from '\.\/auth-cache\.js';/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/api-keys-service-v174-v296-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
