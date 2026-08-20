// W583.A (W651-deepened) — drift guard for packages/sdk-python/src/
// driftstack/resources/auth.py. V-079 AuthResource Python parity.
//
// W651 splits the original 6 it() blocks into 17 focused per-concept
// blocks + pins previously-implicit invariants. Mirrors the W647
// sdk-go-auth.go split (5→16):
//
//   • Module docstring posture pinned per-line: "These endpoints
//     don't require an API key (they ARE the auth gate)" + "The
//     SDK's HTTP layer always sends the Authorization header; the
//     server ignores it on these public routes." This is the
//     V-079 empty-key-fine-for-auth contract — drift to making
//     auth.signup() refuse to run when no API key is set would
//     break the first-time signup flow (you don't HAVE a key yet).
//   • dict[str, Any] typing rationale ("typing pending the next
//     regen pass") — explicit so a reader doesn't mistake this for
//     a hand-written shape; once the Zod regen pass lands these
//     become typed Request/Response models like webhooks.py.
//   • Per-verb blocks: 14 verbs each pinned with wire path + body=
//     coerce_body(body). Magic-link / password-reset / cli-authorize
//     are grouped by 2-step / 3-step flow because the steps are
//     load-bearing as a sequence (e.g. CLI exchange MUST come after
//     bind for the discriminated-union to ever yield "bound").
//   • V-445 mfa_challenge response 2-value discriminator pinned:
//     via: "totp" | "recovery". Drift to dropping the discriminator
//     would prevent customers from knowing whether to count a TOTP
//     code or a recovery code in their MFA-strength metrics.
//   • V-353e mfa_step_up 15-min window + "No new session issued;
//     the existing session's mfa timestamp advances" pinned. Drift
//     to issuing a new session on step-up would break the existing-
//     session-cookie identity continuity.
//   • V-460/V-266 CLI activation 3-step discriminated-union on
//     exchange (pending → bound → expired). Each step's auth
//     posture pinned: initiate public, bind web-session-auth,
//     exchange polled (no session required).
//   • Sync / async mirror — 14-verb count drift guard via regex
//     count, expects exactly 14 sync def + 14 async def + 2
//     __init__ = 30 def-statements total.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/auth.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W583.A packages/sdk-python/src/driftstack/resources/auth.py content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Module docstring — V-079 anchor + auth-gate-public-routes posture pinned per-line. CRITICAL: \"These endpoints don't require an API key (they ARE the auth gate). The SDK's HTTP layer always sends the Authorization header; the server ignores it on these public routes.\" Drift to making auth.signup() refuse to run without an API key would break the first-time signup flow (the customer doesn't HAVE a key yet — that's why they're signing up).", () => {
    expect(body).toMatch(/^"""Auth-flow resource — \/v1\/auth\/\* \(V-079\)\.\n/);
    expect(body).toMatch(/These endpoints don't require an API key \(they ARE the auth gate\)\./);
    expect(body).toMatch(/The SDK's HTTP layer always sends the Authorization header; the/);
    expect(body).toMatch(/server ignores it on these public routes\. The resource exists for/);
    expect(body).toMatch(/ergonomics \+ type symmetry with the TypeScript SDK\./);
  });

  it('dict[str, Any] typing rationale — "typing pending the next regen pass" pinned. This is a deliberate placeholder until the Zod regen pass lands typed request/response models (like webhooks.py already has via CreateWebhookRequest/Response). Drift to silently dropping the rationale would lose the migration breadcrumb for a future reader.', () => {
    expect(body).toMatch(/``dict\[str, Any\]`` typing pending the next regen pass\./);
  });

  it('Imports — future-annotations + 2-class HTTP client (sync + async) + coerce_body helper. No _generated.models import yet because every method body is dict[str, Any] pending regen.', () => {
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/^from typing import Any$/m);
    expect(body).toMatch(/^from driftstack\.http import AsyncHttpClient, HttpClient$/m);
    expect(body).toMatch(/^from driftstack\.resources\._common import coerce_body$/m);
  });

  it('AuthResource (sync) class declaration + __init__(http: HttpClient). Stateless wrapper — no auth caching (the public routes need no auth state). Same pattern as every other Python sync resource.', () => {
    expect(body).toMatch(/^class AuthResource:$/m);
    expect(body).toMatch(/^ {4}"""Synchronous auth-flow resource\."""$/m);
    expect(body).toMatch(
      /^ {4}def __init__\(self, http: HttpClient\) -> None:\s*\n\s*self\._http = http$/m,
    );
  });

  it('Sync signup — POST /v1/auth/signup. First touch of the auth journey: empty Authorization header tolerated by the server (V-079) so this verb is callable before the customer has any credentials.', () => {
    expect(body).toMatch(
      /def signup\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return self\._http\.request\("POST", "\/v1\/auth\/signup", json_body=coerce_body\(body\)\)/,
    );
  });

  it('Sync verify_email — POST /v1/auth/verify-email. Step 2 of signup: customer clicks the verification link in their inbox; SDK exchanges the token from the URL for a verified-email status. Drift to requiring a session would break the verification-link-from-email flow (no session yet).', () => {
    expect(body).toMatch(
      /def verify_email\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return self\._http\.request\("POST", "\/v1\/auth\/verify-email", json_body=coerce_body\(body\)\)/,
    );
  });

  it('Sync login — POST /v1/auth/login. Username/password sign-in entry point. Returns either {session_token, ...} OR {challenge_token, mfa_required: true} so callers must branch on the response shape before assuming login succeeded.', () => {
    expect(body).toMatch(
      /def login\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return self\._http\.request\("POST", "\/v1\/auth\/login", json_body=coerce_body\(body\)\)/,
    );
  });

  it('Sync magic-link 2-step contract — request + consume. request: POST /v1/auth/magic-link/request (anonymous; sends email). consume: POST /v1/auth/magic-link/consume (exchange token-from-URL for session). The 2 verbs MUST stay paired — dropping consume would orphan the email links; dropping request would leave consume with nothing to exchange.', () => {
    expect(body).toMatch(/def request_magic_link\(self, body: dict\[str, Any\]\)/);
    expect(body).toMatch(
      /"POST", "\/v1\/auth\/magic-link\/request", json_body=coerce_body\(body\)/,
    );
    expect(body).toMatch(/def consume_magic_link\(self, body: dict\[str, Any\]\)/);
    expect(body).toMatch(
      /"POST", "\/v1\/auth\/magic-link\/consume", json_body=coerce_body\(body\)/,
    );
  });

  it('Sync password-reset 2-step contract — request + confirm. request: POST /v1/auth/password-reset/request (anonymous; sends email). confirm: POST /v1/auth/password-reset/confirm (exchange token + new_password for an updated credential). Mirror of magic-link 2-step but for the lost-password flow.', () => {
    expect(body).toMatch(/def request_password_reset\(self, body: dict\[str, Any\]\)/);
    expect(body).toMatch(
      /"POST", "\/v1\/auth\/password-reset\/request", json_body=coerce_body\(body\)/,
    );
    expect(body).toMatch(/def confirm_password_reset\(self, body: dict\[str, Any\]\)/);
    expect(body).toMatch(
      /"POST", "\/v1\/auth\/password-reset\/confirm", json_body=coerce_body\(body\)/,
    );
  });

  it('Sync session lifecycle — refresh + logout. refresh: POST /v1/auth/refresh exchanges the supplied session token for a new one, revoking the old row and minting a fresh one so a replay of the old token fails. logout: POST /v1/auth/logout revokes the token supplied IN THE BODY rather than the session the call authenticated with, and no-ops on an unknown or already-revoked token. V-1092: this title used to describe an OAuth refresh_token-for-access_token exchange and a logout that revoked the calling session. Neither is the product — RefreshSessionRequestSchema carries the single key `token`, the handler revokes `parsed.data.token`, and the Go pin has described both correctly all along.', () => {
    // Signature and call site are asserted separately so the method may carry
    // a docstring between them. The single regex this replaced required the
    // `return` to follow the signature immediately, which made documenting
    // either method break the pin — and these two are `dict[str, Any]` in and
    // out, so the docstring is the only place a caller learns the key is
    // `token`.
    expect(body).toMatch(/def refresh\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/);
    expect(body).toMatch(
      /return self\._http\.request\("POST", "\/v1\/auth\/refresh", json_body=coerce_body\(body\)\)/,
    );
    expect(body).toMatch(/def logout\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/);
    expect(body).toMatch(
      /return self\._http\.request\("POST", "\/v1\/auth\/logout", json_body=coerce_body\(body\)\)/,
    );

    // The docstrings themselves, since they are now the customer-facing
    // contract for a body this SDK does not type.
    expect(body, 'the refresh docstring no longer names the body key').toMatch(
      /Exchange the supplied session token for a new one[\s\S]{0,200}single key, ``token``/,
    );
    expect(body, 'the logout docstring no longer says which token is revoked').toMatch(
      /revokes THAT token,\s*\n\s*not the session the call authenticated with/,
    );
  });

  it('Sync mfa_challenge — V-445 POST /v1/auth/mfa/challenge. CRITICAL: response carries `via: "totp" | "recovery"` 2-value discriminator. Drift to dropping the discriminator would prevent customers from counting TOTP-vs-recovery use in MFA-strength metrics (recovery-code use signals a higher account-risk than TOTP use). Drift to a 3rd value (e.g. "webauthn") without coordinated server+client update would break the closed-set switch.', () => {
    expect(body).toMatch(/def mfa_challenge\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/);
    expect(body).toMatch(
      /"""V-445 — exchange login challenge_token for a session via TOTP\s*\n\s*code or recovery code\. Response carries ``via: "totp" \| "recovery"``\s*\n\s*indicating which factor was used\.\s*\n\s*"""/,
    );
    expect(body).toMatch(/"POST", "\/v1\/auth\/mfa\/challenge", json_body=coerce_body\(body\)/);
  });

  it('Sync mfa_step_up — V-353e POST /v1/auth/mfa/step-up. CRITICAL invariant: "refresh mfa_satisfied_at on the calling web session (V-353e step-up gate; 15-minute freshness window). No new session issued; the existing session\'s mfa timestamp advances." Drift to issuing a NEW session on step-up would force a session-cookie rotation mid-flow — breaks the "same session identity, just freshly MFA-proved" contract that V-353e relies on for dashboard-flow continuity.', () => {
    expect(body).toMatch(/def mfa_step_up\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/);
    expect(body).toMatch(
      /"""V-445 — refresh ``mfa_satisfied_at`` on the calling web session\s*\n\s*\(V-353e step-up gate; 15-minute freshness window\)\. No new session\s*\n\s*issued; the existing session's mfa timestamp advances\.\s*\n\s*"""/,
    );
    expect(body).toMatch(/"POST", "\/v1\/auth\/mfa\/step-up", json_body=coerce_body\(body\)/);
  });

  it('Sync cli_authorize_initiate — V-460/V-266 step 1/3 POST /v1/auth/cli-authorize/initiate. Returns one-shot `code` + `browser_url`. Public route — CLI is unauthenticated at this point (the CLI is asking to BE authorized). Drift to requiring auth would break the entire CLI activation flow because the CLI has no credentials to present.', () => {
    expect(body).toMatch(
      /def cli_authorize_initiate\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(
      /Returns a one-shot ``code``, device-displayed ``user_code``, and\s*\n\s*``browser_url``\.[\s\S]*?``cli_authorize_exchange`` can return the plaintext API key/,
    );
    expect(body).toMatch(
      /"POST", "\/v1\/auth\/cli-authorize\/initiate", json_body=coerce_body\(body\)/,
    );
  });

  it("Sync cli_authorize_bind — V-460/V-266 step 2/3 verified bind. WEB-SESSION-AUTHENTICATED — called by the dashboard's confirm page AFTER the user signs in. Mints a scoped API key on the calling account and stages it for delivery via exchange. Drift to allowing API-key auth on bind would defeat the human-in-the-loop dashboard-confirm step that prevents drive-by CLI authorization.", () => {
    expect(body).toMatch(
      /def cli_authorize_bind\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(
      /Web-session-authenticated\. Called by the dashboard's confirm page\s*\n\s*after the user submits the initiating device's ``user_code`` and\s*\n\s*clicks Authorize:[\s\S]*?stages it for delivery via exchange/,
    );
    expect(body).toMatch(
      /"POST", "\/v1\/auth\/cli-authorize\/bind-device-code", json_body=coerce_body\(body\)/,
    );
  });

  it('Sync cli_authorize_exchange — V-460/V-266 step 3/3 POST /v1/auth/cli-authorize/exchange. POLLED by the CLI/GUI. CRITICAL: discriminated-union response on `status` — `pending` (keep polling) | `bound` (one-shot delivery; api_key + account_id in body) | `expired`. Drift to dropping `pending` would force the CLI to retry on every error (no way to distinguish "user hasn\'t confirmed yet" from "expired"); drift to dropping `expired` would make the CLI loop forever after the activation window closed.', () => {
    expect(body).toMatch(
      /def cli_authorize_exchange\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(
      /"""V-460 \/ V-266 CLI\/GUI activation flow: exchange\.\s*\n\s*\n\s*Polled by the CLI\/GUI\. Discriminated-union response on\s*\n\s*``status``: ``pending`` \(keep polling\) \/ ``bound`` \(one-shot\s*\n\s*delivery; ``api_key`` \+ ``account_id`` in body\) \/ ``expired``\.\s*\n\s*"""/,
    );
    expect(body).toMatch(
      /"POST", "\/v1\/auth\/cli-authorize\/exchange", json_body=coerce_body\(body\)/,
    );
  });

  it('AsyncAuthResource — class declaration + __init__(http: AsyncHttpClient) + 14-verb mirror of sync surface. Async signup pinned as exemplar; the rest follow the same pattern via the inventory count test below.', () => {
    expect(body).toMatch(/^class AsyncAuthResource:$/m);
    expect(body).toMatch(/^ {4}"""Async auth-flow resource\."""$/m);
    expect(body).toMatch(
      /^ {4}def __init__\(self, http: AsyncHttpClient\) -> None:\s*\n\s*self\._http = http$/m,
    );
    expect(body).toMatch(
      /async def signup\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("POST", "\/v1\/auth\/signup", json_body=coerce_body\(body\)\)/,
    );
    expect(body).toMatch(/async def mfa_challenge\(self, body: dict\[str, Any\]\)/);
    expect(body).toMatch(/async def mfa_step_up\(self, body: dict\[str, Any\]\)/);
    expect(body).toMatch(/async def cli_authorize_initiate\(self, body: dict\[str, Any\]\)/);
    expect(body).toMatch(/async def cli_authorize_bind\(self, body: dict\[str, Any\]\)/);
    expect(body).toMatch(/async def cli_authorize_exchange\(self, body: dict\[str, Any\]\)/);
  });

  it('14-verb POST-only inventory drift guard — sync and async both define exactly 14 method-defs (top-level 4-space indent) + 1 __init__. Drift to a 15th verb (e.g. a SAML or webauthn flow) without doubling test coverage would let an untested code path ship; drift to dropping a verb would silently break a documented auth flow.', () => {
    const syncStart = body.indexOf('class AuthResource:');
    const asyncStart = body.indexOf('class AsyncAuthResource:');
    expect(syncStart, 'expected sync class to come first').toBeGreaterThan(0);
    expect(asyncStart, 'expected async class to come after sync class').toBeGreaterThan(syncStart);
    const syncBody = body.slice(syncStart, asyncStart);
    const asyncBody = body.slice(asyncStart);
    const syncDefs = (syncBody.match(/^ {4}(?:async )?def [a-z_]+\(/gm) ?? []).length;
    expect(syncDefs, 'expected 15 sync method defs (14 verbs + __init__)').toBe(15);
    const asyncDefs = (asyncBody.match(/^ {4}(?:async )?def [a-z_]+\(/gm) ?? []).length;
    expect(asyncDefs, 'expected 15 async method defs (14 verbs + __init__)').toBe(15);
    // Every wire path is /v1/auth/*; ALL verbs are POST (no GET on the
    // auth resource — even introspection is post-auth which lives on
    // /v1/account/me). Drift to a GET verb on /v1/auth/* would change
    // the verb-mix invariant.
    const posts = (body.match(/"POST", "\/v1\/auth\//g) ?? []).length;
    expect(posts, 'expected exactly 28 POST verbs across sync + async (14 each)').toBe(28);
    const gets = (body.match(/"GET", "\/v1\/auth\//g) ?? []).length;
    expect(gets, 'expected ZERO GET verbs on /v1/auth/*').toBe(0);
  });
});
