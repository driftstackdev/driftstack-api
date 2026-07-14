import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../');
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');

describe('production OAuth provider persistence + API-auth wiring', () => {
  const bootstrap = read('src/lib/bootstrap.ts');
  const app = read('src/lib/app.ts');
  const middleware = read('src/middleware/auth.ts');
  const auth = read('src/services/auth.ts');
  const migration = read('src/db/migrations/0106_oauth_provider_persistence.sql');
  const store = read('src/db/oauth-store.ts');
  const e2eHelper = read('tests/e2e/helpers/server.ts');

  it('constructs one Drizzle store in production and passes it to routes + central auth', () => {
    expect(bootstrap).toMatch(/import \{ DrizzleOAuthStore \} from '\.\.\/db\/oauth-store\.js';/);
    expect(bootstrap).toMatch(/const oauthStore = new DrizzleOAuthStore\(dbHandle\);/);
    expect(bootstrap).toMatch(/negativeAuthCache,\s*\n\s*oauthStore,/);
    expect(bootstrap).not.toContain('InMemoryOAuthStore');

    expect(app).toMatch(/oauthStore\?: OAuthStore;/);
    expect(app).toMatch(/oauthStore: deps\.oauthStore/);
    expect(app).toMatch(/if \(deps\.oauthStore !== undefined\) \{/);
    expect(app).toMatch(/service: new OAuthService\(deps\.oauthStore\)/);

    expect(middleware).toMatch(/oauthStore\?: OAuthStore \| null;/);
    expect(middleware.match(/opts\.oauthStore \?\? null/g)).toHaveLength(2);
    expect(auth).toMatch(/if \(plaintext\.startsWith\('oat_'\)\) \{/);
    expect(auth).toMatch(/store\.findTokenForAuthentication\(plaintext, now\.getTime\(\)\)/);
  });

  it('stores only one-way digests and preserves established actor foreign keys', () => {
    expect(migration).toContain('CREATE TABLE "oauth_clients"');
    expect(migration).toContain('CREATE TABLE "oauth_authorizations"');
    expect(migration).toContain('CREATE TABLE "oauth_authorization_codes"');
    expect(migration).toContain('CREATE TABLE "oauth_access_tokens"');
    expect(migration).toContain('"authorization_hash" text PRIMARY KEY NOT NULL');
    expect(migration).toContain('"code_hash" text PRIMARY KEY NOT NULL');
    expect(migration).toContain('"token_hash" text NOT NULL');
    expect(migration).not.toMatch(/"authorization_id" text/);
    expect(migration).not.toMatch(/"code" text/);
    expect(migration).not.toMatch(/"token" text/);
    expect(migration).not.toMatch(/"client_secret" text/);
    expect(migration).toContain('FOREIGN KEY ("id") REFERENCES "public"."api_keys"("id")');
    expect(migration).toMatch(
      /oauth_clients_account_id_accounts_id_fk"\s*\n\s*FOREIGN KEY \("account_id"\)[\s\S]*?ON DELETE CASCADE/,
    );
    expect(migration).not.toMatch(
      /oauth_clients_account_id_accounts_id_fk"[\s\S]*?ON DELETE SET NULL/,
    );

    expect(store).toMatch(/authorizationHash: sha256Hex\(authorization\.authorization_id\)/);
    expect(store).toMatch(/codeHash: sha256Hex\(args\.code\)/);
    expect(store).toMatch(/consumeAuthorizationForCode[\s\S]*database\.db\.transaction/);
    expect(store).toMatch(/client\.accountId !== null && client\.accountId !== args\.account_id/);
    expect(store).toMatch(/consumeCodeForToken[\s\S]*database\.db\.transaction/);
    expect(store).toMatch(/const tokenHash = sha256Hex\(args\.token\.token\);/);
    expect(store).toMatch(/provenance: 'oauth'/);
    expect(store).toMatch(/\.innerJoin\(\s*oauthClients,/);
    expect(store).toMatch(/\.innerJoin\(\s*apiKeys,/);
  });

  it('uses the production-equivalent store in real Postgres/Redis e2e', () => {
    expect(e2eHelper).toMatch(
      /import \{ DrizzleOAuthStore \} from '\.\.\/\.\.\/\.\.\/src\/db\/oauth-store\.js';/,
    );
    expect(e2eHelper).toMatch(/const oauthStore = new DrizzleOAuthStore\(database\);/);
    expect(e2eHelper).not.toContain('InMemoryOAuthStore');
    expect(e2eHelper).not.toContain('oauthStore.resetForTest');
  });
});
