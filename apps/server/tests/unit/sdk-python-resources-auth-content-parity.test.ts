// W583.A — drift guard for packages/sdk-python/src/resources/auth.py.
// V-079 AuthResource Python parity. Drift here either drops one of
// the 14 auth-flow verbs or breaks the V-460/V-266 CLI/GUI 3-step
// activation handshake (initiate → bind → exchange).
//
//   • 14 verbs each: signup / verify_email / login / request_magic_
//     link / consume_magic_link / request_password_reset / confirm_
//     password_reset / refresh / logout / mfa_challenge / mfa_step_up
//     / cli_authorize_initiate / cli_authorize_bind / cli_authorize_
//     exchange.
//   • Public routes (server ignores Authorization header) — Auth-
//     gate framing pinned.
//   • V-445 mfa_challenge response carries via: "totp" | "recovery".
//   • V-353e mfa_step_up: 15-minute freshness window; no new session
//     issued (timestamp advance only).
//   • V-460/V-266 CLI/GUI activation: initiate (one-shot code +
//     browser_url) → bind (web-session-auth; mint+stage) → exchange
//     (polled; pending/bound/expired discriminated union).

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

  it('Module docstring + V-079 framing + auth-gate-public-routes posture + Authorization-header-ignored + ergonomics+TS-symmetry rationale pinned', () => {
    expect(body).toMatch(/^"""Auth-flow resource — \/v1\/auth\/\* \(V-079\)\.\n/);
    expect(body).toMatch(/These endpoints don't require an API key \(they ARE the auth gate\)\./);
    expect(body).toMatch(/The SDK's HTTP layer always sends the Authorization header; the/);
    expect(body).toMatch(/server ignores it on these public routes\. The resource exists for/);
    expect(body).toMatch(/ergonomics \+ type symmetry with the TypeScript SDK\./);
    expect(body).toMatch(/``dict\[str, Any\]`` typing pending the next regen pass\./);
  });

  it('Sync AuthResource: 9 baseline verbs (signup / verify_email / login / magic-link request+consume / password-reset request+confirm / refresh / logout) pinned with coerce_body', () => {
    expect(body).toMatch(/^class AuthResource:$/m);
    expect(body).toMatch(
      /def signup\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return self\._http\.request\("POST", "\/v1\/auth\/signup", json_body=coerce_body\(body\)\)/,
    );
    expect(body).toMatch(
      /def verify_email\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return self\._http\.request\("POST", "\/v1\/auth\/verify-email", json_body=coerce_body\(body\)\)/,
    );
    expect(body).toMatch(
      /def login\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return self\._http\.request\("POST", "\/v1\/auth\/login", json_body=coerce_body\(body\)\)/,
    );
    expect(body).toMatch(/def request_magic_link\(self, body: dict\[str, Any\]\)/);
    expect(body).toMatch(
      /"POST", "\/v1\/auth\/magic-link\/request", json_body=coerce_body\(body\)/,
    );
    expect(body).toMatch(/def consume_magic_link\(self, body: dict\[str, Any\]\)/);
    expect(body).toMatch(
      /"POST", "\/v1\/auth\/magic-link\/consume", json_body=coerce_body\(body\)/,
    );
    expect(body).toMatch(/def request_password_reset\(self, body: dict\[str, Any\]\)/);
    expect(body).toMatch(
      /"POST", "\/v1\/auth\/password-reset\/request", json_body=coerce_body\(body\)/,
    );
    expect(body).toMatch(/def confirm_password_reset\(self, body: dict\[str, Any\]\)/);
    expect(body).toMatch(
      /"POST", "\/v1\/auth\/password-reset\/confirm", json_body=coerce_body\(body\)/,
    );
    expect(body).toMatch(
      /def refresh\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return self\._http\.request\("POST", "\/v1\/auth\/refresh", json_body=coerce_body\(body\)\)/,
    );
    expect(body).toMatch(
      /def logout\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return self\._http\.request\("POST", "\/v1\/auth\/logout", json_body=coerce_body\(body\)\)/,
    );
  });

  it('Sync MFA verbs: V-445 mfa_challenge via "totp" | "recovery" + V-353e mfa_step_up 15-min freshness window (no new session; timestamp advance only)', () => {
    expect(body).toMatch(/def mfa_challenge\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""V-445 — exchange login challenge_token for a session via TOTP/);
    expect(body).toMatch(/code or recovery code\. Response carries ``via: "totp" \| "recovery"``/);
    expect(body).toMatch(/indicating which factor was used\./);
    expect(body).toMatch(/"POST", "\/v1\/auth\/mfa\/challenge", json_body=coerce_body\(body\)/);
    expect(body).toMatch(/def mfa_step_up\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""V-445 — refresh ``mfa_satisfied_at`` on the calling web session/);
    expect(body).toMatch(/\(V-353e step-up gate; 15-minute freshness window\)\. No new session/);
    expect(body).toMatch(/issued; the existing session's mfa timestamp advances\./);
    expect(body).toMatch(/"POST", "\/v1\/auth\/mfa\/step-up", json_body=coerce_body\(body\)/);
  });

  it('Sync V-460/V-266 CLI/GUI activation handshake: initiate → bind → exchange; one-shot code + browser_url; web-session-auth on bind; pending/bound/expired discriminated-union on exchange', () => {
    expect(body).toMatch(
      /def cli_authorize_initiate\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(/"""V-460 \/ V-266 CLI\/GUI activation flow: initiate\./);
    expect(body).toMatch(/Returns a one-shot ``code`` \+ ``browser_url``; the CLI\/GUI opens/);
    expect(body).toMatch(/the URL, the user signs in to the dashboard and confirms the/);
    expect(body).toMatch(/activation, after which ``cli_authorize_exchange`` returns the/);
    expect(body).toMatch(/plaintext API key\./);
    expect(body).toMatch(
      /def cli_authorize_bind\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(/"""V-460 \/ V-266 CLI\/GUI activation flow: bind\./);
    expect(body).toMatch(/Web-session-authenticated\. Called by the dashboard's confirm page/);
    expect(body).toMatch(/after the user clicks Authorize: mints a scoped API key on the/);
    expect(body).toMatch(/calling account and stages it for delivery via exchange\./);
    expect(body).toMatch(
      /def cli_authorize_exchange\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(/"""V-460 \/ V-266 CLI\/GUI activation flow: exchange\./);
    expect(body).toMatch(/Polled by the CLI\/GUI\. Discriminated-union response on/);
    expect(body).toMatch(/``status``: ``pending`` \(keep polling\) \/ ``bound`` \(one-shot/);
    expect(body).toMatch(/delivery; ``api_key`` \+ ``account_id`` in body\) \/ ``expired``\./);
  });

  it('Async AsyncAuthResource: mirrored awaited 14-verb surface', () => {
    expect(body).toMatch(/^class AsyncAuthResource:$/m);
    expect(body).toMatch(
      /async def signup\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("POST", "\/v1\/auth\/signup", json_body=coerce_body\(body\)\)/,
    );
    expect(body).toMatch(/async def mfa_challenge\(self, body: dict\[str, Any\]\)/);
    expect(body).toMatch(/async def mfa_step_up\(self, body: dict\[str, Any\]\)/);
    expect(body).toMatch(/async def cli_authorize_initiate\(self, body: dict\[str, Any\]\)/);
    expect(body).toMatch(/async def cli_authorize_bind\(self, body: dict\[str, Any\]\)/);
    expect(body).toMatch(/async def cli_authorize_exchange\(self, body: dict\[str, Any\]\)/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
