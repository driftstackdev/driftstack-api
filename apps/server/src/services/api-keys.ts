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
import {
  apiKeyEnvForTier,
  generateApiKey,
  hashApiKey,
  keyPrefixFromPlaintext,
} from '../lib/api-keys.js';
import { BadRequestError, ForbiddenError, LegalAcceptanceRequiredError } from '../lib/errors.js';
import type { EffectiveOwner } from '../lib/effective-account-header.js';
import {
  NotFoundError,
  hasScope,
  requireScope as throwIfMissingScope,
  requireTierFeature,
} from '../lib/errors-helpers.js';
import { isUniqueViolation } from '../lib/pg-error.js';

/**
 * api_keys.key_prefix carries a UNIQUE index (`api_keys_prefix_unique`).
 * The prefix is derived from a freshly-generated random key, so a
 * collision is astronomically rare (~40-bit birthday bound) but not
 * impossible — and when it happens Postgres raises SQLSTATE 23505 on the
 * insert. Left uncaught, that surfaces as an opaque 500 on a perfectly
 * valid mint/rotate request. Since the colliding value is one we generate
 * (not caller-supplied), the correct response is to regenerate the key and
 * retry, bounded, rather than translate the error — mirroring the
 * regenerate-on-collision shape used elsewhere for control-plane-owned
 * unique values.
 */
const MAX_KEY_MINT_ATTEMPTS = 3;

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
  /** C1 — provisioning origin. Omit / null for an ordinary key;
   *  `'cli_device'` for a CLI/GUI device-code key (deny-gated). */
  provenance?: string | null;
  /**
   * V-726 — the account that MINTED this key. Equals `accountId` for a
   * self-minted key; for a team-scoped mint it is the acting MEMBER while
   * `accountId` stays the owner. Recorded so removing a member can revoke the
   * credentials they created — a key authenticates as `accountId` and never
   * re-checks the minter's membership, so removal alone left them live.
   */
  createdByAccountId?: string | null;
}

export interface RotateApiKeyInput {
  oldKeyId: string;
  accountId: string;
  /** Omit to preserve the locked old row's name. */
  name?: string;
  keyPrefix: string;
  keyHash: string;
  now: Date;
  gracePeriodMs: number;
}

export type RotateApiKeyRepoResult =
  | {
      kind: 'rotated';
      oldKey: ApiKeyRow;
      newRow: ApiKeyRow;
      gracePeriodEndsAt: Date;
    }
  | { kind: 'not_found' | 'revoked' | 'expired' };

export interface RevokeApiKeyInput {
  id: string;
  /** Customer revocation must supply its owner account. Admin force-actions
   *  must opt into the unscoped path explicitly with null. */
  accountId: string | null;
  revokedAt: Date;
}

export type RevokeApiKeyRepoResult =
  | { kind: 'revoked' | 'already_revoked'; key: ApiKeyRow }
  | { kind: 'not_found' };

