// API key management service.
//
// Operations:
//   - create: generates a new key, hashes it, stores prefix+hash, returns
//     plaintext ONCE in the response. After creation the plaintext is
//     unrecoverable.
//   - list: returns all keys for the caller's account (no plaintext).
//   - revoke: marks a key revoked (idempotent — revoking a revoked key is
//     a no-op, but revoking a non-existent key is 404).
//
// V-174 — both create and revoke require 'account_owner' scope on the
// calling key. Pre-V-174 this was 'admin'; the new scope split carved
// 'admin' into 'account_owner' (customer-account control) and
// 'driftstack_internal_admin' (Driftstack-staff-only). The 'admin'
// scope retains compat-alias semantics during migration via
// requireScope() — existing 'admin'-scoped keys keep working.

import type { ApiKeyScope } from '@driftstack/api-types';
import type { AccountContext } from './auth.js';
import type { ApiKeyRow } from './auth.js';
import type { AuthCache } from './auth-cache.js';
import { generateApiKey, hashApiKey, keyPrefixFromPlaintext } from '../lib/api-keys.js';
import { LegalAcceptanceRequiredError } from '../lib/errors.js';
import { NotFoundError, requireScope as throwIfMissingScope } from '../lib/errors-helpers.js';

/**
 * Gate interface for blocking API key issuance on pending legal
 * acceptances. Production wiring supplies a LegalService instance;
 * tests can pass `null` to skip the check (used by tests that don't
 * exercise the legal track).
 */
export interface LegalAcceptanceGate {
  required(accountId: string): Promise<Array<{ documentKey: string; currentVersion: string }>>;
}

export interface NewApiKeyInput {
  accountId: string;
  name: string;
  scopes: ApiKeyScope[];
  keyPrefix: string;
  keyHash: string;
  expiresAt: Date | null;
}

export interface ApiKeysRepo {
  insertApiKey(input: NewApiKeyInput): Promise<ApiKeyRow>;
  listApiKeys(accountId: string): Promise<ApiKeyRow[]>;
  findApiKey(id: string, accountId: string): Promise<ApiKeyRow | null>;
  /** Find an API key by id WITHOUT account scoping (admin force-actions only). */
  findApiKeyUnscoped(id: string): Promise<ApiKeyRow | null>;
  markRevoked(id: string, at: Date): Promise<void>;
  /**
   * Cross-account list for admin tooling. Filters by accountId
   * optionally; supports cursor pagination by createdAt DESC. Optional
   * `revoked` filter — true = only revoked keys, false = only active,
   * undefined = both.
   */
  listAllApiKeys(opts: {
    limit: number;
    cursor?: string;
    accountId?: string;
    revoked?: boolean;
  }): Promise<{ items: ApiKeyRow[]; nextCursor: string | null }>;
}

export interface CreateApiKeyServiceInput {
  name: string;
  scopes: ApiKeyScope[];
  expiresAt: Date | null;
}

export interface CreatedApiKey {
  row: ApiKeyRow;
  plaintext: string;
}

export interface RevocationWebhookEmitter {
  enqueueEvent: (
    accountId: string,
    eventType: 'api_key.revoked',
    data: Record<string, unknown>,
  ) => Promise<number>;
}

/** V-216 — minimal callable surface for the customer-facing audit log. */
export interface CustomerAuditEmitter {
  record: (input: {
    accountId: string;
    actorType: 'customer' | 'system' | 'staff';
    actorAccountId?: string | null;
    actorKeyId?: string | null;
    action:
      | 'account.email_verified'
      | 'account.login'
      | 'account.logout'
      | 'account.password_changed'
      | 'api_key.minted'
      | 'api_key.revoked'
      | 'session.created'
      | 'session.destroyed'
      | 'profile.created'
      | 'profile.deleted'
      | 'subscription.tier_changed'
      | 'webhook_endpoint.created'
      | 'webhook_endpoint.deleted';
    targetResourceId?: string | null;
    payload?: Record<string, unknown> | null;
  }) => Promise<unknown>;
}

export class ApiKeysService {
  constructor(
    private readonly repo: ApiKeysRepo,
    private readonly authCache: AuthCache | null = null,
    private readonly webhooks: RevocationWebhookEmitter | null = null,
    private readonly legalGate: LegalAcceptanceGate | null = null,
    private readonly accountAudit: CustomerAuditEmitter | null = null,
  ) {}

