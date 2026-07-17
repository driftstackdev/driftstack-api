// W403.A — drift guard for apps/server/src/services/api-keys.ts.
// V-174 scope split (admin → account_owner / driftstack_internal_admin)
// + V-296 self-service rotation + V-326e6 team-owner scoping. Drift
// here either lets a non-owner mint keys (auth bypass) or lets rotate
// extend the OLD key's life past its existing expiry (rotated-key
// over-permission).
//
//   • V-174 framing pinned: admin → account_owner + driftstack_
//     internal_admin scope split; 'admin' retained as compat alias.
//   • 3 ops framing: create / list / revoke (idempotent on revoked).
//   • V-326e6: effectiveAccountId/effectiveTier opts → mints/revokes/
//     rotates on OWNER's account; tier follows OWNER's tier; audit
//     row on OWNER's log with actor=calling-member.
//   • create: legalGate.required() blocks issuance via
//     LegalAcceptanceRequiredError when pending; tier 'trial_pack' →
//     'test' env, else 'live'.
//   • V-216 audit: api_key.minted / api_key.revoked / api_key.rotated
//     try/catch swallow.
//   • V-296 rotate: repository transaction locks the old row, rejects
//     missing/revoked/expired authority, and atomically mints a successor
//     while shortening old expires_at — never extends life.
//   • revoke: idempotent on already-revoked; cache.invalidateKey +
//     webhooks api_key.revoked enqueue.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W403.A apps/server/src/services/api-keys.ts content parity', () => {
  const body = read(LIB);

  it('V-174 framing pinned: create + revoke require account_owner; admin compat alias via requireScope()', () => {
    expect(body).toMatch(
      /V-174 — both create and revoke require 'account_owner' scope on the\s*\n?\s*\/\/\s*calling key\. Pre-V-174 this was 'admin'; the new scope split carved\s*\n?\s*\/\/\s*'admin' into 'account_owner' \(customer-account control\) and\s*\n?\s*\/\/\s*'driftstack_internal_admin' \(Driftstack-staff-only\)\. The 'admin'\s*\n?\s*\/\/\s*scope retains compat-alias semantics during migration via\s*\n?\s*\/\/\s*requireScope\(\) — existing 'admin'-scoped keys keep working\./,
    );
  });

  it('3 ops framing: create (plaintext returned ONCE) + list + revoke (idempotent on revoked; 404 on missing)', () => {
    expect(body).toMatch(
      /- create: generates a new key, hashes it, stores prefix\+hash, returns\s*\n?\s*\/\/\s*plaintext ONCE in the response\. After creation the plaintext is\s*\n?\s*\/\/\s*unrecoverable\./,
    );
    expect(body).toMatch(/- list: returns all keys for the caller's account \(no plaintext\)\./);
    expect(body).toMatch(
      /- revoke: marks a key revoked \(idempotent — revoking a revoked key is\s*\n?\s*\/\/\s*a no-op, but revoking a non-existent key is 404\)\./,
    );
  });

  it('LegalAcceptanceGate: 1-method (required → array of documentKey + currentVersion)', () => {
    expect(body).toMatch(/export interface LegalAcceptanceGate \{/);
    expect(body).toMatch(
      /required\(accountId: string\): Promise<Array<\{ documentKey: string; currentVersion: string \}>>;/,
    );
  });

  it('ApiKeysRepo: CRUD + atomic rotate + cross-account list with revoked filter', () => {
    expect(body).toMatch(/export interface ApiKeysRepo \{/);
    expect(body).toMatch(/insertApiKey\(input: NewApiKeyInput\): Promise<ApiKeyRow>;/);
    expect(body).toMatch(/listApiKeys\(accountId: string\): Promise<ApiKeyRow\[\]>;/);
    expect(body).toMatch(
      /findApiKey\(id: string, accountId: string\): Promise<ApiKeyRow \| null>;/,
    );
    expect(body).toMatch(
      /\/\*\* Find an API key by id WITHOUT account scoping \(admin force-actions only\)\. \*\/\s*\n?\s*findApiKeyUnscoped\(id: string\): Promise<ApiKeyRow \| null>;/,
    );
    expect(body).toMatch(
      /revokeApiKeyAtomic\(input: RevokeApiKeyInput\): Promise<RevokeApiKeyRepoResult>;/,
    );
    expect(body).toContain(
      'Narrow expiration update retained for compatibility. Rotation must use',
    );
    expect(body).toMatch(/setExpiresAt\(id: string, expiresAt: Date\): Promise<void>;/);
    expect(body).toMatch(
      /rotateApiKeyAtomic\(input: RotateApiKeyInput\): Promise<RotateApiKeyRepoResult>;/,
    );
    expect(body).toMatch(
      /listAllApiKeys\(opts: \{\s*\n?\s*limit: number;\s*\n?\s*cursor\?: string;\s*\n?\s*accountId\?: string;\s*\n?\s*revoked\?: boolean;\s*\n?\s*\}\): Promise<\{ items: ApiKeyRow\[\]; nextCursor: string \| null \}>;/,
    );
  });

  it('CustomerAuditEmitter: V-216 13-action union (covers email_verified/login/logout/password_changed/api_key.*/session.*/profile.*/subscription/webhook_endpoint.*)', () => {
    expect(body).toMatch(/export interface CustomerAuditEmitter \{/);
    expect(body).toMatch(
      /action:\s*\n?\s*\| 'account\.email_verified'\s*\n?\s*\| 'account\.login'\s*\n?\s*\| 'account\.logout'\s*\n?\s*\| 'account\.password_changed'\s*\n?\s*\| 'api_key\.minted'\s*\n?\s*\| 'api_key\.revoked'\s*\n?\s*\| 'api_key\.rotated'\s*\n?\s*\| 'session\.created'\s*\n?\s*\| 'session\.destroyed'\s*\n?\s*\| 'profile\.created'\s*\n?\s*\| 'profile\.deleted'\s*\n?\s*\| 'subscription\.tier_changed'\s*\n?\s*\| 'webhook_endpoint\.created'\s*\n?\s*\| 'webhook_endpoint\.deleted';/,
    );
  });

  it('create: requireScope account_owner + V-326e6 effective-account override + legalGate.required block via LegalAcceptanceRequiredError', () => {
    expect(body).toMatch(/throwIfMissingScope\(ctx, 'account_owner'\);/);
    expect(body).toMatch(/const accountId = opts\.effectiveAccountId \?\? ctx\.account\.id;/);
    expect(body).toMatch(/const tier = opts\.effectiveTier \?\? ctx\.account\.tier;/);
    expect(body).toMatch(
      /if \(input\.provenance !== 'cli_device'\) \{\s*\n?\s*requireTierFeature\(tier, 'apiAccess'\);\s*\n?\s*\}\s*\n?[\s\S]*?if \(this\.legalGate !== null\)/,
    );
    expect(body).toMatch(
      /if \(this\.legalGate !== null\) \{\s*\n?\s*const pending = await this\.legalGate\.required\(accountId\);\s*\n?\s*if \(pending\.length > 0\) \{\s*\n?\s*throw new LegalAcceptanceRequiredError\(/,
    );
    expect(body).toMatch(
      /pending\.map\(\(p\) => \(\{\s*\n?\s*document_key: p\.documentKey,\s*\n?\s*current_version: p\.currentVersion,\s*\n?\s*\}\)\),/,
    );
  });

  it('create: V-174 privilege de-escalation — ELEVATED_SCOPES = [admin, driftstack_internal_admin]; a requested elevated scope the caller lacks (per hasScope) → ForbiddenError. Closes the account_owner → mint driftstack_internal_admin escalation.', () => {
    expect(body).toMatch(
      /const ELEVATED_SCOPES: ApiKeyScope\[\] = \['admin', 'driftstack_internal_admin'\];/,
    );
    expect(body).toMatch(
      /for \(const scope of input\.scopes\) \{\s*\n?\s*if \(ELEVATED_SCOPES\.includes\(scope\) && !hasScope\(ctx, scope\)\) \{\s*\n?\s*throw new ForbiddenError\(\s*\n?\s*`Cannot grant the "\$\{scope\}" scope: the calling key does not hold it\.`,/,
    );
  });

  it("create: tier 'free' → 'test' env else 'live'; generateApiKey + hashApiKey + keyPrefixFromPlaintext; emits api_key.minted audit", () => {
    expect(body).toMatch(/const env = tier === 'free' \? 'test' : 'live';/);
    expect(body).toMatch(/const plaintext = generateApiKey\(env\);/);
    expect(body).toMatch(/const keyHash = await hashApiKey\(plaintext\);/);
    expect(body).toMatch(/const keyPrefix = keyPrefixFromPlaintext\(plaintext\);/);
    expect(body).toMatch(
      /action: 'api_key\.minted',\s*\n?\s*targetResourceId: `key_\$\{row\.id\}`,\s*\n?\s*payload: \{ name: input\.name, scopes: input\.scopes \},/,
    );
  });

  it('rotate requires apiAccess on the effective tier before key generation or repository mutation', () => {
    expect(body).toMatch(
      /const accountId = opts\.effectiveAccountId \?\? ctx\.account\.id;\s*\n?\s*const tier = opts\.effectiveTier \?\? ctx\.account\.tier;\s*\n?[\s\S]*?requireTierFeature\(tier, 'apiAccess'\);\s*\n?\s*const env = tier === 'free' \? 'test' : 'live';/,
    );
  });

  it('listAll: requires driftstack_internal_admin scope (cross-account admin panel)', () => {
    expect(body).toMatch(
      /Cross-account list for the admin panel\. Requires\s*\n?\s*\*\s*`driftstack_internal_admin` scope\./,
    );
    expect(body).toMatch(/throwIfMissingScope\(ctx, 'driftstack_internal_admin'\);/);
    expect(body).toMatch(/return this\.repo\.listAllApiKeys\(opts\);/);
  });

  it('V-296 rotate: one repository call owns locked authority + both writes; terminal results map to public errors', () => {
    expect(body).toMatch(/const gracePeriodMs = opts\.gracePeriodMs \?\? 24 \* 60 \* 60 \* 1000;/);
    expect(body).toContain('const result = await this.repo.rotateApiKeyAtomic({');
    expect(body).toContain('oldKeyId: keyId,');
    expect(body).toContain('accountId,');
    expect(body).toContain('now,');
    expect(body).toContain('gracePeriodMs,');
    expect(body).toContain("if (terminal?.kind === 'not_found') {");
    expect(body).toContain("if (terminal?.kind === 'revoked') {");
    expect(body).toContain("if (terminal?.kind === 'expired') {");
    expect(body).not.toContain('await this.repo.setExpiresAt(oldKey.id, gracePeriodEndsAt);');
    expect(body).not.toMatch(/becomes the later of \(existing/);
  });

  it('rotate: retries the whole atomic transaction on prefix collision; invalidates OLD cache; audits both ids', () => {
    expect(body).toContain("!isUniqueViolation(err, 'api_keys_prefix_unique')");
    expect(body).toContain('attempt === MAX_KEY_MINT_ATTEMPTS');
    expect(body).toContain('const { oldKey, newRow, gracePeriodEndsAt } = rotated;');
    expect(body).toMatch(/await this\.authCache\.invalidateKey\(oldKey\.id\);/);
    expect(body).toMatch(
      /action: 'api_key\.rotated',\s*\n?\s*targetResourceId: `key_\$\{oldKey\.id\}`,\s*\n?\s*payload: \{\s*\n?\s*old_key_id: `key_\$\{oldKey\.id\}`,\s*\n?\s*new_key_id: `key_\$\{newRow\.id\}`,\s*\n?\s*grace_period_ends_at: gracePeriodEndsAt\.toISOString\(\),\s*\n?\s*\},/,
    );
  });

  it('revoke: atomic scoped outcome; idempotent loser; winner-only cache/webhook/audit', () => {
    expect(body).toContain('const outcome = await this.repo.revokeApiKeyAtomic({');
    expect(body).toContain('accountId,');
    expect(body).toMatch(
      /if \(outcome\.kind === 'already_revoked'\) return false; \/\/ idempotent/,
    );
    expect(body).toContain('const revokedAt = key.revokedAt;');
    expect(body).toMatch(/await this\.authCache\.invalidateKey\(keyId\);/);
    expect(body).toMatch(
      /await this\.webhooks\.enqueueEvent\(accountId, 'api_key\.revoked', \{\s*\n?\s*api_key_id: `key_\$\{keyId\}`,\s*\n?\s*name: key\.name,\s*\n?\s*revoked_at: revokedAt\.toISOString\(\),/,
    );
    expect(body).toMatch(
      /action: 'api_key\.revoked',\s*\n?\s*targetResourceId: `key_\$\{keyId\}`,\s*\n?\s*payload: \{ name: key\.name, revoked_at: revokedAt\.toISOString\(\) \},/,
    );
    expect(body).toContain('return true;');
  });

  it('Constructor: 5-arg shape (repo + 4 nullable collaborators: authCache + webhooks + legalGate + accountAudit)', () => {
    expect(body).toMatch(
      /constructor\(\s*\n?\s*private readonly repo: ApiKeysRepo,\s*\n?\s*private readonly authCache: AuthCache \| null = null,\s*\n?\s*private readonly webhooks: RevocationWebhookEmitter \| null = null,\s*\n?\s*private readonly legalGate: LegalAcceptanceGate \| null = null,\s*\n?\s*private readonly accountAudit: CustomerAuditEmitter \| null = null,\s*\n?\s*\) \{\}/,
    );
  });

  it('NewApiKeyInput: 6 fields (accountId/name/scopes/keyPrefix/keyHash/expiresAt nullable)', () => {
    expect(body).toMatch(/export interface NewApiKeyInput \{/);
    expect(body).toMatch(/accountId: string;/);
    expect(body).toMatch(/name: string;/);
    expect(body).toMatch(/scopes: ApiKeyScope\[\];/);
    expect(body).toMatch(/keyPrefix: string;/);
    expect(body).toMatch(/keyHash: string;/);
    expect(body).toMatch(/expiresAt: Date \| null;/);
  });

  it('RevocationWebhookEmitter: enqueueEvent with literal api_key.revoked event-type + Promise<number> return', () => {
    expect(body).toMatch(/export interface RevocationWebhookEmitter \{/);
    expect(body).toMatch(
      /enqueueEvent: \(\s*\n?\s*accountId: string,\s*\n?\s*eventType: 'api_key\.revoked',\s*\n?\s*data: Record<string, unknown>,\s*\n?\s*\) => Promise<number>;/,
    );
  });

  it('imports: AccountTier+ApiKeyScope from api-types + AccountContext/ApiKeyRow from auth.js + AuthCache + api-keys helpers + errors (BadRequest+Forbidden+Legal from errors.js; NotFound+hasScope+requireScope from errors-helpers.js)', () => {
    expect(body).toMatch(
      /import type \{ AccountTier, ApiKeyScope \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ AccountContext \} from '\.\/auth\.js';/);
    expect(body).toMatch(/import type \{ ApiKeyRow \} from '\.\/auth\.js';/);
    expect(body).toMatch(/import type \{ AuthCache \} from '\.\/auth-cache\.js';/);
    expect(body).toMatch(
      /import \{ generateApiKey, hashApiKey, keyPrefixFromPlaintext \} from '\.\.\/lib\/api-keys\.js';/,
    );
    expect(body).toMatch(
      /import \{ BadRequestError, ForbiddenError, LegalAcceptanceRequiredError \} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(
      /import \{\s*\n?\s*NotFoundError,\s*\n?\s*hasScope,\s*\n?\s*requireScope as throwIfMissingScope,\s*\n?\s*requireTierFeature,\s*\n?\s*\} from '\.\.\/lib\/errors-helpers\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
