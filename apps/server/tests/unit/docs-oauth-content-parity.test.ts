// Arc 6 docs.oauth — `apps/docs/src/pages/api/oauth.md` content
// parity. Pins the page against the source-of-truth surface so
// renames + drops break CI:
//
//   - Every documented endpoint must correspond to a real route file
//     in apps/server/src/routes/oauth.ts.
//   - The 5 OAuthError codes from services/oauth.ts MUST appear in
//     the error table.
//   - TTL claims (1h access token, 5min code) MUST match the
//     CODE_TTL_SECONDS / TOKEN_TTL_SECONDS constants.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOCS_PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/oauth.md');
const ROUTE_FILE = resolve(REPO_ROOT, 'apps/server/src/routes/oauth.ts');
const SERVICE_FILE = resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts');

describe('Arc 6 docs.oauth — apps/docs/src/pages/api/oauth.md parity', () => {
  it('docs page file exists at the expected path', () => {
    expect(existsSync(DOCS_PAGE)).toBe(true);
  });

  const body = readFileSync(DOCS_PAGE, 'utf8');
  const routeSource = readFileSync(ROUTE_FILE, 'utf8');
  const serviceSource = readFileSync(SERVICE_FILE, 'utf8');

  it('frontmatter declares the layout + title + description', () => {
    expect(body).toMatch(/layout: \.\.\/\.\.\/layouts\/DocLayout\.astro/);
    expect(body).toMatch(/title: OAuth 2\.0/);
    expect(body).toMatch(/description: .+third-party/i);
  });

  it('documents every public OAuth endpoint that the route source exposes', () => {
    const paths = [
      '/v1/oauth/authorize',
      '/v1/oauth/authorize/complete',
      '/v1/oauth/token',
      '/v1/oauth/introspect',
      '/v1/oauth/revoke',
    ];
    for (const p of paths) {
      expect(
        routeSource.includes(`'${p}'`) || routeSource.includes(`\`${p}\``),
        `route source must declare ${p}`,
      ).toBe(true);
      const re = new RegExp(`/v1/oauth/[^\\s\`'"]*`);
      // The page must reference each endpoint at least once.
      expect(body.includes(p), `docs page must reference ${p}`).toBe(true);
      // Guard against an accidentally-stripped regex (sanity).
      expect(body).toMatch(re);
    }
  });

  it('documents the PKCE requirement (S256 only, plain rejected)', () => {
    expect(body).toMatch(/PKCE/i);
    expect(body).toMatch(/S256/);
    expect(body).toMatch(/plain/i);
  });

  it('documents the mandatory query parameters on /authorize', () => {
    const params = [
      'client_id',
      'redirect_uri',
      'state',
      'code_challenge',
      'code_challenge_method',
      'scope',
    ];
    for (const p of params) {
      expect(body.includes(p), `docs page must reference ${p}`).toBe(true);
    }
  });

  it('documents that consent is human web-session-only and applies hierarchical scope reduction', () => {
    expect(body).toMatch(/interactive dashboard session required/i);
    expect(body).toMatch(/General API keys cannot call this endpoint/);
    expect(body).toMatch(/Broad `read` and `write` authority can approve/);
    expect(body).toMatch(/granular scope cannot approve a broad or sibling scope/);
    expect(body).toMatch(/account-owner scopes are never minted/);
  });

  it('access-token TTL claim matches TOKEN_TTL_SECONDS in services/oauth.ts (1 hour)', () => {
    expect(serviceSource).toMatch(/TOKEN_TTL_SECONDS\s*=\s*60\s*\*\s*60/);
    expect(body).toMatch(/expires_in.+3600/);
    expect(body).toMatch(/1 hour/);
  });

  it('authorization-code TTL claim matches CODE_TTL_SECONDS in services/oauth.ts (5 minutes)', () => {
    expect(serviceSource).toMatch(/CODE_TTL_SECONDS\s*=\s*5\s*\*\s*60/);
    expect(body).toMatch(/5 minutes/i);
  });

  // V-753 — this used to assert `serviceSource` merely CONTAINS each code string,
  // which the type union satisfies on its own. So it read as "the service can emit
  // this" while only proving "the identifier appears in the file" — and that is what
  // forced `unauthorized_client` into the customer-facing error table even though no
  // call site produces it. A customer branching on it had a permanently dead branch.
  // Now it checks PRODUCERS: `new OAuthError('<code>'`.
  it('every OAuth code that has a PRODUCER is documented, and declared-but-unproduced codes are not', () => {
    const producedCodes = [
      'invalid_client',
      'invalid_request',
      'invalid_scope',
      'invalid_grant',
      'access_denied',
    ];
    for (const c of producedCodes) {
      expect(
        new RegExp(`new OAuthError\\(\\s*'${c}'`).test(serviceSource),
        `services/oauth.ts must actually throw ${c} — if this code was retired, remove its row from the docs table too`,
      ).toBe(true);
      expect(body.includes(c), `docs page must reference ${c}`).toBe(true);
    }

    // `unauthorized_client` is a real RFC 6749 code kept as a forward slot (union
    // member + a defensive case in the status mapper) for a future per-client
    // grant-type allowlist. Nothing throws it today, so it must NOT be advertised.
    expect(
      new RegExp("new OAuthError\\(\\s*'unauthorized_client'").test(serviceSource),
      'unauthorized_client now has a producer — document it in the errors table and move it into producedCodes above',
    ).toBe(false);
    expect(
      body.includes('unauthorized_client'),
      'unauthorized_client has no producer, so the customer error table must not list it',
    ).toBe(false);
  });

  it('documents that refresh tokens are NOT issued (anti-feature; intentional)', () => {
    expect(body).toMatch(/refresh tokens? are NOT issued/i);
  });

  it('documents the introspection response carrying client_id + account_id + scope + exp', () => {
    expect(body).toMatch(/"client_id"/);
    expect(body).toMatch(/"account_id"/);
    expect(body).toMatch(/"scope"/);
    expect(body).toMatch(/"exp"/);
  });

  it('documents the RFC 9457 problem+json envelope with real https://errors.driftstack.dev/ type URIs', () => {
    expect(body).toMatch(/problem\+json/);
    expect(body).toMatch(/RFC 9457/);
    expect(body).toMatch(/`https:\/\/errors\.driftstack\.dev\/bad-request`/);
    expect(body).toMatch(/`https:\/\/errors\.driftstack\.dev\/unauthorized`/);
    // Ban the superseded urn:driftstack:oauth: type-prefix framing.
    expect(body).not.toMatch(/urn:driftstack:oauth:/);
  });

  it('linked from apps/docs/src/pages/api/index.astro', () => {
    const indexPath = resolve(REPO_ROOT, 'apps/docs/src/pages/api/index.astro');
    const idx = readFileSync(indexPath, 'utf8');
    expect(idx).toMatch(/\/api\/oauth\//);
    expect(idx).toMatch(/OAuth 2\.0/i);
  });

  it('pins paid OAuth approval, non-consuming Free denial and post-upgrade token recovery', () => {
    expect(body).toMatch(
      /OAuth customer authorization requires a paid account tier, including any\s*\n?Manual tier/,
    );
    expect(body).toMatch(/approval returns RFC 9457 `403 Forbidden`/);
    expect(body).toMatch(/does not consume the staged authorization/);
    expect(body).toMatch(/resume after an\s*\n?upgrade if they have not expired or been revoked/);
    expect(body).not.toMatch(/feature_not_available/);
  });
});