export interface ApiKeysRepo {
  insertApiKey(input: NewApiKeyInput): Promise<ApiKeyRow>;
  /**
   * V-727 — keys this account MINTED on OTHER accounts (team-scoped mints,
   * where `accountId` is the owner and `createdByAccountId` is this account).
   * `listApiKeys` cannot find them: it filters on `accountId`, so it only ever
   * returns keys ON the account, never keys it created elsewhere.
   */
  listApiKeysMintedBy(minterAccountId: string): Promise<ApiKeyRow[]>;
  listApiKeys(accountId: string): Promise<ApiKeyRow[]>;
  findApiKey(id: string, accountId: string): Promise<ApiKeyRow | null>;
  /** Find an API key by id WITHOUT account scoping (admin force-actions only). */
  findApiKeyUnscoped(id: string): Promise<ApiKeyRow | null>;
  /** Conditionally revoke one active row and return the persisted authority.
   *  Exactly one concurrent first caller can receive `revoked`. */
  revokeApiKeyAtomic(input: RevokeApiKeyInput): Promise<RevokeApiKeyRepoResult>;
  /** Narrow expiration update retained for compatibility. Rotation must use
   *  rotateApiKeyAtomic() so its authority check and both writes serialize. */
  setExpiresAt(id: string, expiresAt: Date): Promise<void>;
  /**
   * Lock the current old-key row and, only while it remains active, insert its
   * successor and shorten the old key to the grace boundary in one transaction.
   * The locked row is the authority for account, scopes, and inherited expiry.
   */
  rotateApiKeyAtomic(input: RotateApiKeyInput): Promise<RotateApiKeyRepoResult>;
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
  /** C1 — set to `'cli_device'` by the cli-authorize bind flow so the
   *  minted key is deny-gated from account-takeover operations. */
  provenance?: 'cli_device';
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
      | 'api_key.rotated'
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

/**
 * C1 — device-provisioned keys (minted by the cli-authorize device-code
 * flow, provenance='cli_device') are barred from the account-takeover
 * key operations even though they carry account_owner. This is the
 * service-level chokepoint: POST /v1/api-keys, rotate, and DELETE enforce
 * account_owner here rather than via a requireScope preHandler, so this
 * guard complements the central device-key deny-gate for those routes.
 * A phished device key therefore cannot mint a fresh persistent
 * credential that would survive revoking the device key.
 */
function assertNotDeviceKey(ctx: AccountContext, action: string): void {
  if (ctx.apiKey.provenance === 'cli_device') {
    throw new ForbiddenError(`Device-provisioned keys cannot ${action}. Use a dashboard session.`);
  }
}

export class ApiKeysService {
  constructor(
    private readonly repo: ApiKeysRepo,
    private readonly authCache: AuthCache | null = null,
    private readonly webhooks: RevocationWebhookEmitter | null = null,
    private readonly legalGate: LegalAcceptanceGate | null = null,
    private readonly accountAudit: CustomerAuditEmitter | null = null,
  ) {}

