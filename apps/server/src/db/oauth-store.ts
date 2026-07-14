// PostgreSQL-backed third-party OAuth provider store.
//
// All externally presented authorization handles, codes and tokens are SHA-256
// hashed before database access. Access-token issuance also creates one backing api_keys authority
// row with the same UUID. That is not a second credential: its key_hash is the
// same one-way digest and its non-ds_ prefix can never enter API-key scrypt
// authentication. The row exists so established session/audit actor foreign
// keys remain truthful when an OAuth principal performs an authorized write.

import { timingSafeEqual } from 'node:crypto';
import type { ApiKeyScope } from '@driftstack/api-types';
import { and, eq, gt, inArray, isNull, lt, lte } from 'drizzle-orm';
import type {
  AccessToken,
  AuthorizationCode,
  OAuthClient,
  OAuthStore,
  PendingAuthorization,
  OAuthPruneResult,
} from '../services/oauth.js';
import { sha256Hex } from '../services/auth-cache.js';
import type { Database } from './client.js';
import {
  apiKeys,
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthAuthorizations,
  oauthClients,
} from './schema.js';

const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;

export class DrizzleOAuthStore implements OAuthStore {
  constructor(private readonly database: Database) {}

  async insertClient(client: OAuthClient): Promise<void> {
    await this.database.db.insert(oauthClients).values({
      clientId: client.client_id,
      clientSecretHash: client.client_secret_hash,
      redirectUris: [...client.redirect_uris],
      label: client.label,
      accountId: client.account_id,
      createdAt: new Date(client.created_at),
      revokedAt: client.revoked_at === null ? null : new Date(client.revoked_at),
    });
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    const [row] = await this.database.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .limit(1);
    return row === undefined ? null : toClient(row);
  }

  async listClients(): Promise<readonly OAuthClient[]> {
    const rows = await this.database.db.select().from(oauthClients).orderBy(oauthClients.createdAt);
    return rows.map(toClient);
  }

  async revokeClient(clientId: string, at: number): Promise<void> {
    const revokedAt = new Date(at);
    await this.database.db.transaction(async (tx) => {
      const [client] = await tx
        .select({ clientId: oauthClients.clientId })
        .from(oauthClients)
        .where(eq(oauthClients.clientId, clientId))
        .limit(1)
        .for('update');
      if (client === undefined) return;

      await tx
        .update(oauthClients)
        .set({ revokedAt })
        .where(and(eq(oauthClients.clientId, clientId), isNull(oauthClients.revokedAt)));
      const tokenRows = await tx
        .select({ id: oauthAccessTokens.id })
        .from(oauthAccessTokens)
        .where(eq(oauthAccessTokens.clientId, clientId));
      const ids = tokenRows.map((row) => row.id);
      if (ids.length > 0) {
        await tx
          .update(oauthAccessTokens)
          .set({ revokedAt })
          .where(
            and(eq(oauthAccessTokens.clientId, clientId), isNull(oauthAccessTokens.revokedAt)),
          );
        await tx
          .update(apiKeys)
          .set({ revokedAt })
          .where(and(inArray(apiKeys.id, ids), isNull(apiKeys.revokedAt)));
      }
    });
  }

  async rotateClientSecretHash(clientId: string, newHash: string): Promise<boolean> {
    const rows = await this.database.db
      .update(oauthClients)
      .set({ clientSecretHash: newHash })
      .where(and(eq(oauthClients.clientId, clientId), isNull(oauthClients.revokedAt)))
      .returning({ clientId: oauthClients.clientId });
    return rows.length === 1;
  }

  async insertAuthorization(authorization: PendingAuthorization): Promise<void> {
    await this.database.db.insert(oauthAuthorizations).values({
      authorizationHash: sha256Hex(authorization.authorization_id),
      clientId: authorization.client_id,
      redirectUri: authorization.redirect_uri,
      state: authorization.state,
      scopes: [...authorization.scope],
      codeChallenge: authorization.code_challenge,
      createdAt: new Date(authorization.created_at),
    });
  }

  async getAuthorization(authorizationId: string): Promise<PendingAuthorization | null> {
    const [row] = await this.database.db
      .select()
      .from(oauthAuthorizations)
      .where(eq(oauthAuthorizations.authorizationHash, sha256Hex(authorizationId)))
      .limit(1);
    if (row === undefined) return null;
    return {
      authorization_id: authorizationId,
      client_id: row.clientId,
      redirect_uri: row.redirectUri,
      state: row.state,
      scope: row.scopes,
      code_challenge: row.codeChallenge,
      created_at: row.createdAt.getTime(),
    };
  }

