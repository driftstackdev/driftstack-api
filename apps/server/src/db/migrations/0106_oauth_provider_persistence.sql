-- Persistent third-party OAuth 2.0 provider state. This is distinct from
-- account_oauth_links, which stores Google/GitHub sign-in identities.
-- Client secrets, pending-authorization handles, authorization codes and
-- access tokens are stored only as SHA-256 digests; plaintext exists only at
-- issuance and request boundaries.
CREATE TABLE "oauth_clients" (
  "client_id" text PRIMARY KEY NOT NULL,
  "client_secret_hash" text NOT NULL,
  "redirect_uris" text[] NOT NULL,
  "label" text NOT NULL,
  "account_id" uuid,
  "created_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  CONSTRAINT "oauth_clients_secret_hash_check"
    CHECK ("client_secret_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "oauth_clients_account_id_accounts_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id")
    ON DELETE CASCADE
);

CREATE INDEX "oauth_clients_account_idx" ON "oauth_clients" ("account_id");

CREATE TABLE "oauth_authorizations" (
  "authorization_hash" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "state" text NOT NULL,
  "scopes" api_key_scope[] NOT NULL,
  "code_challenge" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "oauth_authorizations_hash_check"
    CHECK ("authorization_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "oauth_authorizations_client_id_oauth_clients_client_id_fk"
    FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id")
    ON DELETE CASCADE
);

CREATE INDEX "oauth_authorizations_client_idx" ON "oauth_authorizations" ("client_id");
CREATE INDEX "oauth_authorizations_created_idx" ON "oauth_authorizations" ("created_at");

CREATE TABLE "oauth_authorization_codes" (
  "code_hash" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "state" text NOT NULL,
  "scopes" api_key_scope[] NOT NULL,
  "code_challenge" text NOT NULL,
  "account_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  CONSTRAINT "oauth_authorization_codes_hash_check"
    CHECK ("code_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "oauth_authorization_codes_client_id_oauth_clients_client_id_fk"
    FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id")
    ON DELETE CASCADE,
  CONSTRAINT "oauth_authorization_codes_account_id_accounts_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id")
    ON DELETE CASCADE
);

CREATE INDEX "oauth_authorization_codes_client_idx" ON "oauth_authorization_codes" ("client_id");
CREATE INDEX "oauth_authorization_codes_account_idx" ON "oauth_authorization_codes" ("account_id");
CREATE INDEX "oauth_authorization_codes_created_idx" ON "oauth_authorization_codes" ("created_at");

CREATE TABLE "oauth_access_tokens" (
  "id" uuid PRIMARY KEY NOT NULL,
  "token_hash" text NOT NULL,
  "client_id" text NOT NULL,
  "account_id" uuid NOT NULL,
  "scopes" api_key_scope[] NOT NULL,
  "created_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  CONSTRAINT "oauth_access_tokens_hash_check"
    CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "oauth_access_tokens_id_api_keys_id_fk"
    FOREIGN KEY ("id") REFERENCES "public"."api_keys"("id")
    ON DELETE CASCADE,
  CONSTRAINT "oauth_access_tokens_client_id_oauth_clients_client_id_fk"
    FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id")
    ON DELETE CASCADE,
  CONSTRAINT "oauth_access_tokens_account_id_accounts_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id")
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX "oauth_access_tokens_hash_unique" ON "oauth_access_tokens" ("token_hash");
CREATE INDEX "oauth_access_tokens_client_idx" ON "oauth_access_tokens" ("client_id");
CREATE INDEX "oauth_access_tokens_account_idx" ON "oauth_access_tokens" ("account_id");
CREATE INDEX "oauth_access_tokens_expires_idx" ON "oauth_access_tokens" ("expires_at");
