// Drift guard for apps/docs/src/pages/api/oauth.md. Pins the OAuth 2.0
// third-party clients docs — Authorization Code + PKCE mandatory (S256
// only) + 1-hour access tokens + NO refresh tokens + opaque tokens +
// codes single-use 5-min TTL + admin-gated client registration +
// 6-error problem+json roster.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/docs/src/pages/api/oauth.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs/pages/api/oauth content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("OAuth 2.0 overview framing pinned: 'Driftstack ships an OAuth 2.0 Authorization Server so third-party apps can act on a customer's behalf without ever holding the customer's API key. The flow is the standard Authorization Code grant with PKCE required (RFC 7636 — no exceptions, even for confidential clients); access tokens are bearer-style and short-lived (one hour); no refresh tokens are issued.' — pinned so the PKCE-mandatory-no-exceptions + 1-hour-access-tokens + NO-refresh-tokens + RFC 7636 contract all stay documented", () => {
    expect(body).toMatch(
      /Authorization Server\*\* so third-party\s*\n?\s*apps can act on a customer's behalf without ever holding the\s*\n?\s*customer's API key\./,
    );
    expect(body).toMatch(
      /standard Authorization Code grant\s*\n?\s*with \*\*PKCE required\*\* \(RFC 7636 — no exceptions, even for confidential\s*\n?\s*clients\); access tokens are bearer-style and short-lived \(one hour\);\s*\n?\s*no refresh tokens are issued\./,
    );
  });

  it('Implementation notes 5-rule framing pinned: PKCE mandatory + S256 only + Codes single-use 5-min TTL + Access tokens opaque (not JWTs) + Refresh tokens NOT issued (intentional, 1h TTL workable trade-off) + Same scope set as API keys via ApiKeyScopeSchema — pinned so the 5-rule implementation-contract roster + S256-only + atomic-code-consume + opaque-not-JWT contract all stay documented', () => {
    expect(body).toMatch(
      /- \*\*PKCE is mandatory\*\*, including for confidential clients\. The\s*\n?\s*`plain` challenge method is rejected — `S256` only\./,
    );
    expect(body).toMatch(
      /- \*\*Codes are single-use\*\* and expire 5 minutes after issue\. Race a\s*\n?\s*second `\/token` exchange with the same code → both fail with\s*\n?\s*`invalid_grant` \(the code is atomically consumed\)\./,
    );
    expect(body).toMatch(
      /- \*\*Access tokens are opaque\*\* — don't try to parse them\. They're\s*\n?\s*not JWTs; introspect via `\/v1\/oauth\/introspect` if you need the\s*\n?\s*encoded fields\./,
    );
    expect(body).toMatch(
      /- \*\*Refresh tokens are NOT issued\.\*\* When a token expires, the\s*\n?\s*customer must re-authorize\./,
    );
  });

  it("Admin-gated client-registration framing pinned: 'Client registration is currently admin-gated — talk to support@driftstack.dev' + 'The client_secret is shown once and never recoverable; the server stores only its SHA-256 hash. Lost secrets require rotation via support.' + 4-field intake (label + redirect URIs HTTPS-only-except-localhost + account-scoped-or-marketplace). Drift to dropping the SHA-256 hash-at-rest would weaken the client-secret security model", () => {
    expect(body).toMatch(
      /Client registration is currently \*\*admin-gated\*\* — talk to\s*\n?\s*\[support@driftstack\.dev\]/,
    );
    expect(body).toMatch(
      /The `client_secret` is shown \*\*once\*\* and never recoverable; the\s*\n?\s*server stores only its SHA-256 hash\./,
    );
    expect(body).toMatch(
      /- the redirect URIs you'll use \(HTTPS-only, except `localhost` for\s*\n?\s*native-app development per RFC 8252\)/,
    );
  });

  it('Errors-at-a-glance 6-row roster pinned: 400 invalid_request + 400 invalid_grant (code unknown/expired/already-used; PKCE mismatch) + 400 invalid_scope + 400 access_denied + 401 invalid_client + 401 unauthorized_client. All RFC 9457 problem+json + real https://errors.driftstack.dev/ type URIs — pinned so the 6-error-code roster + RFC 9457 + errors.driftstack.dev type-URI contract all stay documented', () => {
    expect(body).toMatch(/\|\s*400 \| `invalid_request`/);
    expect(body).toMatch(/\|\s*400 \| `invalid_grant`/);
    expect(body).toMatch(/\|\s*400 \| `invalid_scope`/);
    expect(body).toMatch(/\|\s*400 \| `access_denied`/);
    expect(body).toMatch(/\|\s*401 \| `invalid_client`/);
    expect(body).toMatch(/\|\s*401 \| `unauthorized_client`/);
    expect(body).toMatch(
      /All responses use `application\/problem\+json` per RFC 9457 \(status,\s*\n?\s*type, title, detail\)\. The `type` field is a real RFC 9457 type URI:\s*\n?\s*`https:\/\/errors\.driftstack\.dev\/bad-request` for the 400 cases and\s*\n?\s*`https:\/\/errors\.driftstack\.dev\/unauthorized` for the 401 cases\./,
    );
    expect(body).toMatch(
      /The\s*\n?\s*OAuth code from the table above \(`invalid_grant`, `invalid_client`,\s*\n?\s*…\) appears in the `title`\/`detail`\./,
    );
    // Ban the superseded RFC 7807 / urn:driftstack:oauth: type-prefix framing —
    // the corrected doc moved to RFC 9457 + real https://errors.driftstack.dev/ type URIs.
    expect(body).not.toMatch(/urn:driftstack:oauth:/);
  });

  it("Revoke RFC 7009 anti-enumeration framing pinned: 'POST /v1/oauth/revoke (RFC 7009)' + 'Returns 200 {} always — even if the token never existed, to prevent probe-style enumeration per the RFC.' + 'Customers can ALSO revoke your integration from the customer dashboard at any time, which invalidates all access tokens issued to your client_id for that account.' — pinned so the RFC 7009 + always-200 anti-enumeration + customer-side dashboard-revoke + client_id-scoped-invalidation contract all stay documented", () => {
    expect(body).toMatch(/`POST \/v1\/oauth\/revoke` \(RFC 7009\)/);
    expect(body).toMatch(
      /Returns `200 \{\}` always —\s*\n?\s*even if the token never existed, to prevent probe-style enumeration\s*\n?\s*per the RFC\./,
    );
    expect(body).toMatch(
      /Customers can ALSO revoke your integration from the customer\s*\n?\s*dashboard at any time, which invalidates all access tokens issued\s*\n?\s*to your `client_id` for that account\./,
    );
  });

  it("Introspect RFC 7662 active-true/false framing pinned: 'POST /v1/oauth/introspect (RFC 7662)' + active:true response { active + client_id + account_id + scope + exp } + active:false on invalid/revoked/expired. + 'exp is Unix seconds (per RFC 7662 §2.2)' — pinned so the RFC 7662 + 5-field-active-true-response + bare-active-false-on-invalid + Unix-seconds-exp contract all stay documented", () => {
    expect(body).toMatch(/`POST \/v1\/oauth\/introspect` \(RFC 7662\)/);
    expect(body).toMatch(
      /"active": true,\s*\n?\s*"client_id": "oac_…",\s*\n?\s*"account_id": "<customer-uuid>",\s*\n?\s*"scope": \["read", "write"\],\s*\n?\s*"exp": 1747852800/,
    );
    expect(body).toMatch(/\{ "active": false \}/);
    expect(body).toMatch(/`exp` is Unix seconds \(per RFC 7662 §2\.2\)\./);
  });

  it("Bearer-API-keys-AND-OAuth-tokens-share-header framing pinned: 'Bearer API keys (ds_live_…) and OAuth access tokens BOTH use the Authorization: Bearer <token> header on /v1/* requests. The server differentiates by token prefix; both surfaces respect the same scope + rate-limit + audit pipeline.' — pinned so the dual-token-shared-header + differentiate-by-prefix + same-pipeline contract all stay documented", () => {
    expect(body).toMatch(
      /Bearer API keys \(`ds_live_…`\) and OAuth access tokens BOTH use the\s*\n?\s*> `Authorization: Bearer <token>` header on `\/v1\/\*` requests\. The\s*\n?\s*> server differentiates by token prefix; both surfaces respect the\s*\n?\s*> same scope \+ rate-limit \+ audit pipeline\./,
    );
  });
});
