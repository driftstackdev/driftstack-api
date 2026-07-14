// V-667 — OAuth 2.0 authorization-code flow service (invite-only v1).
//
// Builds on V-488's PKCE primitives. The full third-party OAuth flow:
//
//   1. Admin uses /v1/admin/oauth/clients to register an OAuth client
//      (invite-only — no self-service signup v1). Returns a
//      `client_id` + `client_secret`.
//   2. Third-party app redirects the customer to GET /v1/oauth/authorize
//      with `client_id`, `redirect_uri`, `state`, `code_challenge`,
//      `code_challenge_method=S256`, `scope`.
//   3. The dashboard renders an approval screen. After approval, the
//      dashboard POSTs /v1/oauth/authorize/complete which calls
//      `OAuthService.approveAuthorization`.
//   4. Customer is redirected back to the third-party app with `code`
//      + `state` query params.
//   5. The app POSTs /v1/oauth/token with `code`, `code_verifier`,
//      `client_id`, `client_secret`. Returns an opaque access token.
//
// Tokens are OPAQUE bearer strings (no JWT — D-2026-05-10-01 decision).
// They use dedicated client-authenticated introspection and revocation
// endpoints, and their scopes are a subset of `ApiKeyScope`. No refresh
// tokens v1 — the third-party re-prompts the customer if their access
// token expires.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApiKeyScope } from '@driftstack/api-types';
import { verifyS256Challenge } from '../lib/oauth-pkce.js';
import { scopesSatisfy } from '../lib/errors-helpers.js';

const CODE_TTL_SECONDS = 5 * 60;

// Exact third-party scope surface published to integrators. This is an
// allowlist rather than a privileged-scope denylist: newly added API-key
// scopes and deprecated broad aliases must never become OAuth-authorizable by
// accident. Granted scope = requested ∩ this set ∩ approver authority.
const OAUTH_ALLOWED_SCOPES: ReadonlySet<ApiKeyScope> = new Set([
  'read:sessions',
  'write:sessions',
  'read:profiles',
  'write:profiles',
  'admin:profiles',
  'read:webhooks',
  'write:webhooks',
  'admin:webhooks',
  'read:api-keys',
  'admin:api-keys',
  'read:billing',
  'admin:billing',
  'read:audit',
] as ApiKeyScope[]);
const TOKEN_TTL_SECONDS = 60 * 60; // 1 hour — short by design; no refresh tokens.

export interface OAuthClient {
  client_id: string;
  /** sha256 hex of the secret — never the secret itself in the store. */
  client_secret_hash: string;
  /** Allowed redirect URIs. Exact-match check on /authorize. */
  redirect_uris: readonly string[];
  /** Human-readable label for the admin console. */
  label: string;
  /** Account that the admin registered this client on behalf of (if any). */
  account_id: string | null;
  created_at: number;
  /** Soft-deleted clients reject authorize, token, introspection, and revocation. */
  revoked_at: number | null;
}

export interface AuthorizationCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  state: string;
  scope: readonly ApiKeyScope[];
  code_challenge: string;
  /** Account that approved the authorization. */
  account_id: string;
  created_at: number;
  /** Once-only: set on exchange. Second exchange returns invalid_grant. */
  consumed_at: number | null;
}

export interface PendingAuthorization {
  authorization_id: string;
  client_id: string;
  redirect_uri: string;
  state: string;
  scope: readonly ApiKeyScope[];
  code_challenge: string;
  created_at: number;
}

export interface AccessToken {
  /** UUID of the backing api_keys authority row (persistent stores). */
  api_key_id?: string;
  token: string;
  client_id: string;
  account_id: string;
  scope: readonly ApiKeyScope[];
  created_at: number;
  expires_at: number;
}

