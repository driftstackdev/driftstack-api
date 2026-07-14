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
// They live in the same logical surface as API keys: introspection via
// the existing `/v1/api-keys/:id` shape, scopes are a subset of
// `ApiKeyScope`. No refresh tokens v1 — the third-party re-prompts the
// customer if their access token expires.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApiKeyScope } from '@driftstack/api-types';
import { verifyS256Challenge } from '../lib/oauth-pkce.js';
import { scopesSatisfy } from '../lib/errors-helpers.js';

const CODE_TTL_SECONDS = 5 * 60;

// Privileged scopes a third-party OAuth token must NEVER carry (full account / admin
// control). Granted scope = requested ∩ approver scopes, minus these.
const OAUTH_DENY_SCOPES: ReadonlySet<ApiKeyScope> = new Set([
  'account_owner',
  'driftstack_internal_admin',
  'admin',
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
  /** Soft-deleted clients reject /authorize + /token. */
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

export interface AccessToken {
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
   * access tokens stay valid (they're bearer-authenticated; the secret is
   * consulted only on /token exchange).
   */
  rotateClientSecretHash(client_id: string, new_hash: string): Promise<boolean>;
  // Authorization codes
  insertCode(code: AuthorizationCode): Promise<void>;
  getCode(code: string): Promise<AuthorizationCode | null>;
  /**
   * Atomically claim an unconsumed code: set consumed_at and return true IFF
   * this call transitioned it unconsumed → consumed. Returns false when the code
   * is unknown or was already consumed (incl. by a concurrent exchange). The
   * persistent impl MUST do this as a single conditional statement (UPDATE …
   * SET consumed_at = $at WHERE code = $code AND consumed_at IS NULL RETURNING …,
   * claimed = rowCount === 1) so two concurrent /v1/oauth/token exchanges of the
   * same code can never both succeed (authorization-code reuse / token replay).
   */
  consumeCodeIfUnconsumed(code: string, at: number): Promise<boolean>;
  // Access tokens
  /**
   * Insert a token only while its client is unrevoked and still carries the
   * exact secret hash authenticated by this exchange. Return true iff the
   * token was inserted. A persistent implementation must bind both client
   * predicates to the insert atomically (for example, INSERT … SELECT from the
   * matching live client) so concurrent revoke or secret rotation cannot mint
   * authority from a stale client read.
   */
  insertTokenIfClientAuthorityMatches(args: {
    token: AccessToken;
    expectedClientSecretHash: string;
  }): Promise<boolean>;
  getToken(token: string): Promise<AccessToken | null>;
  revokeToken(token: string): Promise<void>;
}

export class InMemoryOAuthStore implements OAuthStore {
  private readonly clients = new Map<string, OAuthClient>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly tokens = new Map<string, AccessToken>();

  /**
   * 2026-05-21 — test-only state flush. The e2e helper's resetState()
   * calls this so per-test assertions don't see clients / codes /
   * tokens left over from earlier tests in the same spec file.
   * Never call from production code paths — there are no production
   * code paths that should be wiping the catalog mid-run.
   */
  resetForTest(): void {
    this.clients.clear();
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
    if (c) this.clients.set(id, { ...c, revoked_at: at });
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async insertCode(c: AuthorizationCode): Promise<void> {
    this.codes.set(c.code, c);
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
  async consumeCodeIfUnconsumed(code: string, at: number): Promise<boolean> {
    // Single-thread check-and-set: no await between the read and the write, so
    // two interleaved exchanges can't both observe consumed_at === null and both
    // claim the code.
    const c = this.codes.get(code);
    if (c === undefined || c.consumed_at !== null) return false;
    this.codes.set(code, { ...c, consumed_at: at });
    return true;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async insertTokenIfClientAuthorityMatches(args: {
    token: AccessToken;
    expectedClientSecretHash: string;
  }): Promise<boolean> {
    const client = this.clients.get(args.token.client_id);
    if (
      client === undefined ||
      client.revoked_at !== null ||
      !constantTimeStringEqual(client.client_secret_hash, args.expectedClientSecretHash)
    ) {
      return false;
    }
    this.tokens.set(args.token.token, args.token);
    return true;
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
  // code/token scope is restricted to the intersection of the requested scope and these,
  // minus privileged scopes — so a third-party OAuth token can never exceed the approver's
  // authority or carry account_owner / admin / driftstack_internal_admin. When omitted, the
  // privileged deny-set still applies (the intersection is just skipped).
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

export class OAuthService {
  private readonly pendingAuthorizations = new Map<string, AuthorizationCode & { pending: true }>();

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
   * consent records carry over.
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
    const client = await this.store.getClient(args.client_id);
    if (client === null || client.revoked_at !== null) {
      throw new OAuthError('invalid_client', 'unknown or revoked client_id');
    }
    if (!client.redirect_uris.includes(args.redirect_uri)) {
      throw new OAuthError('invalid_request', 'redirect_uri not registered');
    }
    // Stage the pending authorization in-memory; dashboard exchanges
    // authorization_id → approval result via approveAuthorization.
    const authorization_id = `oaa_${randomBytes(16).toString('base64url')}`;
    this.pendingAuthorizations.set(authorization_id, {
      code: '', // assigned on approval
      client_id: args.client_id,
      redirect_uri: args.redirect_uri,
      state: args.state,
      scope: [...args.scope],
      code_challenge: args.code_challenge,
      account_id: '', // set on approval
      created_at: this.nowFn(),
      consumed_at: null,
      pending: true,
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
    const pending = this.pendingAuthorizations.get(args.authorization_id);
    if (pending === undefined) {
      throw new OAuthError('invalid_request', 'unknown or expired authorization_id');
    }
    this.pendingAuthorizations.delete(args.authorization_id);
    if (this.nowFn() - pending.created_at > CODE_TTL_SECONDS * 1000) {
      throw new OAuthError('invalid_request', 'authorization expired before approval');
    }
    // SECURITY: restrict the granted scope — always drop the privileged deny-set, then
    // reduce through the canonical hierarchy so broad authority can grant matching granular
    // scopes without ever letting granular authority broaden or cross into a sibling scope.
    const approverScopes = args.approverScopes;
    const grantedScope = pending.scope.filter(
      (s) =>
        !OAUTH_DENY_SCOPES.has(s) &&
        (approverScopes === undefined || scopesSatisfy(approverScopes, s)),
    );
    const code = `oac_${randomBytes(32).toString('base64url')}`;
    await this.store.insertCode({
      code,
      client_id: pending.client_id,
      redirect_uri: pending.redirect_uri,
      state: pending.state,
      scope: grantedScope,
      code_challenge: pending.code_challenge,
      account_id: args.account_id,
      created_at: this.nowFn(),
      consumed_at: null,
    });
    return { code, redirect_uri: pending.redirect_uri, state: pending.state };
  }

  async exchangeCode(args: ExchangeCodeArgs): Promise<ExchangeCodeResult> {
    const client = await this.store.getClient(args.client_id);
    if (client === null || client.revoked_at !== null) {
      throw new OAuthError('invalid_client', 'unknown or revoked client_id');
    }
    const presentedSecretHash = this.secretHasher(args.client_secret);
    if (!constantTimeStringEqual(client.client_secret_hash, presentedSecretHash)) {
      throw new OAuthError('invalid_client', 'client_secret mismatch');
    }
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
    // Atomic single-use gate: claim the code or lose to a concurrent exchange.
    // The consumed_at read above is a fast-fail pre-check; THIS is the
    // authoritative serialization point (validation already passed, so a
    // failed validation never burns the code — only a real winning exchange
    // consumes it). Two concurrent exchanges of the same code → exactly one
    // claims → exactly one token issued (no authorization-code reuse).
    if (!(await this.store.consumeCodeIfUnconsumed(args.code, this.nowFn()))) {
      throw new OAuthError('invalid_grant', 'code already exchanged');
    }

    const token = `oat_${randomBytes(32).toString('base64url')}`;
    const now = this.nowFn();
    const inserted = await this.store.insertTokenIfClientAuthorityMatches({
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
    if (!inserted) throw new OAuthError('invalid_client', 'unknown or revoked client_id');
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
