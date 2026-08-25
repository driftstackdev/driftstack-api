// V-667.C — content-parity drift-guard for db/oauth-links-repo.ts.
// Critical pins: the Drizzle bindings must (a) map providerSub
// + provider in the unique-index order, (b) gate
// findActiveByTokenHash on isNull(consumedAt) + gt(expiresAt, now)
// so consumed/expired rows are filtered server-side, (c) gate
// markConsumedAt with isNull(consumedAt) so the second consume is a
// no-op (single-use enforcement at the SQL level, not just the
// service layer).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SRC = resolve(REPO_ROOT, 'apps/server/src/db/oauth-links-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('V-667.C db/oauth-links-repo content parity', () => {
  const body = read(SRC);

  it('V-667.C anchor + table-map framing pinned', () => {
    expect(body).toMatch(/V-667\.C — Drizzle-backed implementation of OAuthLinksRepo \+/);
    expect(body).toMatch(/OAuthPendingLinksRepo\. Maps the in-memory contracts from/);
    expect(body).toMatch(/services\/oauth-client\.ts onto the account_oauth_links \+/);
    expect(body).toMatch(/oauth_pending_links tables landed in migration 0039\./);
  });

  it('toLinkRow narrows provider column to OAuthClientProvider (not raw string)', () => {
    expect(body).toMatch(/provider: r\.provider as OAuthClientProvider,/);
  });

  it('findByProviderSub composite where on (provider, providerSub) in that order', () => {
    expect(body).toMatch(
      /\.where\(\s*and\(\s*eq\(accountOauthLinks\.provider, provider\),\s*eq\(accountOauthLinks\.providerSub, providerSub\),\s*\),\s*\)\s*\.limit\(1\)/,
    );
  });

  it('markLoginAt also bumps updatedAt — keeps the updated_at column live for audit-by-recency queries', () => {
    expect(body).toMatch(/markLoginAt\(id: string, at: Date\): Promise<void>/);
    expect(body).toMatch(/\.set\(\{ lastLoginAt: at, updatedAt: at \}\)/);
  });

  it('markRevokedAt is the Verdict 2 graceful-fallback marker — also bumps updatedAt', () => {
    expect(body).toMatch(/markRevokedAt\(id: string, at: Date\): Promise<void>/);
    expect(body).toMatch(/\.set\(\{ lastRevokedAt: at, updatedAt: at \}\)/);
  });

  it('findActiveByTokenHash composite where filters consumed + expired SERVER-SIDE (not service layer)', () => {
    expect(body).toMatch(
      /and\(\s*eq\(oauthPendingLinks\.tokenHash, tokenHash\),\s*isNull\(oauthPendingLinks\.consumedAt\),\s*gt\(oauthPendingLinks\.expiresAt, now\),\s*\)/,
    );
  });

  it('markConsumedAt where gates on isNull(consumedAt) for SQL-level single-use enforcement', () => {
    expect(body).toMatch(
      /\.where\(and\(eq\(oauthPendingLinks\.id, id\), isNull\(oauthPendingLinks\.consumedAt\)\)\)/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(SRC)).toBe(true);
  });
});
