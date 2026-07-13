// W1034 — routes/auth-cli V-266 cross-source invariant. Three-hundred-
// sixtieth in the drift-guard series. Pins the apps/server/src/
// routes/auth-cli.ts browser-OAuth CLI activation routes:
//
//   V-266 anchor — 'V-266 — Browser-OAuth-style activation flow for
//   CLI / GUI clients'.
//
//   3-endpoint inventory:
//     - POST /v1/auth/cli-authorize/initiate — public; CLI/GUI starts.
//     - POST /v1/auth/cli-authorize/bind     — auth required;
//       dashboard binds the code.
//     - POST /v1/auth/cli-authorize/exchange — public; CLI/GUI polls
//       for the issued key.
//
//   Bind framing — 'The bind endpoint requires an authenticated
//   account (typically via the dashboard's web session). It mints an
//   API key on that account and hands the plaintext to the CLI/GUI
//   via the exchange endpoint'.
//
//   DEFAULT_KEY_NAME = 'Desktop client'.
//   DEFAULT_SCOPES = ['account_owner'].
//
//   initiate returns { code, browser_url, expires_at (ISO) }.
//
//   bind 5-arg cli-authorize call — code + state + account_id (acc_
//     prefix) + api_key_plaintext + scopes.
//
//   bind revoke-on-failure framing — 'Revoke the just-minted key —
//   the bind failed, so the plaintext we created above can't reach a
//   client. Best-effort; the key remains in the DB as revoked if
//   revoke fails for any reason, which is the safe direction'.
//
//   mapCliAuthorizeError 5-branch:
//     - 'state_mismatch' → BadRequestError.
//     - 'already_bound' → BadRequestError.
//     - 'not_found' / 'expired' → NotFoundError.
//     - 'invalid_code' → BadRequestError.
//
// stays in lockstep across apps/server/src/routes/auth-cli.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1034 routes/auth-cli V-266 cross-source invariant', () => {
  it('CRITICAL V-266 anchor + 3-endpoint inventory.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/auth-cli.ts'));
    expect(p).toMatch(/V-266 — Browser-OAuth-style activation flow for CLI \/ GUI clients\./);
    expect(p).toMatch(
      /POST \/v1\/auth\/cli-authorize\/initiate\s+— public; CLI\/GUI starts the flow/,
    );
    expect(p).toMatch(
      /POST \/v1\/auth\/cli-authorize\/bind\s+— auth required; dashboard binds the code/,
    );
    expect(p).toMatch(
      /POST \/v1\/auth\/cli-authorize\/exchange\s+— public; CLI\/GUI polls for the issued key/,
    );
  });

  it("CRITICAL bind framing — 'The bind endpoint requires an authenticated account (typically via the dashboard's web session). It mints an API key on that account and hands the plaintext to the CLI/GUI via the exchange endpoint'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/auth-cli.ts'));
    expect(p).toMatch(/\/\/ The bind endpoint requires an authenticated account \(typically via/);
    expect(p).toMatch(/\/\/ the dashboard's web session\)\. It mints an API key on that account/);
    expect(p).toMatch(/\/\/ and hands the plaintext to the CLI\/GUI via the exchange endpoint\./);
  });

  it("CRITICAL DEFAULT_KEY_NAME = 'Desktop client' + DEFAULT_SCOPES = ['account_owner'].", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/auth-cli.ts'));
    expect(p).toMatch(/const DEFAULT_KEY_NAME = 'Desktop client';/);
    expect(p).toMatch(/const DEFAULT_SCOPES: ApiKeyScope\[\] = \['account_owner'\];/);
  });

  it('CRITICAL initiate returns { code, browser_url, expires_at (ISO) }.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/auth-cli.ts'));
    expect(p).toMatch(/code: result\.code,/);
    expect(p).toMatch(/browser_url: result\.browser_url,/);
    expect(p).toMatch(/expires_at: result\.expires_at\.toISOString\(\),/);
  });

  it('CRITICAL bind 5-arg cli-authorize call — code + state + account_id (acc_ prefix) + api_key_plaintext + scopes.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/auth-cli.ts'));
    expect(p).toMatch(/code: parsed\.data\.code,/);
    expect(p).toMatch(/state: parsed\.data\.state,/);
    expect(p).toMatch(/account_id: `acc_\$\{ctx\.account\.id\}`,/);
    expect(p).toMatch(/api_key_plaintext: created\.plaintext,/);
    expect(p).toMatch(/scopes,/);
  });

  it('CRITICAL bind compensation covers every thrown bind failure, logs a secondary revoke failure, and preserves/maps the original error.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/auth-cli.ts'));
    expect(p).toMatch(/\/\/ Every failed bind must retire the just-minted key, including/);
    expect(p).toMatch(/await apiKeysService\.revoke\(ctx, created\.row\.id\);/);
    expect(p).toMatch(/catch \(revokeErr\)/);
    expect(p).toMatch(/apiKeyId: created\.row\.id/);
    expect(p).toMatch(/if \(err instanceof CliAuthorizeError\) throw mapCliAuthorizeError\(err\);/);
    expect(p).toMatch(/throw err;/);
  });

  it("CRITICAL mapCliAuthorizeError 5-branch — 'state_mismatch' → BadRequestError 'State parameter does not match.' + 'already_bound' → BadRequestError + 'not_found'/'expired' → NotFoundError 'Authorization code not found or expired.' + 'invalid_code' → BadRequestError 'Authorization code is invalid.'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/auth-cli.ts'));
    expect(p).toMatch(/case 'state_mismatch':/);
    expect(p).toMatch(/return new BadRequestError\('State parameter does not match\.'\);/);
    expect(p).toMatch(/case 'already_bound':/);
    expect(p).toMatch(
      /return new BadRequestError\('Authorization code has already been bound\.'\);/,
    );
    expect(p).toMatch(/case 'not_found':/);
    expect(p).toMatch(/case 'expired':/);
    expect(p).toMatch(/return new NotFoundError\('Authorization code not found or expired\.'\);/);
    expect(p).toMatch(/case 'invalid_code':/);
    expect(p).toMatch(/return new BadRequestError\('Authorization code is invalid\.'\);/);
  });

  it("CRITICAL initiate + exchange are public but each carries a dedicated per-IP gate (initiate 5/min, exchange 60/min poll); bind has [requireAuth, rateLimit('global')].", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/auth-cli.ts'));
    expect(p).toMatch(
      /app\.post\('\/v1\/auth\/cli-authorize\/initiate', \{ preHandler: \[initiateGate\] \}, async/,
    );
    expect(p).toMatch(
      /app\.post\('\/v1\/auth\/cli-authorize\/exchange', \{ preHandler: \[exchangeGate\] \}, async/,
    );
    expect(p).toMatch(/preHandler: \[app\.requireAuth, app\.rateLimit\('global'\)\]/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/routes-auth-cli-v266-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