export interface OAuthStore {
  // Clients
  insertClient(client: OAuthClient): Promise<void>;
  getClient(client_id: string): Promise<OAuthClient | null>;
  listClients(): Promise<readonly OAuthClient[]>;
  revokeClient(client_id: string, at: number): Promise<void>;
  /**
   * V-667.E — atomically swap `client_secret_hash` only while the client
   * exists and remains unrevoked. Return true iff this call changed the
   * active row. A persistent implementation must make the revoked-at check
   * part of the same conditional UPDATE as the hash swap so a concurrent
   * revoke cannot authorize a successor secret from a stale read. Existing
   * access tokens stay bearer-valid; the successor secret is required for
   * later introspection and revocation as well as token exchange.
   */
  rotateClientSecretHash(client_id: string, new_hash: string): Promise<boolean>;
  // Pending browser consent. Approval reads the immutable pending row, then
  // atomically replaces it with exactly one authorization code. The database
  // transaction means a crash can neither lose accepted consent nor mint two
  // codes from parallel submits.
  insertAuthorization(authorization: PendingAuthorization): Promise<void>;
  getAuthorization(authorization_id: string): Promise<PendingAuthorization | null>;
  consumeAuthorizationForCode(args: {
    authorization_id: string;
    code: string;
    account_id: string;
    scope: readonly ApiKeyScope[];
    created_at: number;
    not_before: number;
  }): Promise<'inserted' | 'expired' | 'unavailable' | 'client_unavailable' | 'account_mismatch'>;
  // Authorization codes
  getCode(code: string): Promise<AuthorizationCode | null>;
  /**
   * Atomically consume one code, revalidate the exact live client authority,
   * and insert both the backing API-key authority and OAuth token. A persistent
   * implementation performs all four changes in one transaction. Therefore a
   * crash cannot burn a valid code without returning a token, parallel exchanges
   * cannot both win, and concurrent revoke/rotation cannot mint stale authority.
   */
  consumeCodeForToken(args: {
    code: string;
    consumed_at: number;
    token: AccessToken;
    expectedClientSecretHash: string;
  }): Promise<'inserted' | 'code_unavailable' | 'client_authority_changed'>;
  // Access tokens
  getToken(token: string): Promise<AccessToken | null>;
  revokeToken(token: string): Promise<void>;
  /**
   * Resolve one bearer token against both token and client authority. The
   * persistent implementation performs one joined query over an unrevoked,
   * unexpired token and an unrevoked client; raw token material is hashed
   * before lookup. Central API authentication intentionally does not cache
   * this result, so revocation is authoritative on the next request.
   */
  findTokenForAuthentication(token: string, now: number): Promise<AccessToken | null>;
}

export class InMemoryOAuthStore implements OAuthStore {
  private readonly clients = new Map<string, OAuthClient>();
  private readonly authorizations = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly tokens = new Map<string, AccessToken>();

