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
      /Authorization Server\*\* so third-party\s*apps can act on a customer's behalf without ever holding the\s*customer's API key\./,
    );
    expect(body).toMatch(
      /standard Authorization Code grant\s*with \*\*PKCE required\*\* \(RFC 7636 — no exceptions, even for confidential\s*clients\); access tokens are bearer-style and short-lived \(one hour\);\s*no refresh tokens are issued\./,
    );
  });

  it('Implementation notes pin PKCE, atomic codes, opaque tokens, client-bound lifecycle calls, and no refresh tokens', () => {
    expect(body).toMatch(
      /- \*\*PKCE is mandatory\*\*, including for confidential clients\. The\s*`plain` challenge method is rejected — `S256` only\./,
    );
    expect(body).toMatch(
      /- \*\*Codes are single-use\*\* and expire 5 minutes after issue\. Race a\s*second `\/token` exchange with the same code → exactly one exchange\s*succeeds and every loser receives `invalid_grant` \(the code is\s*atomically consumed\)\./,
    );
    expect(body).toMatch(
      /- \*\*Access tokens are opaque\*\* — don't try to parse them\. They're\s*not JWTs; introspect via `\/v1\/oauth\/introspect` if you need the\s*encoded fields\. Introspection and revocation require the same\s*confidential-client credentials used at `\/v1\/oauth\/token` and are\s*bound to that client's own tokens\./,
    );
    expect(body).toMatch(
      /- \*\*Refresh tokens are NOT issued\.\*\* When a token expires, the\s*customer must re-authorize\./,
    );
    expect(body).toMatch(
      /- \*\*Provider state is persistent\.\*\* Client secrets, pending consent\s*handles, authorization codes and access tokens are stored only as\s*SHA-256 digests\./,
    );
  });

  it("Admin-gated client-registration framing pinned: 'Client registration is currently admin-gated — talk to support@driftstack.dev' + 'The client_secret is shown once and never recoverable; the server stores only its SHA-256 hash. Lost secrets require rotation via support.' + account-scoped or multi-tenant intake. Drift to dropping the SHA-256 hash-at-rest would weaken the client-secret security model", () => {
    expect(body).toMatch(
      /Client registration is currently \*\*admin-gated\*\* — talk to\s*\[support@driftstack\.dev\]/,
    );
    expect(body).toMatch(
      /The `client_secret` is shown \*\*once\*\* and never recoverable; the\s*server stores only its SHA-256 hash\./,
    );
    expect(body).toMatch(
      /- the redirect URIs you'll use \(HTTPS-only, except `localhost` for\s*native-app development per RFC 8252\)/,
    );
    expect(body).toMatch(
      /- whether the client is account-scoped \(one specific customer\s*account\) or multi-tenant \(any customer can authorize\)/,
    );
    expect(body).toMatch(
      /a multi-tenant client has\s*no account binding and may be approved by any customer\./,
    );
    expect(body).not.toMatch(/marketplace/i);
  });

  it('Errors-at-a-glance 5-row roster pinned (V-753 dropped the unreachable 401 unauthorized_client row — no call site produces it, so branching on it was a dead branch): 400 invalid_request + 400 invalid_grant + 400 invalid_scope + 400 access_denied + 401 invalid_client. All RFC 9457 problem+json + real https://errors.driftstack.dev/ type URIs', () => {
    expect(body).toMatch(/\|\s*400 \| `invalid_request`/);
    expect(body).toMatch(/\|\s*400 \| `invalid_grant`/);
    expect(body).toMatch(/\|\s*400 \| `invalid_scope`/);
    expect(body).toMatch(/\|\s*400 \| `access_denied`/);
    expect(body).toMatch(/\|\s*401 \| `invalid_client`/);
    // V-753 — the row must NOT come back. `unauthorized_client` is a forward slot in
    // the union with zero producers; the doc-vs-union invariant that demanded it lived
    // in docs-oauth-content-parity and now checks producers instead.
    expect(body).not.toMatch(/`unauthorized_client`/);
    expect(body).toMatch(
      /All responses use `application\/problem\+json` per RFC 9457 \(status,\s*type, title, detail\)\. The `type` field is a real RFC 9457 type URI:\s*`https:\/\/errors\.driftstack\.dev\/bad-request` for the 400 cases and\s*`https:\/\/errors\.driftstack\.dev\/unauthorized` for the 401 cases\./,
    );
    expect(body).toMatch(
      // V-737 — the code is now a top-level machine-readable `error` field, not
      // prose in title/detail. The old claim was not merely weak, it was FALSE:
      // oauthErrorToHttp discarded the code and the messages never contained it,
      // so an integrator told to read it from `detail` had nothing to read.
      /returned as a top-level\s*\*\*`error`\*\* field on the problem document/,
    );
    // Ban the superseded RFC 7807 / urn:driftstack:oauth: type-prefix framing —
    // the corrected doc moved to RFC 9457 + real https://errors.driftstack.dev/ type URIs.
    expect(body).not.toMatch(/urn:driftstack:oauth:/);
    expect(body).toMatch(/Branch on `error`, not on `detail`/);
    expect(body).toMatch(/"error": "invalid_grant"/);
  });

  it('RFC 7009 revoke requires client credentials, binds ownership, preserves authorized anti-enumeration, and rejects invalid credentials', () => {
    expect(body).toMatch(/`POST \/v1\/oauth\/revoke` \(RFC 7009\)/);
    expect(body).toMatch(/"client_id": "oac_…"/);
    expect(body).toMatch(/"client_secret": "oas_…"/);
    expect(body).toMatch(
      /Once client authentication\s*succeeds, the endpoint returns `200 \{\}` for an owned, unknown, or\s*foreign-client token; only a token issued to the authenticated client\s*is revoked\./,
    );
    expect(body).toMatch(/Invalid or revoked client credentials\s*return `401` before mutation\./);
  });

  it('RFC 7662 introspection pins client authentication, own-token metadata, minimal inactive foreign response, and Unix exp', () => {
    expect(body).toMatch(/`POST \/v1\/oauth\/introspect` \(RFC 7662\)/);
    expect(body).toMatch(
      /"active": true,\s*"client_id": "oac_…",\s*"account_id": "<customer-uuid>",\s*"scope": \["read:sessions", "write:sessions"\],\s*"exp": 1747852800/,
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
      /Bearer API keys \(`ds_live_…`\) and OAuth access tokens BOTH use the\s*> `Authorization: Bearer <token>` header on `\/v1\/\*` requests\. The\s*> server differentiates by token prefix; both surfaces respect the\s*> same scope \+ rate-limit \+ audit pipeline\./,
    );
  });

  it('pins paid-only approval, non-consuming Free failure and upgrade recovery', () => {
    expect(body).toMatch(/OAuth customer authorization requires a paid account tier/);
    expect(body).toMatch(/approval returns RFC 9457 `403 Forbidden`/);
    expect(body).toMatch(/does not consume the staged authorization/);
    expect(body).toMatch(/same\s*\n?request can be approved after an upgrade/);
    expect(body).toMatch(/resume after an\s*\n?upgrade if they have not expired or been revoked/);
    expect(body).not.toMatch(/feature_not_available/);
  });

  it('V-985 CRITICAL pins the account_id defence to the mechanism the code actually implements. The page said a body-supplied `account_id` was REJECTED to prevent cross-account takeover. It is not rejected: `ApproveAuthorizationBody` is a plain z.object, so the key is stripped and the request answers 200 — the route simply never reads it, which the source comment states correctly. The distinction is the whole value of the sentence to a reviewer: someone probing with a victim `account_id`, told to expect a refusal, sees a 200 and can conclude the field was HONOURED, which is the opposite of what happened. Cross-checked against the schema so the prose cannot outlive the behaviour.', () => {
    expect(body).toMatch(/`account_id` is \*\*never read from the body\*\*/);
    expect(body).toMatch(/stripped by schema validation rather than refused/);
    expect(body).toMatch(
      /approves for the authenticated\s*\n?caller's account, never the supplied one/,
    );
    // The retracted claim, paraphrased in the negative so it cannot come back.
    expect(body).not.toMatch(/account_id` is rejected/);

    // Cross-source: the sentence above is only true while the schema strips.
    const routeSrc = readFileSync(resolve(REPO_ROOT, 'apps/server/src/routes/oauth.ts'), 'utf8');
    const decl = routeSrc.slice(routeSrc.indexOf('const ApproveAuthorizationBody'));
    const body_ = decl.slice(0, decl.indexOf('});') + 3);
    expect(body_, 'ApproveAuthorizationBody still exists').toContain('authorization_id');
    expect(
      body_,
      'ApproveAuthorizationBody is now .strict(), so a body-supplied account_id really IS refused — ' +
        'the page should go back to saying rejected, and this arm should say so instead',
    ).not.toContain('.strict()');
    expect(
      body_,
      'the schema now accepts an account_id from the body — this is the takeover the comment warns about',
    ).not.toContain('account_id');
  });
});
