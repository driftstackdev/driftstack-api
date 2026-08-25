// Drift guard for apps/server/src/lib/oauth-client-providers.ts.
// Pins the V-667.C OAuth-CLIENT provider definitions — 2-provider
// catalogue (google + github), per-provider IDP endpoint URLs,
// scope strings, PKCE-required flag, Google-only prompt=consent +
// access_type=offline, and the NormalizedUserInfo shape.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/oauth-client-providers.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('lib/oauth-client-providers content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('V-667.C 6-step user-flow framing pinned: 1. Customer clicks Sign-in-with-Google → /v1/auth/oauth-client/start 2. Server generates PKCE verifier + state nonce, returns authorize_url 3. IDP redirects to /auth/oauth-client/callback with code 4. Server exchanges code → tokens 5. Server fetches userinfo 6. Server inserts/updates account_oauth_links (or oauth_pending_links per Verdict 1) + issues web session + redirects dashboard. — pinned so the V-667.C anchor + 6-step user-flow + Verdict-1-collision-fork all stay documented', () => {
    expect(body).toMatch(
      /\/\/ V-667\.C — OAuth-CLIENT \(sign-in-with-Google\/GitHub\) provider\s*\/\/ definitions\. The user flow:/,
    );
    expect(body).toMatch(
      /\/\/ {3}1\. Customer clicks "Sign in with Google" → dashboard calls\s*\/\/ {6}\/v1\/auth\/oauth-client\/start \{ provider: 'google' \}/,
    );
    expect(body).toMatch(
      /\/\/ {3}6\. Server inserts\/updates account_oauth_links \(or oauth_pending_\s*\/\/ {6}links per Verdict 1 collision\), issues web session, redirects\s*\/\/ {6}dashboard\./,
    );
  });

  it('Verdict-2-revoke-marking framing pinned: \'Verdict 2 (revoke) is enforced at step 4 if the token exchange returns "invalid_grant" or 401; we mark last_revoked_at on the link row and the dashboard prompts re-auth.\' — pinned so the Verdict-2 invalid_grant-or-401 trigger + last_revoked_at-stamp + dashboard-re-auth-prompt contract all stay documented', () => {
    expect(body).toMatch(
      /\/\/ Verdict 2 \(revoke\) is enforced at step 4 if the token exchange\s*\/\/ returns "invalid_grant" or 401; we mark last_revoked_at on the\s*\/\/ link row and the dashboard prompts re-auth\./,
    );
  });

  it("Wire-ready posture framing pinned: 'Until the operator sets the per-provider client_id + client_secret env vars (GOOGLE_OAUTH_CLIENT_{ID,SECRET} + GITHUB_OAUTH_CLIENT_{ID,SECRET}), the OAuth-client routes stay unregistered (route gate in app.ts mirrors V-487 NowPayments + V-665 Postmark + V-531.B LiveKit patterns).' — pinned so the 4-env-var trigger + 3-feature-precedent (V-487 NowPayments + V-665 Postmark + V-531.B LiveKit) activation-gate mirror all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Posture: wire-ready\. Until the operator sets the per-provider\s*\/\/ client_id \+ client_secret env vars \(GOOGLE_OAUTH_CLIENT_\{ID,SECRET\}\s*\/\/ \+ GITHUB_OAUTH_CLIENT_\{ID,SECRET\}\), the OAuth-client routes stay\s*\/\/ unregistered \(route gate in app\.ts mirrors V-487 NowPayments \+\s*\/\/ V-665 Postmark \+ V-531\.B LiveKit patterns\)\./,
    );
  });

  it("OAuthClientProvider 2-value union pinned: 'google' | 'github'. + ProviderConfig 7-field shape (id + label + authorizeUrl + tokenUrl + userinfoUrl + scope + pkceRequired). Drift to dropping a provider would shrink the auth surface; drift to renaming a field would diverge from the IDP-call call-site expectations", () => {
    expect(body).toMatch(/export type OAuthClientProvider = 'google' \| 'github';/);
    expect(body).toMatch(/export interface ProviderConfig \{/);
    expect(body).toMatch(/id: OAuthClientProvider;/);
    expect(body).toMatch(/label: string;/);
    expect(body).toMatch(/authorizeUrl: string;/);
    expect(body).toMatch(/tokenUrl: string;/);
    expect(body).toMatch(/userinfoUrl: string;/);
    expect(body).toMatch(/scope: string;/);
    expect(body).toMatch(/pkceRequired: boolean;/);
  });

  it("OAUTH_CLIENT_PROVIDERS google entry pinned: authorize accounts.google.com/o/oauth2/v2/auth + token oauth2.googleapis.com/token + userinfo openidconnect.googleapis.com/v1/userinfo + scope 'openid email profile' + pkceRequired: true. Drift to a different endpoint URL would break OAuth flow against Google's actual endpoints; drift to dropping openid from scope would lose the id_token + sub claim", () => {
    expect(body).toMatch(/google: \{/);
    expect(body).toMatch(/authorizeUrl: 'https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth',/);
    expect(body).toMatch(/tokenUrl: 'https:\/\/oauth2\.googleapis\.com\/token',/);
    expect(body).toMatch(/userinfoUrl: 'https:\/\/openidconnect\.googleapis\.com\/v1\/userinfo',/);
    expect(body).toMatch(/scope: 'openid email profile',/);
    expect(body).toMatch(/pkceRequired: true,/);
  });

  it("OAUTH_CLIENT_PROVIDERS github entry pinned: authorize github.com/login/oauth/authorize + token github.com/login/oauth/access_token + userinfo api.github.com/user + scope 'read:user user:email' + pkceRequired: false. + 'GitHub: legacy support but no PKCE enforcement — we still send the challenge for consistency.' framing — pinned so the GitHub-doesn't-require-PKCE-but-we-send-for-consistency contract stays documented", () => {
    expect(body).toMatch(/github: \{/);
    expect(body).toMatch(/authorizeUrl: 'https:\/\/github\.com\/login\/oauth\/authorize',/);
    expect(body).toMatch(/tokenUrl: 'https:\/\/github\.com\/login\/oauth\/access_token',/);
    expect(body).toMatch(/userinfoUrl: 'https:\/\/api\.github\.com\/user',/);
    expect(body).toMatch(/scope: 'read:user user:email',/);
    expect(body).toMatch(/pkceRequired: false,/);
    expect(body).toMatch(
      /\*\s+Whether the IDP supports PKCE on the token-exchange\. Google: yes\.\s*\*\s+GitHub: legacy support but no PKCE enforcement — we still send\s*\*\s+the challenge for consistency\./,
    );
  });

  it("OAuthClientConfig DASHBOARD_ORIGIN cross-reference + callbackUrl-same-across-providers + state-discriminates framing pinned: 'Public-facing callback URL — included in the authorize redirect and verified at token exchange. Same value across all providers (we discriminate by state payload). Typically ${DASHBOARD_ORIGIN}/auth/oauth-client/callback.' — pinned so the DASHBOARD_ORIGIN + same-callback-discriminate-by-state contract all stay documented", () => {
    expect(body).toMatch(
      /\/\*\* Public-facing callback URL — included in the authorize redirect\s*\*\s+and verified at token exchange\. Same value across all providers\s*\*\s+\(we discriminate by `state` payload\)\. Typically\s*\*\s+`\$\{DASHBOARD_ORIGIN\}\/auth\/oauth-client\/callback`\. \*\//,
    );
  });

  it("buildAuthorizeUrl 7-param + S256 PKCE method + Google-only prompt=consent + access_type=offline framing pinned: 'GitHub doesn't error on extra params (PKCE) so we always include them — the provider's pkceRequired flag only influences whether we VERIFY the challenge round-tripped, not whether we send it.' + 'Google-specific: surface the consent screen even for repeat-users so the email is freshly verified at each link attempt (Verdict 1 collision flow depends on a trustworthy IDP-asserted email).' — pinned so the always-send-PKCE-but-conditionally-verify contract + Google-fresh-email-Verdict-1 rationale all stay documented", () => {
    expect(body).toMatch(
      /\*\s+GitHub doesn't error on extra params \(PKCE\) so we always include\s*\*\s+them — the provider's `pkceRequired` flag only influences whether\s*\*\s+we VERIFY the challenge round-tripped, not whether we send it\./,
    );
    expect(body).toMatch(/code_challenge_method: 'S256',/);
    expect(body).toMatch(
      /\/\/ Google-specific: surface the consent screen even for repeat-users\s*\/\/ so the email is freshly verified at each link attempt \(Verdict 1\s*\/\/ collision flow depends on a trustworthy IDP-asserted email\)\./,
    );
    expect(body).toMatch(
      /if \(opts\.provider === 'google'\) \{\s*params\.set\('prompt', 'consent'\);\s*params\.set\('access_type', 'offline'\);\s*\}/,
    );
  });

  it("NormalizedUserInfo 5-field shape + emailVerified-rejection-on-route-layer framing pinned: 'Both providers can return unverified emails in some configurations; the route layer rejects unverified emails so the Verdict 1 collision-flow trust assumption holds.' + 'Avatar URL — pinned to the IDP-provided value at first-link time per Verdict 3 (first-link-only, user-overridable).' — pinned so the emailVerified-rejection + Verdict-3-first-link-only-avatar contract all stay documented", () => {
    expect(body).toMatch(/export interface NormalizedUserInfo \{/);
    expect(body).toMatch(/providerSub: string;/);
    expect(body).toMatch(/email: string;/);
    expect(body).toMatch(/emailVerified: boolean;/);
    expect(body).toMatch(/name: string \| null;/);
    expect(body).toMatch(/avatarUrl: string \| null;/);
    expect(body).toMatch(
      /\*\s+Verified email from the IDP\. Both providers can return unverified\s*\*\s+emails in some configurations; the route layer rejects unverified\s*\*\s+emails so the Verdict 1 collision-flow trust assumption holds\./,
    );
    expect(body).toMatch(
      /\*\s+Avatar URL — pinned to the IDP-provided value at first-link\s*\*\s+time per Verdict 3 \(first-link-only, user-overridable\)\./,
    );
  });
});