  async create(ctx: AccountContext, input: CreateApiKeyServiceInput): Promise<CreatedApiKey> {
    throwIfMissingScope(ctx, 'account_owner');

    // Block issuance until the account has accepted all currently-required
    // legal documents. Production wiring supplies the gate; tests that
    // don't exercise the legal track pass null (skips the check). Per
    // V-049 + the founder direction "API-key-issuance-block first".
    if (this.legalGate !== null) {
      const pending = await this.legalGate.required(ctx.account.id);
      if (pending.length > 0) {
        throw new LegalAcceptanceRequiredError(
          pending.map((p) => ({
            document_key: p.documentKey,
            current_version: p.currentVersion,
          })),
        );
      }
    }

    const env = ctx.account.tier === 'trial_pack' ? 'test' : 'live';
    const plaintext = generateApiKey(env);
    const keyHash = await hashApiKey(plaintext);
    const keyPrefix = keyPrefixFromPlaintext(plaintext);

    const row = await this.repo.insertApiKey({
      accountId: ctx.account.id,
      name: input.name,
      scopes: input.scopes,
      keyPrefix,
      keyHash,
      expiresAt: input.expiresAt,
    });

    // V-216 — record customer-facing audit entry. Best-effort; never
    // breaks the mint flow.
    if (this.accountAudit) {
      try {
        await this.accountAudit.record({
          accountId: ctx.account.id,
          actorType: 'customer',
          actorAccountId: ctx.account.id,
          actorKeyId: ctx.apiKey.id,
          action: 'api_key.minted',
          targetResourceId: `key_${row.id}`,
          payload: { name: input.name, scopes: input.scopes },
        });
      } catch {
        /* swallow */
      }
    }

    return { row, plaintext };
  }

  async list(ctx: AccountContext): Promise<ApiKeyRow[]> {
    return this.repo.listApiKeys(ctx.account.id);
  }

  /**
   * Cross-account list for the admin panel. Requires
   * `driftstack_internal_admin` scope.
   */
  async listAll(
    ctx: AccountContext,
    opts: { limit: number; cursor?: string; accountId?: string; revoked?: boolean },
  ): Promise<{ items: ApiKeyRow[]; nextCursor: string | null }> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    return this.repo.listAllApiKeys(opts);
  }

  async revoke(ctx: AccountContext, keyId: string): Promise<void> {
    throwIfMissingScope(ctx, 'account_owner');

    const key = await this.repo.findApiKey(keyId, ctx.account.id);
    if (!key) throw new NotFoundError(`API key "${keyId}" not found.`);
    if (key.revokedAt !== null) return; // idempotent

    const revokedAt = new Date();
    await this.repo.markRevoked(keyId, revokedAt);
    // Pop the cache entry so the revoked key stops authenticating
    // immediately, not after the 30s TTL. Wrap in try/catch — a cache
    // failure must not propagate as a revoke failure.
    if (this.authCache) {
      try {
        await this.authCache.invalidateKey(keyId);
      } catch {
        // Logged inside the cache impl; auth correctness is preserved by
        // the DB-level revokedAt flag (the next scrypt-path lookup catches
        // the revocation when the cache TTLs out).
      }
    }

    // Emit api_key.revoked webhook event. Best-effort — failures here
    // never break revoke correctness.
    if (this.webhooks) {
      try {
        await this.webhooks.enqueueEvent(ctx.account.id, 'api_key.revoked', {
          api_key_id: `key_${keyId}`,
          name: key.name,
          revoked_at: revokedAt.toISOString(),
        });
      } catch {
        // Swallow.
      }
    }

    // V-216 — record customer-facing audit entry.
    if (this.accountAudit) {
      try {
        await this.accountAudit.record({
          accountId: ctx.account.id,
          actorType: 'customer',
          actorAccountId: ctx.account.id,
          actorKeyId: ctx.apiKey.id,
          action: 'api_key.revoked',
          targetResourceId: `key_${keyId}`,
          payload: { name: key.name, revoked_at: revokedAt.toISOString() },
        });
      } catch {
        /* swallow */
      }
    }
  }
}