  /**
   * Test-only state flush for isolated in-memory suites. Real e2e and
   * production use DrizzleOAuthStore and reset through database lifecycle;
   * no production path can wipe provider authority mid-run.
   */
  resetForTest(): void {
    this.clients.clear();
    this.authorizations.clear();
    this.codes.clear();
    this.tokens.clear();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async insertClient(c: OAuthClient): Promise<void> {
    this.clients.set(c.client_id, c);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async getClient(id: string): Promise<OAuthClient | null> {
    return this.clients.get(id) ?? null;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async listClients(): Promise<readonly OAuthClient[]> {
    return [...this.clients.values()];
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async rotateClientSecretHash(id: string, new_hash: string): Promise<boolean> {
    const c = this.clients.get(id);
    if (c === undefined || c.revoked_at !== null) return false;
    this.clients.set(id, { ...c, client_secret_hash: new_hash });
    return true;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async revokeClient(id: string, at: number): Promise<void> {
    const c = this.clients.get(id);
    if (c === undefined) return;
    this.clients.set(id, { ...c, revoked_at: at });
    for (const [token, authority] of this.tokens) {
      if (authority.client_id === id) this.tokens.delete(token);
    }
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async insertAuthorization(authorization: PendingAuthorization): Promise<void> {
    this.authorizations.set(authorization.authorization_id, authorization);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async getAuthorization(authorization_id: string): Promise<PendingAuthorization | null> {
    return this.authorizations.get(authorization_id) ?? null;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async getCode(code: string): Promise<AuthorizationCode | null> {
    const c = this.codes.get(code);
    if (c === undefined) return null;
    if (Date.now() - c.created_at > CODE_TTL_SECONDS * 1000) {
      this.codes.delete(code);
      return null;
    }
    return c;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async consumeAuthorizationForCode(args: {
    authorization_id: string;
    code: string;
    account_id: string;
    scope: readonly ApiKeyScope[];
    created_at: number;
    not_before: number;
  }): Promise<'inserted' | 'expired' | 'unavailable' | 'client_unavailable' | 'account_mismatch'> {
    const authorization = this.authorizations.get(args.authorization_id);
    if (authorization === undefined) return 'unavailable';
    const client = this.clients.get(authorization.client_id);
    if (client === undefined || client.revoked_at !== null) return 'client_unavailable';
    if (client.account_id !== null && client.account_id !== args.account_id) {
      return 'account_mismatch';
    }
    this.authorizations.delete(args.authorization_id);
    if (authorization.created_at < args.not_before) return 'expired';
    this.codes.set(args.code, {
      code: args.code,
      client_id: authorization.client_id,
      redirect_uri: authorization.redirect_uri,
      state: authorization.state,
      scope: args.scope,
      code_challenge: authorization.code_challenge,
      account_id: args.account_id,
      created_at: args.created_at,
      consumed_at: null,
    });
    return 'inserted';
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async consumeCodeForToken(args: {
    code: string;
    consumed_at: number;
    token: AccessToken;
    expectedClientSecretHash: string;
  }): Promise<'inserted' | 'code_unavailable' | 'client_authority_changed'> {
    // No await occurs between any read and write in this test-only store, so
    // this models the production transaction's indivisible commit.
    const code = this.codes.get(args.code);
    if (
      code === undefined ||
      code.consumed_at !== null ||
      code.client_id !== args.token.client_id ||
      code.account_id !== args.token.account_id
    ) {
      return 'code_unavailable';
    }
    const client = this.clients.get(args.token.client_id);
    if (
      client === undefined ||
      client.revoked_at !== null ||
      (client.account_id !== null && client.account_id !== args.token.account_id) ||
      !constantTimeStringEqual(client.client_secret_hash, args.expectedClientSecretHash)
    ) {
      return 'client_authority_changed';
    }
    this.codes.set(args.code, { ...code, consumed_at: args.consumed_at });
    this.tokens.set(args.token.token, {
      ...args.token,
      api_key_id: args.token.api_key_id ?? oauthCredentialId(args.token.token),
    });
    return 'inserted';
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async getToken(token: string): Promise<AccessToken | null> {
    const t = this.tokens.get(token);
    if (t === undefined) return null;
    if (Date.now() > t.expires_at) {
      this.tokens.delete(token);
      return null;
    }
    return t;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async revokeToken(token: string): Promise<void> {
    this.tokens.delete(token);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async findTokenForAuthentication(token: string, now: number): Promise<AccessToken | null> {
    const accessToken = this.tokens.get(token);
    if (accessToken === undefined || accessToken.expires_at <= now) return null;
    const client = this.clients.get(accessToken.client_id);
    if (client === undefined || client.revoked_at !== null) return null;
    return accessToken;
  }
}

export class OAuthError extends Error {
  constructor(
    public readonly code:
      | 'invalid_client'
      | 'invalid_request'
      | 'unauthorized_client'
      | 'access_denied'
      | 'invalid_grant'
      | 'invalid_scope',
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export interface RegisterClientArgs {
  label: string;
  redirect_uris: readonly string[];
  account_id?: string | null;
}

export interface RegisterClientResult {
  client_id: string;
  /** Plaintext — surfaced ONCE on registration. The store keeps only the hash. */
  client_secret: string;
}

export interface AuthorizeArgs {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: 'S256';
  scope: readonly ApiKeyScope[];
}

export interface AuthorizeResult {
  /** Identifier the dashboard uses to fetch authorization context for the approval screen. */
  authorization_id: string;
  client: { client_id: string; label: string };
  scope: readonly ApiKeyScope[];
  redirect_uri: string;
  state: string;
}

export interface ApproveAuthorizationArgs {
  authorization_id: string;
  account_id: string;
  // The approving caller's own scopes (the route always passes these). The granted
  // code/token scope is restricted to the exact third-party allowlist intersected with
  // the approver's authority. When omitted, the allowlist still applies (only the
  // approver-authority intersection is skipped for isolated service fixtures).
  approverScopes?: readonly ApiKeyScope[];
}

export interface ApproveAuthorizationResult {
  code: string;
  redirect_uri: string;
  state: string;
}

export interface ExchangeCodeArgs {
  code: string;
  code_verifier: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
}

export interface ExchangeCodeResult {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: readonly ApiKeyScope[];
}

export interface OAuthClientCredentials {
  client_id: string;
  client_secret: string;
}

export interface ClientTokenArgs extends OAuthClientCredentials {
  token: string;
}

export class OAuthService {
  constructor(
    private readonly store: OAuthStore,
    private readonly nowFn: () => number = () => Date.now(),
    private readonly secretHasher: (s: string) => string = sha256Hex,
  ) {}

  async registerClient(args: RegisterClientArgs): Promise<RegisterClientResult> {
    if (!args.label.trim()) throw new OAuthError('invalid_request', 'label required');
    if (args.redirect_uris.length === 0) {
      throw new OAuthError('invalid_request', 'at least one redirect_uri required');
    }
    for (const uri of args.redirect_uris) {
      // Lock-down: HTTPS only, except localhost. Mirrors RFC 8252 native-app guidance.
      if (!isAllowedRedirectUri(uri)) {
        throw new OAuthError('invalid_request', `redirect_uri rejected: ${uri}`);
      }
    }
    const client_id = `oac_${randomBytes(12).toString('base64url')}`;
    const client_secret = `oas_${randomBytes(32).toString('base64url')}`;
    await this.store.insertClient({
      client_id,
      client_secret_hash: this.secretHasher(client_secret),
      redirect_uris: [...args.redirect_uris],
      label: args.label,
      account_id: args.account_id ?? null,
      created_at: this.nowFn(),
      revoked_at: null,
    });
    return { client_id, client_secret };
  }

  async listClients(): Promise<readonly OAuthClient[]> {
    return this.store.listClients();
  }

  /**
   * V-667.D — admin lookup by client_id. Returns null if the client
   * doesn't exist; routes turn that into a 404. Returns revoked
   * clients as-is so ops can audit them.
   */
  async getClient(client_id: string): Promise<OAuthClient | null> {
    return this.store.getClient(client_id);
  }

  async revokeClient(client_id: string): Promise<void> {
    await this.store.revokeClient(client_id, this.nowFn());
  }

  /**
   * V-667.E — rotate the client_secret in place. Returns the NEW
   * plaintext (shown ONCE — the store keeps only the hash). The
   * client_id stays the same so existing redirect URIs + customer
   * consent records carry over. Existing access tokens remain bearer-
   * valid, but the successor secret is required to introspect or revoke
   * them through the public client-authenticated endpoints.
   *
   * Errors:
   *   - invalid_client: client_id not found OR client is revoked
   *     (rotating a revoked client's secret would be a footgun —
   *     better to register a fresh one).
   */
  async rotateClientSecret(client_id: string): Promise<{ client_secret: string }> {
    const client_secret = `oas_${randomBytes(32).toString('base64url')}`;
    const rotated = await this.store.rotateClientSecretHash(
      client_id,
      this.secretHasher(client_secret),
    );
    if (!rotated) throw new OAuthError('invalid_client', 'unknown or revoked client_id');
    return { client_secret };
  }

  async authorize(args: AuthorizeArgs): Promise<AuthorizeResult> {
    if (args.code_challenge_method !== 'S256') {
      throw new OAuthError('invalid_request', 'only S256 PKCE is supported');
    }
    if (args.scope.some((scope) => !OAUTH_ALLOWED_SCOPES.has(scope))) {
      throw new OAuthError('invalid_scope', 'scope is not available to OAuth clients');
    }
    const client = await this.store.getClient(args.client_id);
    if (client === null || client.revoked_at !== null) {
      throw new OAuthError('invalid_client', 'unknown or revoked client_id');
    }
    if (!client.redirect_uris.includes(args.redirect_uri)) {
      throw new OAuthError('invalid_request', 'redirect_uri not registered');
    }
    // Persist the pending authorization; the dashboard exchanges its
    // one-time authorization_id through approveAuthorization. Persistent
    // storage keeps this flow valid across restarts and API replicas.
    const authorization_id = `oaa_${randomBytes(16).toString('base64url')}`;
    await this.store.insertAuthorization({
      authorization_id,
      client_id: args.client_id,
      redirect_uri: args.redirect_uri,
      state: args.state,
      scope: [...args.scope],
      code_challenge: args.code_challenge,
      created_at: this.nowFn(),
    });
    return {
      authorization_id,
      client: { client_id: client.client_id, label: client.label },
      scope: args.scope,
      redirect_uri: args.redirect_uri,
      state: args.state,
    };
  }

  async approveAuthorization(args: ApproveAuthorizationArgs): Promise<ApproveAuthorizationResult> {
    const pending = await this.store.getAuthorization(args.authorization_id);
    if (pending === null) {
      throw new OAuthError('invalid_request', 'unknown or expired authorization_id');
    }
    if (this.nowFn() - pending.created_at > CODE_TTL_SECONDS * 1000) {
      throw new OAuthError('invalid_request', 'authorization expired before approval');
    }
    // SECURITY: retain the exact OAuth allowlist at approval as defense in depth,
    // then reduce through the canonical hierarchy so broad approver authority can
    // grant a matching granular scope without letting granular authority broaden.
    const approverScopes = args.approverScopes;
    const grantedScope = pending.scope.filter(
      (s) =>
        OAUTH_ALLOWED_SCOPES.has(s) &&
        (approverScopes === undefined || scopesSatisfy(approverScopes, s)),
    );
    const code = `oac_${randomBytes(32).toString('base64url')}`;
    const createdAt = this.nowFn();
    const committed = await this.store.consumeAuthorizationForCode({
      authorization_id: args.authorization_id,
      code,
      account_id: args.account_id,
      scope: grantedScope,
      created_at: createdAt,
      not_before: createdAt - CODE_TTL_SECONDS * 1000,
    });
    if (committed === 'expired') {
      throw new OAuthError('invalid_request', 'authorization expired before approval');
    }
    if (committed === 'unavailable') {
      throw new OAuthError('invalid_request', 'unknown or expired authorization_id');
    }
    if (committed === 'client_unavailable') {
      throw new OAuthError('invalid_client', 'unknown or revoked client_id');
    }
    if (committed === 'account_mismatch') {
      throw new OAuthError('access_denied', 'client is not registered for this account');
    }
    return { code, redirect_uri: pending.redirect_uri, state: pending.state };
  }

  async exchangeCode(args: ExchangeCodeArgs): Promise<ExchangeCodeResult> {
    const { client, presentedSecretHash } = await this.authenticateClient(args);
    const code = await this.store.getCode(args.code);
    if (code === null) throw new OAuthError('invalid_grant', 'code unknown or expired');
    if (code.consumed_at !== null) {
      throw new OAuthError('invalid_grant', 'code already exchanged');
    }
    if (code.client_id !== args.client_id) {
      throw new OAuthError('invalid_grant', 'code issued to a different client');
    }
    if (code.redirect_uri !== args.redirect_uri) {
      throw new OAuthError('invalid_grant', 'redirect_uri mismatch');
    }
    if (!verifyS256Challenge({ verifier: args.code_verifier, challenge: code.code_challenge })) {
      throw new OAuthError('invalid_grant', 'PKCE verification failed');
    }
    const token = `oat_${randomBytes(32).toString('base64url')}`;
    const now = this.nowFn();
    const committed = await this.store.consumeCodeForToken({
      code: args.code,
      consumed_at: now,
      token: {
        token,
        client_id: client.client_id,
        account_id: code.account_id,
        scope: code.scope,
        created_at: now,
        expires_at: now + TOKEN_TTL_SECONDS * 1000,
      },
      expectedClientSecretHash: presentedSecretHash,
    });
    if (committed === 'code_unavailable') {
      throw new OAuthError('invalid_grant', 'code already exchanged');
    }
    if (committed === 'client_authority_changed') {
      throw new OAuthError('invalid_client', 'unknown or revoked client_id');
    }
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_SECONDS,
      scope: code.scope,
    };
  }

  async introspect(token: string): Promise<AccessToken | null> {
    return this.store.getToken(token);
  }

  /**
   * RFC 7662 client-authenticated introspection. Authenticate before
   * looking up token material, then disclose metadata only when the
   * token was issued to that exact live client. Unknown and foreign
   * tokens intentionally share the minimal inactive response.
   */
  async introspectForClient(args: ClientTokenArgs): Promise<AccessToken | null> {
    const { client } = await this.authenticateClient(args);
    const token = await this.store.getToken(args.token);
    return token?.client_id === client.client_id ? token : null;
  }

  /**
   * V-667.C — RFC 7009 token revocation. Per the spec, the response
   * does not distinguish "valid token revoked" from "invalid token"
   * — both succeed silently so third-party clients can't probe token
   * existence by calling /revoke. The route layer always returns
   * 200; this method does the work and may safely no-op on an
   * unknown token.
   */
  async revokeToken(token: string): Promise<void> {
    await this.store.revokeToken(token);
  }

  /**
   * RFC 7009 client-authenticated revocation. A valid client may revoke
   * only its own token. Unknown and foreign tokens are silent no-ops so
   * the authorized response remains enumeration-resistant.
   */
  async revokeTokenForClient(args: ClientTokenArgs): Promise<void> {
    const { client } = await this.authenticateClient(args);
    const token = await this.store.getToken(args.token);
    if (token?.client_id === client.client_id) {
      await this.store.revokeToken(args.token);
    }
  }

  private async authenticateClient(
    credentials: OAuthClientCredentials,
  ): Promise<{ client: OAuthClient; presentedSecretHash: string }> {
    const presentedSecretHash = this.secretHasher(credentials.client_secret);
    const client = await this.store.getClient(credentials.client_id);

    // Always perform one equal-length timing-safe comparison after the
    // lookup. For an unknown client, comparing the presented digest with
    // itself supplies the same crypto primitive without inventing a
    // secret-dependent branch; the null check still rejects it.
    const expectedSecretHash = client?.client_secret_hash ?? presentedSecretHash;
    const secretMatches = constantTimeStringEqual(expectedSecretHash, presentedSecretHash);
    if (client === null || client.revoked_at !== null || !secretMatches) {
      throw new OAuthError('invalid_client', 'invalid client credentials');
    }
    return { client, presentedSecretHash };
  }
}

function oauthCredentialId(token: string): string {
  const digest = sha256Hex(token);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function isAllowedRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