  async consumeAuthorizationForCode(args: {
    authorization_id: string;
    code: string;
    account_id: string;
    scope: readonly ApiKeyScope[];
    created_at: number;
    not_before: number;
  }): Promise<'inserted' | 'expired' | 'unavailable' | 'client_unavailable' | 'account_mismatch'> {
    return this.database.db.transaction(async (tx) => {
      const [authorization] = await tx
        .select()
        .from(oauthAuthorizations)
        .where(eq(oauthAuthorizations.authorizationHash, sha256Hex(args.authorization_id)))
        .limit(1)
        .for('update');
      if (authorization === undefined) return 'unavailable';
      if (authorization.createdAt.getTime() < args.not_before) {
        await tx
          .delete(oauthAuthorizations)
          .where(eq(oauthAuthorizations.authorizationHash, authorization.authorizationHash));
        return 'expired';
      }

      const [client] = await tx
        .select({ accountId: oauthClients.accountId, revokedAt: oauthClients.revokedAt })
        .from(oauthClients)
        .where(eq(oauthClients.clientId, authorization.clientId))
        .limit(1)
        .for('update');
      if (client === undefined || client.revokedAt !== null) return 'client_unavailable';
      if (client.accountId !== null && client.accountId !== args.account_id) {
        return 'account_mismatch';
      }

      await tx
        .delete(oauthAuthorizations)
        .where(eq(oauthAuthorizations.authorizationHash, authorization.authorizationHash));

      await tx.insert(oauthAuthorizationCodes).values({
        codeHash: sha256Hex(args.code),
        clientId: authorization.clientId,
        redirectUri: authorization.redirectUri,
        state: authorization.state,
        scopes: [...args.scope],
        codeChallenge: authorization.codeChallenge,
        accountId: args.account_id,
        createdAt: new Date(args.created_at),
      });
      return 'inserted';
    });
  }

  async getCode(code: string): Promise<AuthorizationCode | null> {
    const now = Date.now();
    const [row] = await this.database.db
      .select()
      .from(oauthAuthorizationCodes)
      .where(
        and(
          eq(oauthAuthorizationCodes.codeHash, sha256Hex(code)),
          gt(oauthAuthorizationCodes.createdAt, new Date(now - AUTHORIZATION_CODE_TTL_MS)),
        ),
      )
      .limit(1);
    if (row === undefined) return null;
    return {
      code,
      client_id: row.clientId,
      redirect_uri: row.redirectUri,
      state: row.state,
      scope: row.scopes,
      code_challenge: row.codeChallenge,
      account_id: row.accountId,
      created_at: row.createdAt.getTime(),
      consumed_at: row.consumedAt?.getTime() ?? null,
    };
  }

  async consumeCodeForToken(args: {
    code: string;
    consumed_at: number;
    token: AccessToken;
    expectedClientSecretHash: string;
  }): Promise<'inserted' | 'code_unavailable' | 'client_authority_changed'> {
    return this.database.db.transaction(async (tx) => {
      const [code] = await tx
        .select()
        .from(oauthAuthorizationCodes)
        .where(eq(oauthAuthorizationCodes.codeHash, sha256Hex(args.code)))
        .limit(1)
        .for('update');
      if (
        code === undefined ||
        code.consumedAt !== null ||
        code.clientId !== args.token.client_id ||
        code.accountId !== args.token.account_id ||
        code.createdAt.getTime() <= args.token.created_at - AUTHORIZATION_CODE_TTL_MS
      ) {
        return 'code_unavailable';
      }

      const [client] = await tx
        .select()
        .from(oauthClients)
        .where(eq(oauthClients.clientId, args.token.client_id))
        .limit(1)
        .for('update');
      if (
        client === undefined ||
        client.revokedAt !== null ||
        (client.accountId !== null && client.accountId !== args.token.account_id) ||
        !constantTimeHashEqual(client.clientSecretHash, args.expectedClientSecretHash)
      ) {
        return 'client_authority_changed';
      }

      const tokenHash = sha256Hex(args.token.token);
      const createdAt = new Date(args.token.created_at);
      const expiresAt = new Date(args.token.expires_at);
      const [authority] = await tx
        .insert(apiKeys)
        .values({
          accountId: args.token.account_id,
          name: `OAuth: ${client.label}`,
          keyPrefix: `oauth_${tokenHash.slice(0, 24)}`,
          keyHash: tokenHash,
          scopes: [...args.token.scope],
          expiresAt,
          provenance: 'oauth',
          createdAt,
        })
        .returning({ id: apiKeys.id });
      if (authority === undefined) throw new Error('OAuth authority insert returned no row');

      await tx.insert(oauthAccessTokens).values({
        id: authority.id,
        tokenHash,
        clientId: args.token.client_id,
        accountId: args.token.account_id,
        scopes: [...args.token.scope],
        createdAt,
        expiresAt,
      });
      await tx
        .update(oauthAuthorizationCodes)
        .set({ consumedAt: new Date(args.consumed_at) })
        .where(eq(oauthAuthorizationCodes.codeHash, code.codeHash));
      return 'inserted';
    });
  }

