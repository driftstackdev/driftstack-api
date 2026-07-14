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

  it('Implementation notes pin PKCE, atomic codes, opaque tokens, client-bound lifecycle calls, and no refresh tokens', () => {
    expect(body).toMatch(
      /- \*\*PKCE is mandatory\*\*, including for confidential clients\. The\s*\n?\s*`plain` challenge method is rejected — `S256` only\./,
    );
    expect(body).toMatch(
      /- \*\*Codes are single-use\*\* and expire 5 minutes after issue\. Race a\s*\n?\s*second `\/token` exchange with the same code → exactly one exchange\s*\n?\s*succeeds and every loser receives `invalid_grant` \(the code is\s*\n?\s*atomically consumed\)\./,
    );
    expect(body).toMatch(
      /- \*\*Access tokens are opaque\*\* — don't try to parse them\. They're\s*\n?\s*not JWTs; introspect via `\/v1\/oauth\/introspect` if you need the\s*\n?\s*encoded fields\. Introspection and revocation require the same\s*\n?\s*confidential-client credentials used at `\/v1\/oauth\/token` and are\s*\n?\s*bound to that client's own tokens\./,
    );
    expect(body).toMatch(
      /- \*\*Refresh tokens are NOT issued\.\*\* When a token expires, the\s*\n?\s*customer must re-authorize\./,
    );
    expect(body).toMatch(
      /- \*\*Provider state is persistent\.\*\* Client secrets, pending consent\s*\n?\s*handles, authorization codes and access tokens are stored only as\s*\n?\s*SHA-256 digests\./,
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

  it('RFC 7009 revoke requires client credentials, binds ownership, preserves authorized anti-enumeration, and rejects invalid credentials', () => {
    expect(body).toMatch(/`POST \/v1\/oauth\/revoke` \(RFC 7009\)/);
    expect(body).toMatch(/"client_id": "oac_…"/);
    expect(body).toMatch(/"client_secret": "oas_…"/);
    expect(body).toMatch(
      /Once client authentication\s*\n?\s*succeeds, the endpoint returns `200 \{\}` for an owned, unknown, or\s*\n?\s*foreign-client token; only a token issued to the authenticated client\s*\n?\s*is revoked\./,
    );
    expect(body).toMatch(
      /Invalid or revoked client credentials\s*\n?\s*return `401` before mutation\./,
    );
  });

  it('RFC 7662 introspection pins client authentication, own-token metadata, minimal inactive foreign response, and Unix exp', () => {
    expect(body).toMatch(/`POST \/v1\/oauth\/introspect` \(RFC 7662\)/);
    expect(body).toMatch(
      /"active": true,\s*\n?\s*"client_id": "oac_…",\s*\n?\s*"account_id": "<customer-uuid>",\s*\n?\s*"scope": \["read:sessions", "write:sessions"\],\s*\n?\s*"exp": 1747852800/,
    );
    expect(body).toMatch(/\{ "active": false \}/);
    expect(body).toMatch(/`exp` is Unix seconds \(per RFC 7662 §2\.2\)\./);
    expect(body).toMatch(/The endpoint returns `401` before token lookup when the client/);
  });

  it('pins the curated OAuth allowlist and rejects fail-open API-key scope inheritance', () => {
    expect(body).toMatch(/space-separated list from the curated third-party scope set/);
    expect(body).toMatch(/The OAuth request itself may contain only the 13 granular scopes/);
    expect(body).toMatch(/deprecated broad aliases, `gui_control`, and newly added API-key scopes/);
    expect(body).toMatch(/fail closed with `invalid_scope` rather than becoming available by/);
    expect(body).not.toMatch(/"scope": \["read", "write"\]/);
  });

  it('pins account-scoped consent to its registered customer without burning rightful consent', () => {
    expect(body).toMatch(/An account-scoped client can be approved only by its registered/);
    expect(body).toMatch(
      /account\. A different customer's consent attempt returns `access_denied`/,
    );
    expect(body).toMatch(/without consuming the pending authorization/);
  });

  it("Bearer-API-keys-AND-OAuth-tokens-share-header framing pinned: 'Bearer API keys (ds_live_…) and OAuth access tokens BOTH use the Authorization: Bearer <token> header on /v1/* requests. The server differentiates by token prefix; both surfaces respect the same scope + rate-limit + audit pipeline.' — pinned so the dual-token-shared-header + differentiate-by-prefix + same-pipeline contract all stay documented", () => {
    expect(body).toMatch(
      /Bearer API keys \(`ds_live_…`\) and OAuth access tokens BOTH use the\s*\n?\s*> `Authorization: Bearer <token>` header on `\/v1\/\*` requests\. The\s*\n?\s*> server differentiates by token prefix; both surfaces respect the\s*\n?\s*> same scope \+ rate-limit \+ audit pipeline\./,
    );
  });
});
