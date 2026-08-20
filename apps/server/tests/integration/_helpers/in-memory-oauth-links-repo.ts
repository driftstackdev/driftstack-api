// V-667.C — in-memory implementations of OAuthLinksRepo +
// OAuthPendingLinksRepo. Used in unit + integration tests so the
// service layer can be exercised without a live Postgres.

import { randomUUID } from 'node:crypto';
import type {
  InsertOAuthLinkInput,
  InsertPendingLinkInput,
  OAuthLinkRow,
  OAuthLinksRepo,
  OAuthPendingLinkRow,
  OAuthPendingLinksRepo,
} from '../../../src/services/oauth-client.js';

export class InMemoryOAuthLinksRepo implements OAuthLinksRepo {
  readonly rows: OAuthLinkRow[] = [];

  findByProviderSub(
    provider: OAuthLinkRow['provider'],
    providerSub: string,
  ): Promise<OAuthLinkRow | null> {
    const r = this.rows.find((x) => x.provider === provider && x.providerSub === providerSub);
    return Promise.resolve(r ?? null);
  }

  listForAccount(accountId: string): Promise<readonly OAuthLinkRow[]> {
    // V-1207 — mirrors DrizzleOAuthLinksRepo's `ORDER BY linked_at, id`. Returning insertion
    // order here agreed with the real repo only until the two orders differed, which is exactly
    // the kind of silent divergence the shared-interface contract test exists to catch: V-1201
    // gave the Drizzle side its ORDER BY and left this one behind.
    return Promise.resolve(
      this.rows
        .filter((x) => x.accountId === accountId)
        .sort((a, b) => a.linkedAt.getTime() - b.linkedAt.getTime() || a.id.localeCompare(b.id)),
    );
  }

  insertLink(input: InsertOAuthLinkInput): Promise<OAuthLinkRow> {
    const existing = this.rows.find(
      (x) => x.provider === input.provider && x.providerSub === input.providerSub,
    );
    if (existing) {
      return Promise.reject(
        new Error(`OAuthLink already exists for ${input.provider} sub=${input.providerSub}`),
      );
    }
    const row: OAuthLinkRow = {
      id: randomUUID(),
      accountId: input.accountId,
      provider: input.provider,
      providerSub: input.providerSub,
      providerEmail: input.providerEmail,
      providerName: input.providerName,
      providerAvatarUrl: input.providerAvatarUrl,
      linkedAt: new Date(),
      lastLoginAt: null,
      lastRevokedAt: null,
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  markLoginAt(id: string, at: Date): Promise<void> {
    const row = this.rows.find((x) => x.id === id);
    if (row) row.lastLoginAt = at;
    return Promise.resolve();
  }

  markRevokedAt(id: string, at: Date): Promise<void> {
    const row = this.rows.find((x) => x.id === id);
    if (row) row.lastRevokedAt = at;
    return Promise.resolve();
  }
}

export class InMemoryOAuthPendingLinksRepo implements OAuthPendingLinksRepo {
  readonly rows: OAuthPendingLinkRow[] = [];

  insertPending(input: InsertPendingLinkInput): Promise<OAuthPendingLinkRow> {
    const row: OAuthPendingLinkRow = {
      id: randomUUID(),
      accountId: input.accountId,
      provider: input.provider,
      providerSub: input.providerSub,
      providerEmail: input.providerEmail,
      providerName: input.providerName,
      providerAvatarUrl: input.providerAvatarUrl,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      consumedAt: null,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  findActiveByTokenHash(tokenHash: string, now: Date): Promise<OAuthPendingLinkRow | null> {
    const r = this.rows.find((x) => x.tokenHash === tokenHash);
    if (!r) return Promise.resolve(null);
    if (r.consumedAt !== null) return Promise.resolve(null);
    if (now > r.expiresAt) return Promise.resolve(null);
    return Promise.resolve(r);
  }

  markConsumedAt(id: string, at: Date): Promise<boolean> {
    const row = this.rows.find((x) => x.id === id);
    if (row && row.consumedAt === null) {
      row.consumedAt = at;
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }
}