  /**
   * Generate a fresh plaintext key + hash + prefix and insert the row,
   * retrying on a `key_prefix` unique-violation (SQLSTATE 23505). The
   * prefix is a random-derived value we own, so a collision is resolved
   * by regenerating and re-inserting rather than by surfacing the DB
   * error. Bounded to MAX_KEY_MINT_ATTEMPTS; if every attempt collides
   * the last 23505 is rethrown (turns into a clean retryable error rather
   * than an infinite loop). Any non-collision insert error propagates
   * immediately.
   *
   * `insertFields` supplies the non-key columns (accountId, name, scopes,
   * expiresAt, provenance); this method fills keyPrefix + keyHash.
   */
  private async mintAndInsertWithRetry(
    env: 'test' | 'live',
    insertFields: Omit<NewApiKeyInput, 'keyPrefix' | 'keyHash'>,
  ): Promise<{ row: ApiKeyRow; plaintext: string }> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_KEY_MINT_ATTEMPTS; attempt += 1) {
      const plaintext = generateApiKey(env);
      const keyHash = await hashApiKey(plaintext);
      const keyPrefix = keyPrefixFromPlaintext(plaintext);
      try {
        const row = await this.repo.insertApiKey({ ...insertFields, keyPrefix, keyHash });
        return { row, plaintext };
      } catch (err) {
        if (isUniqueViolation(err, 'api_keys_prefix_unique')) {
          // Prefix collision — regenerate a fresh key and retry.
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    // Exhausted the bound with a prefix collision every time. Astronomically
    // unlikely; rethrow the last 23505 so the caller gets an error rather
    // than a silently-wrong result.
    throw lastErr;
  }

  async create(
    ctx: AccountContext,
    input: CreateApiKeyServiceInput,
    opts: EffectiveOwner = {},
  ): Promise<CreatedApiKey> {
    throwIfMissingScope(ctx, 'account_owner');
    assertNotDeviceKey(ctx, 'mint API keys');

    // V-174 privilege de-escalation. The account_owner gate above lets a
    // customer dashboard session mint keys, but a caller must not be able
    // to grant an ELEVATED scope it does not itself hold — otherwise an
    // account_owner key could mint a `driftstack_internal_admin` key that
    // satisfies the `/v1/admin/*` route guards and acts cross-account, or
    // perpetuate the deprecated `admin` customer alias. Customer-level
    // scopes (read / write / account_owner / granular verb:resource /
    // gui_control) stay grantable under account_owner; only the
    // staff/deprecated scopes require the caller to already hold that exact
    // scope. A legacy `admin` key can preserve customer compatibility but
    // cannot grant or derive the staff-only scope.
    const ELEVATED_SCOPES: ApiKeyScope[] = ['admin', 'driftstack_internal_admin'];
    for (const scope of input.scopes) {
      if (ELEVATED_SCOPES.includes(scope) && !hasScope(ctx, scope)) {
        throw new ForbiddenError(
          `Cannot grant the "${scope}" scope: the calling key does not hold it.`,
        );
      }
    }

    // V-326e6 — when team-scoped, mint the key on the OWNER's
    // account. Route layer has already enforced 'admin' team role
    // per Q1. Tier-derived test/live env switch follows the OWNER's
    // tier (a member acting for an api_starter owner mints
    // ds_live_… keys; member's own tier doesn't matter).
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    const tier = opts.effectiveTier ?? ctx.account.tier;

    // Free stays usable through the browser-authorized desktop flow, which
    // mints a provenance-bound restricted device credential. Ordinary
    // customer API keys require the effective account/workspace tier to carry
    // API access. Gate before legal/repository/audit side effects.
    if (input.provenance !== 'cli_device') {
      requireTierFeature(tier, 'apiAccess');
    }

    // Block issuance until the account has accepted all currently-required
    // legal documents. Production wiring supplies the gate; tests that
    // don't exercise the legal track pass null (skips the check). Per
    // V-049 + the founder direction "API-key-issuance-block first".
    // V-326e6 — gate against the OWNER's pending acceptances when
    // team-scoped. The OWNER's legal posture, not the member's,
    // determines whether keys can mint on the OWNER's account.
    if (this.legalGate !== null) {
      const pending = await this.legalGate.required(accountId);
      if (pending.length > 0) {
        throw new LegalAcceptanceRequiredError(
          pending.map((p) => ({
            document_key: p.documentKey,
            current_version: p.currentVersion,
          })),
        );
      }
    }

    const env = apiKeyEnvForTier(tier);
    // Insert with a bounded regenerate-retry on a key_prefix collision
    // (23505) so a rare prefix birthday-clash is resolved by minting a
    // fresh key rather than surfacing an opaque 500.
    const { row, plaintext } = await this.mintAndInsertWithRetry(env, {
      accountId,
      name: input.name,
      scopes: input.scopes,
      expiresAt: input.expiresAt,
      provenance: input.provenance ?? null,
      // V-726 — the ACTING account, which is the member on a team-scoped mint
      // (accountId above is the owner). This is the only record of who created
      // the credential, and what removeMember revokes against.
      createdByAccountId: ctx.account.id,
    });

    // V-216 — record customer-facing audit entry. Best-effort; never
    // breaks the mint flow.
    // V-326e6 — audit on OWNER's log; actor stays the calling
    // member.
    if (this.accountAudit) {
      try {
        await this.accountAudit.record({
          accountId,
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

  async list(
    ctx: AccountContext,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<ApiKeyRow[]> {
    throwIfMissingScope(ctx, 'read:api-keys');

    // V-326e6 — read role-agnostic; both 'member' and 'admin' can
    // list the OWNER's keys when team-scoped.
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    return this.repo.listApiKeys(accountId);
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

  /**
   * V-296 — customer self-service rotation. Mints a fresh plaintext +
   * hash for a new api_keys row (same name + accountId + minter, and the same
   * scopes MINUS any elevated ones — V-775: `driftstack_internal_admin` is
   * dropped and the legacy `admin` alias becomes `account_owner`, so rotation
   * can never mint authority the way this second issuance path used to), and
   * sets `expires_at` on the OLD key to `now + gracePeriodMs`. The old
   * key continues to authenticate until that timestamp; after that the
   * existing expires_at gate in auth.ts rejects it cleanly.
   *
   * Returns { newRow, plaintext, oldKey, gracePeriodEndsAt }. The
   * plaintext is shown once — same UX as initial mint.
   *
   * Idempotency: rotating an already-rotated key (one whose expires_at
   * is already set near the grace boundary) just mints another new key.
   * The old key's expires_at is capped at the EARLIER of (existing,
   * now+grace) so rotation never extends the old key's life — a long-
   * lived key is shortened to the grace window, and a sooner-expiring
   * one keeps its earlier deadline.
   */
  async rotate(
    ctx: AccountContext,
    keyId: string,
    opts: EffectiveOwner & {
      gracePeriodMs?: number;
      name?: string;
    } = {},
  ): Promise<{
    newRow: ApiKeyRow;
    plaintext: string;
    oldKey: ApiKeyRow;
    gracePeriodEndsAt: Date;
  }> {
    throwIfMissingScope(ctx, 'account_owner');
    assertNotDeviceKey(ctx, 'rotate API keys');

    // V-326e6 — when team-scoped, rotate a key on the OWNER's
    // account. Route layer enforces 'admin' team role.
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    const tier = opts.effectiveTier ?? ctx.account.tier;

    // Rotation always produces an ordinary customer API key. A legacy key on
    // a downgraded Free account remains revocable from the dashboard but may
    // not be refreshed into new programmatic authority.
    requireTierFeature(tier, 'apiAccess');

    const env = apiKeyEnvForTier(tier);
    const gracePeriodMs = opts.gracePeriodMs ?? 24 * 60 * 60 * 1000;
    const now = new Date();
    let rotated: Extract<RotateApiKeyRepoResult, { kind: 'rotated' }> | null = null;
    let terminal: Exclude<RotateApiKeyRepoResult, { kind: 'rotated' }> | null = null;
    let plaintext = '';

    // The repository owns the locked-current authority check and both writes.
    // Retry the whole transaction on the same rare prefix collision handled by
    // create(); a failed attempt rolls back both the successor insert and old
    // expiry update before a fresh plaintext is generated.
    for (let attempt = 1; attempt <= MAX_KEY_MINT_ATTEMPTS; attempt++) {
      const candidatePlaintext = generateApiKey(env);
      try {
        const result = await this.repo.rotateApiKeyAtomic({
          oldKeyId: keyId,
          accountId,
          ...(opts.name !== undefined ? { name: opts.name } : {}),
          keyPrefix: keyPrefixFromPlaintext(candidatePlaintext),
          keyHash: await hashApiKey(candidatePlaintext),
          now,
          gracePeriodMs,
        });
        if (result.kind === 'rotated') {
          rotated = result;
          plaintext = candidatePlaintext;
        } else {
          terminal = result;
        }
        break;
      } catch (err) {
        if (
          !isUniqueViolation(err, 'api_keys_prefix_unique') ||
          attempt === MAX_KEY_MINT_ATTEMPTS
        ) {
          throw err;
        }
      }
    }

    if (terminal?.kind === 'not_found') {
      throw new NotFoundError(`API key "${keyId}" not found.`);
    }
    if (terminal?.kind === 'revoked') {
      throw new BadRequestError(
        'Cannot rotate a revoked key. Mint a fresh one via POST /v1/api-keys.',
      );
    }
    if (terminal?.kind === 'expired') {
      throw new BadRequestError(
        'Cannot rotate an expired key. Mint a fresh one via POST /v1/api-keys.',
      );
    }
    if (rotated === null) {
      throw new Error('API key rotation returned no result');
    }
    const { oldKey, newRow, gracePeriodEndsAt } = rotated;

    // Cache invalidation for the OLD key — its expires_at changed, so
    // any cached AccountContext for that key is now stale. The cache
    // entry doesn't carry expires_at, but the service is still correct
    // because the next miss-path hits the DB and sees the new value.
    if (this.authCache) {
      try {
        await this.authCache.invalidateKey(oldKey.id);
      } catch {
        /* swallow */
      }
    }

    // V-216 — record customer-facing audit entry. Captures both ids so
    // post-incident reconstruction can pair the rotation.
    // V-326e6 — audit row on OWNER's log; actor stays the calling
    // member.
    if (this.accountAudit) {
      try {
        await this.accountAudit.record({
          accountId,
          actorType: 'customer',
          actorAccountId: ctx.account.id,
          actorKeyId: ctx.apiKey.id,
          action: 'api_key.rotated',
          targetResourceId: `key_${oldKey.id}`,
          payload: {
            old_key_id: `key_${oldKey.id}`,
            new_key_id: `key_${newRow.id}`,
            grace_period_ends_at: gracePeriodEndsAt.toISOString(),
          },
        });
      } catch {
        /* swallow */
      }
    }

    return { newRow, plaintext, oldKey, gracePeriodEndsAt };
  }

  async revoke(
    ctx: AccountContext,
    keyId: string,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<boolean> {
    throwIfMissingScope(ctx, 'account_owner');
    assertNotDeviceKey(ctx, 'revoke API keys');
    // V-326e6 — when team-scoped, revoke a key on the OWNER's
    // account. Route layer enforces 'admin' team role.
    return this.revokeChecked(ctx, keyId, opts.effectiveAccountId ?? ctx.account.id);
  }

  /**
   * The revoke body WITHOUT the customer-scope gate: atomic revoke, auth-cache
   * invalidation, webhook fan-out, customer audit row.
   *
   * V-727 — split out because the staff bulk reclaims must not depend on the
   * CALLER also holding a customer scope. They gate on
   * `driftstack_internal_admin` and then previously called `revoke()`, which
   * re-gates on `account_owner`. That happens to pass today only because a staff
   * WEB SESSION is granted account_owner in its baseScopes (services/auth.ts) —
   * so the guarantee silently depended on which credential TYPE the operator
   * used. Driven by a staff API key holding only `driftstack_internal_admin`,
   * every per-key revoke threw ForbiddenError, and `deleteAccount` catches and
   * discards reclaim errors, so the termination reported success having revoked
   * nothing. Routing the staff paths here makes the reclaim unconditional.
   */
  private async revokeChecked(
    ctx: AccountContext,
    keyId: string,
    accountId: string,
  ): Promise<boolean> {
    const outcome = await this.repo.revokeApiKeyAtomic({
      id: keyId,
      accountId,
      revokedAt: new Date(),
    });
    if (outcome.kind === 'not_found') {
      throw new NotFoundError(`API key "${keyId}" not found.`);
    }
    if (outcome.kind === 'already_revoked') return false; // idempotent

    const key = outcome.key;
    const revokedAt = key.revokedAt;
    if (revokedAt === null) {
      throw new Error('revokeApiKeyAtomic returned a revoked row without revokedAt');
    }
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
    // V-326e6 — fan-out goes to the OWNER's webhook subscriptions.
    if (this.webhooks) {
      try {
        await this.webhooks.enqueueEvent(accountId, 'api_key.revoked', {
          api_key_id: `key_${keyId}`,
          name: key.name,
          revoked_at: revokedAt.toISOString(),
        });
      } catch {
        // Swallow.
      }
    }

    // V-216 — record customer-facing audit entry.
    // V-326e6 — audit row on OWNER's log; actor stays the calling
    // member.
    if (this.accountAudit) {
      try {
        await this.accountAudit.record({
          accountId,
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
    return true;
  }

  /**
   * GDPR Article 17 — bulk-revoke every non-revoked API key for the
   * account. Backs AccountsAdminService.deleteAccount(). Requires
   * driftstack_internal_admin.
   *
   * Goes through {@link revokeChecked} rather than the public revoke(), so it
   * still gets the cache-invalidate / webhook-emit / customer-audit-emit
   * behaviour without re-gating on the CUSTOMER `account_owner` scope. V-727 —
   * it used to call revoke(), which passed only because a staff WEB SESSION is
   * granted account_owner in its baseScopes (services/auth.ts). A staff API key
   * holding just driftstack_internal_admin threw ForbiddenError on every key,
   * and deleteAccount discards reclaim errors, so termination reported success
   * having revoked nothing. The guarantee must not depend on which credential
   * type the operator happened to use.
   */
  async revokeAllForAccount(ctx: AccountContext, accountId: string): Promise<number> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    const keys = await this.repo.listApiKeys(accountId);
    let n = 0;
    for (const key of keys) {
      if (key.revokedAt !== null) continue;
      if (await this.revokeChecked(ctx, key.id, accountId)) n++;
    }
    return n;
  }

  /**
   * V-727 — revoke the keys this account minted on OTHER accounts.
   *
   * {@link revokeAllForAccount} filters on `account_id`, so it reclaims the
   * credentials ON an account and misses every key that account created on
   * someone else's workspace. Those authenticate as the OWNER and never
   * re-check the minter, so terminating a team member's account left their
   * credential live on the owner — the same hole V-726 closed for the removal
   * path, reached by a different door.
   */
  async revokeAllMintedByAccount(ctx: AccountContext, minterAccountId: string): Promise<number> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    const keys = await this.repo.listApiKeysMintedBy(minterAccountId);
    let n = 0;
    for (const key of keys) {
      if (key.revokedAt !== null) continue;
      // Scoped to the key's OWN account, which is the owner's — not the
      // minter's — because that is the account the row belongs to.
      if (await this.revokeChecked(ctx, key.id, key.accountId)) n++;
    }
    return n;
  }
}