  async getToken(token: string): Promise<AccessToken | null> {
    return this.findLiveToken(token, new Date());
  }

  async revokeToken(token: string): Promise<void> {
    const at = new Date();
    await this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: oauthAccessTokens.id })
        .from(oauthAccessTokens)
        .where(eq(oauthAccessTokens.tokenHash, sha256Hex(token)))
        .limit(1)
        .for('update');
      if (row === undefined) return;
      await tx
        .update(oauthAccessTokens)
        .set({ revokedAt: at })
        .where(and(eq(oauthAccessTokens.id, row.id), isNull(oauthAccessTokens.revokedAt)));
      await tx
        .update(apiKeys)
        .set({ revokedAt: at })
        .where(and(eq(apiKeys.id, row.id), isNull(apiKeys.revokedAt)));
    });
  }

  async findTokenForAuthentication(token: string, now: number): Promise<AccessToken | null> {
    return this.findLiveToken(token, new Date(now));
  }

  private async findLiveToken(token: string, now: Date): Promise<AccessToken | null> {
    const [row] = await this.database.db
      .select({
        id: oauthAccessTokens.id,
        clientId: oauthAccessTokens.clientId,
        accountId: oauthAccessTokens.accountId,
        scopes: oauthAccessTokens.scopes,
        createdAt: oauthAccessTokens.createdAt,
        expiresAt: oauthAccessTokens.expiresAt,
      })
      .from(oauthAccessTokens)
      .innerJoin(
        oauthClients,
        and(eq(oauthClients.clientId, oauthAccessTokens.clientId), isNull(oauthClients.revokedAt)),
      )
      .innerJoin(
        apiKeys,
        and(
          eq(apiKeys.id, oauthAccessTokens.id),
          isNull(apiKeys.revokedAt),
          gt(apiKeys.expiresAt, now),
        ),
      )
      .where(
        and(
          eq(oauthAccessTokens.tokenHash, sha256Hex(token)),
          isNull(oauthAccessTokens.revokedAt),
          gt(oauthAccessTokens.expiresAt, now),
        ),
      )
      .limit(1);
    if (row === undefined) return null;
    return {
      api_key_id: row.id,
      token,
      client_id: row.clientId,
      account_id: row.accountId,
      scope: row.scopes,
      created_at: row.createdAt.getTime(),
      expires_at: row.expiresAt.getTime(),
    };
  }

  async pruneExpired(nowMs: number): Promise<OAuthPruneResult> {
    const now = new Date(nowMs);
    const codeCutoff = new Date(nowMs - AUTHORIZATION_CODE_TTL_MS);
    return this.database.db.transaction(async (tx) => {
      const authorizations = await tx
        .delete(oauthAuthorizations)
        .where(lt(oauthAuthorizations.createdAt, codeCutoff))
        .returning({ hash: oauthAuthorizations.authorizationHash });
      const codes = await tx
        .delete(oauthAuthorizationCodes)
        .where(lt(oauthAuthorizationCodes.createdAt, codeCutoff))
        .returning({ hash: oauthAuthorizationCodes.codeHash });
      // Delete only the provider token row. The backing api_keys row remains as
      // an expired actor identity for session/audit foreign-key integrity.
      const tokens = await tx
        .delete(oauthAccessTokens)
        .where(lte(oauthAccessTokens.expiresAt, now))
        .returning({ id: oauthAccessTokens.id });
      return {
        authorizations: authorizations.length,
        codes: codes.length,
        tokens: tokens.length,
      };
    });
  }
}

function toClient(row: typeof oauthClients.$inferSelect): OAuthClient {
  return {
    client_id: row.clientId,
    client_secret_hash: row.clientSecretHash,
    redirect_uris: row.redirectUris,
    label: row.label,
    account_id: row.accountId,
    created_at: row.createdAt.getTime(),
    revoked_at: row.revokedAt?.getTime() ?? null,
  };
}

function constantTimeHashEqual(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
