// W273.A — drift-guard for customer-dashboard /cli/authorize page.
// Pins POST /v1/auth/cli-authorize/bind-device-code to its live registration in
// auth-cli.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/cli/authorize.astro');
const AUTH_CLI = resolve(REPO_ROOT, 'apps/server/src/routes/auth-cli.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W273.A /cli/authorize page ↔ /v1/auth/cli-authorize/bind-device-code parity', () => {
  const page = read(PAGE);
  const auth = read(AUTH_CLI);

  it('POST /v1/auth/cli-authorize/bind-device-code is registered on the server', () => {
    expect(page).toMatch(/\/v1\/auth\/cli-authorize\/bind-device-code/);
    expect(auth).toMatch(/['"`]\/v1\/auth\/cli-authorize\/bind-device-code['"`]/);
  });

  it('uses ds_web_session_token for auth (binding step requires login)', () => {
    expect(page).toMatch(/ds_web_session_token/);
  });

  it('does not reference the non-existent /v1/auth/cli-authorize/poll route', () => {
    // CLI polls /v1/auth/cli-authorize/exchange, not /poll. Make sure the
    // dashboard never points users at a phantom polling endpoint.
    expect(page).not.toMatch(/\/v1\/auth\/cli-authorize\/poll/);
  });
});
