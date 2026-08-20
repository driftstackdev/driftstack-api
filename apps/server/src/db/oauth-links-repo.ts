// V-667.C — Drizzle-backed implementation of OAuthLinksRepo +
// OAuthPendingLinksRepo. Maps the in-memory contracts from
// services/oauth-client.ts onto the account_oauth_links +
// oauth_pending_links tables landed in migration 0039.

import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from './client.js';
import { accountOauthLinks, oauthPendingLinks } from './schema.js';
import type {
  InsertOAuthLinkInput,
  InsertPendingLinkInput,
  OAuthLinkRow,
  OAuthLinksRepo,
  OAuthPendingLinkRow,
  OAuthPendingLinksRepo,
} from '../services/oauth-client.js';
import type { OAuthClientProvider } from '../lib/oauth-client-providers.js';

function toLinkRow(r: typeof accountOauthLinks.$inferSelect): OAuthLinkRow {
  return {
    id: r.id,
    accountId: r.accountId,
    provider: r.provider as OAuthClientProvider,
    providerSub: r.providerSub,
    providerEmail: r.providerEmail,
    providerName: r.providerName,
    providerAvatarUrl: r.providerAvatarUrl,
    linkedAt: r.linkedAt,
    lastLoginAt: r.lastLoginAt,
    lastRevokedAt: r.lastRevokedAt,
  };
}

function toPendingRow(r: typeof oauthPendingLinks.$inferSelect): OAuthPendingLinkRow {
  return {
    id: r.id,
    accountId: r.accountId,
    provider: r.provider as OAuthClientProvider,
    providerSub: r.providerSub,
    providerEmail: r.providerEmail,
    providerName: r.providerName,
    providerAvatarUrl: r.providerAvatarUrl,
    tokenHash: r.tokenHash,
    expiresAt: r.expiresAt,
    consumedAt: r.consumedAt,
    createdAt: r.createdAt,
  };
}

export class DrizzleOAuthLinksRepo implements OAuthLinksRepo {
  constructor(private readonly database: Database) {}

  async findByProviderSub(
    provider: OAuthClientProvider,
    providerSub: string,
  ): Promise<OAuthLinkRow | null> {
    const [row] = await this.database.db
      .select()
      .from(accountOauthLinks)
      .where(
        and(
          eq(accountOauthLinks.provider, provider),
          eq(accountOauthLinks.providerSub, providerSub),
        ),
      )
      .limit(1);
    return row ? toLinkRow(row) : null;
  }

  async listForAccount(accountId: string): Promise<readonly OAuthLinkRow[]> {
    const rows = await this.database.db
      .select()
      .from(accountOauthLinks)
      .where(eq(accountOauthLinks.accountId, accountId))
      // The dashboard's "Connected accounts" list renders this order directly, and
      // `?active_only=false` audit views render the revoked history with it. Without an
      // ORDER BY the rows arrive in whatever order the scan produces, so the same account
      // can see its links in a different order on each load. `id` breaks ties so two links
      // made in the same instant still order deterministically.
      .orderBy(asc(accountOauthLinks.linkedAt), asc(accountOauthLinks.id));
    return rows.map(toLinkRow);
  }

  async insertLink(input: InsertOAuthLinkInput): Promise<OAuthLinkRow> {
    const [row] = await this.database.db
      .insert(accountOauthLinks)
      .values({
        accountId: input.accountId,
        provider: input.provider,
        providerSub: input.providerSub,
        providerEmail: input.providerEmail,
        providerName: input.providerName,
        providerAvatarUrl: input.providerAvatarUrl,
      })
      .returning();
    if (!row) throw new Error('insertLink: insert returned no row');
    return toLinkRow(row);
  }

  async markLoginAt(id: string, at: Date): Promise<void> {
    await this.database.db
      .update(accountOauthLinks)
      .set({ lastLoginAt: at, updatedAt: at })
      .where(eq(accountOauthLinks.id, id));
  }

  async markRevokedAt(id: string, at: Date): Promise<void> {
    await this.database.db
      .update(accountOauthLinks)
      .set({ lastRevokedAt: at, updatedAt: at })
      .where(eq(accountOauthLinks.id, id));
  }
}

export class DrizzleOAuthPendingLinksRepo implements OAuthPendingLinksRepo {
  constructor(private readonly database: Database) {}

  async insertPending(input: InsertPendingLinkInput): Promise<OAuthPendingLinkRow> {
    const [row] = await this.database.db
      .insert(oauthPendingLinks)
      .values({
        accountId: input.accountId,
        provider: input.provider,
        providerSub: input.providerSub,
        providerEmail: input.providerEmail,
        providerName: input.providerName,
        providerAvatarUrl: input.providerAvatarUrl,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      })
      .returning();
    if (!row) throw new Error('insertPending: insert returned no row');
    return toPendingRow(row);
  }

  async findActiveByTokenHash(tokenHash: string, now: Date): Promise<OAuthPendingLinkRow | null> {
    const [row] = await this.database.db
      .select()
      .from(oauthPendingLinks)
      .where(
        and(
          eq(oauthPendingLinks.tokenHash, tokenHash),
          isNull(oauthPendingLinks.consumedAt),
          gt(oauthPendingLinks.expiresAt, now),
        ),
      )
      .limit(1);
    return row ? toPendingRow(row) : null;
  }

  async markConsumedAt(id: string, at: Date): Promise<boolean> {
    // Conditional CAS: only the caller that flips consumedAt from NULL claims
    // the row. RETURNING lets confirmPendingLink gate link-creation on the win.
    const claimed = await this.database.db
      .update(oauthPendingLinks)
      .set({ consumedAt: at })
      .where(and(eq(oauthPendingLinks.id, id), isNull(oauthPendingLinks.consumedAt)))
      .returning({ id: oauthPendingLinks.id });
    return claimed.length > 0;
  }
}
