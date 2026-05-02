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
// Both create and revoke require the 'admin' scope on the calling key.

import type { ApiKeyScope } from '@driftstack/api-types';
import type { AccountContext } from './auth.js';
import type { ApiKeyRow } from './auth.js';
import type { AuthCache } from './auth-cache.js';
import { generateApiKey, hashApiKey, keyPrefixFromPlaintext } from '../lib/api-keys.js';
import { NotFoundError, requireScope as throwIfMissingScope } from '../lib/errors-helpers.js';

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
  markRevoked(id: string, at: Date): Promise<void>;
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

export class ApiKeysService {
  constructor(
    private readonly repo: ApiKeysRepo,
    private readonly authCache: AuthCache | null = null,
    private readonly webhooks: RevocationWebhookEmitter | null = null,
  ) {}

  async create(ctx: AccountContext, input: CreateApiKeyServiceInput): Promise<CreatedApiKey> {
    throwIfMissingScope(ctx, 'admin');

    const env = ctx.account.tier === 'free' ? 'test' : 'live';
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

    return { row, plaintext };
  }

  async list(ctx: AccountContext): Promise<ApiKeyRow[]> {
    return this.repo.listApiKeys(ctx.account.id);
  }

  async revoke(ctx: AccountContext, keyId: string): Promise<void> {
    throwIfMissingScope(ctx, 'admin');

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
  }
}
