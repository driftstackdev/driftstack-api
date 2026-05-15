// V-667.C — OAuth-CLIENT (sign-in-with-Google/GitHub) provider
// definitions. The user flow:
//
//   1. Customer clicks "Sign in with Google" → dashboard calls
//      /v1/auth/oauth-client/start { provider: 'google' }
//   2. Server generates PKCE verifier + state nonce, returns
//      `authorize_url` → dashboard redirects.
//   3. IDP redirects back to /auth/oauth-client/callback with code.
//   4. Server exchanges code → tokens (Google: oauth2 token endpoint;
//      GitHub: github.com/login/oauth/access_token).
//   5. Server fetches userinfo (Google: openid userinfo; GitHub:
//      api.github.com/user + /user/emails).
//   6. Server inserts/updates account_oauth_links (or oauth_pending_
//      links per Verdict 1 collision), issues web session, redirects
//      dashboard.
//
// Verdict 2 (revoke) is enforced at step 4 if the token exchange
// returns "invalid_grant" or 401; we mark last_revoked_at on the
// link row and the dashboard prompts re-auth.
//
// Posture: wire-ready. Until the operator sets the per-provider
// client_id + client_secret env vars (GOOGLE_OAUTH_CLIENT_{ID,SECRET}
// + GITHUB_OAUTH_CLIENT_{ID,SECRET}), the OAuth-client routes stay
// unregistered (route gate in app.ts mirrors V-487 NowPayments +
// V-665 Postmark + V-531.B LiveKit patterns).

export type OAuthClientProvider = 'google' | 'github';

export interface ProviderConfig {
  /** Stable provider id used in URLs + db rows. */
  id: OAuthClientProvider;
  /** Customer-facing label for the "Sign in with X" button. */
  label: string;
  /** IDP authorization endpoint (browser redirect target). */
  authorizeUrl: string;
  /** IDP token-exchange endpoint (server-side POST). */
  tokenUrl: string;
  /** IDP userinfo endpoint (server-side GET with bearer token). */
  userinfoUrl: string;
  /**
   * IDP-specific scope string sent to authorize. Google needs `openid`
   * to get the id_token + sub; GitHub needs `read:user user:email`
   * to read the user profile + verified email.
   */
  scope: string;
  /**
   * Whether the IDP supports PKCE on the token-exchange. Google: yes.
   * GitHub: legacy support but no PKCE enforcement — we still send
   * the challenge for consistency.
   */
  pkceRequired: boolean;
}

/**
 * Provider catalogue. Adding a new IDP is additive: append an entry +
 * extend OAuthClientProvider union + add env-var lookup. Drift-guard
 * pins this map size + entry shape so a casual edit can't silently
 * add or remove a provider.
 */
export const OAUTH_CLIENT_PROVIDERS: Record<OAuthClientProvider, ProviderConfig> = {
  google: {
    id: 'google',
    label: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    pkceRequired: true,
  },
  github: {
    id: 'github',
    label: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userinfoUrl: 'https://api.github.com/user',
    scope: 'read:user user:email',
    pkceRequired: false,
  },
};

/**
 * Per-provider env-var-derived credentials. Read at config-load time
 * via `lib/config.ts`. When either field is empty for a given
 * provider, the route-gate at `lib/app.ts` skips registering that
 * provider's authorize/callback routes (same all-or-nothing posture
 * as nowpayments + livekit).
 */
export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

export interface OAuthClientConfig {
  /** Public-facing callback URL — included in the authorize redirect
   *  and verified at token exchange. Same value across all providers
   *  (we discriminate by `state` payload). Typically
   *  `${DASHBOARD_ORIGIN}/auth/oauth-client/callback`. */
  callbackUrl: string;
  providers: Partial<Record<OAuthClientProvider, ProviderCredentials>>;
}

/**
 * Build the authorize-URL the dashboard redirects the user to. The
 * caller has already generated + stored `state` (server-side nonce
 * → pending-state row keyed on the nonce) + `codeChallenge` (PKCE
 * S256 of a stored verifier).
 *
 * GitHub doesn't error on extra params (PKCE) so we always include
 * them — the provider's `pkceRequired` flag only influences whether
 * we VERIFY the challenge round-tripped, not whether we send it.
 */
export function buildAuthorizeUrl(opts: {
  provider: OAuthClientProvider;
  clientId: string;
  callbackUrl: string;
  state: string;
  codeChallenge: string;
}): string {
  const cfg = OAUTH_CLIENT_PROVIDERS[opts.provider];
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.callbackUrl,
    response_type: 'code',
    scope: cfg.scope,
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
  });
  // Google-specific: surface the consent screen even for repeat-users
  // so the email is freshly verified at each link attempt (Verdict 1
  // collision flow depends on a trustworthy IDP-asserted email).
  if (opts.provider === 'google') {
    params.set('prompt', 'consent');
    params.set('access_type', 'offline');
  }
  return `${cfg.authorizeUrl}?${params.toString()}`;
}

/**
 * IDP-normalised userinfo. Both Google + GitHub responses are mapped
 * to this shape before the route layer touches them so the account-
 * linking flow only sees one variant.
 */
export interface NormalizedUserInfo {
  /** Stable per-IDP identifier — Google `sub`, GitHub `id` as string. */
  providerSub: string;
  /** Verified email from the IDP. Both providers can return unverified
   *  emails in some configurations; the route layer rejects unverified
   *  emails so the Verdict 1 collision-flow trust assumption holds. */
  email: string;
  emailVerified: boolean;
  /** Display name as returned by the IDP. Optional — falls back to
   *  the email-local-part at account create time. */
  name: string | null;
  /** Avatar URL — pinned to the IDP-provided value at first-link
   *  time per Verdict 3 (first-link-only, user-overridable). */
  avatarUrl: string | null;
}
