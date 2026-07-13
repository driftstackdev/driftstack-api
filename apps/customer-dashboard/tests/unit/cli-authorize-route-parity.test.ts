// W321.C — drift guard for dashboard /cli/authorize page. The
// dashboard side of the CLI auth flow binds an initiate code to
// the signed-in account via POST /v1/auth/cli-authorize/bind-device-code.
// The server must register that route.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/cli/authorize.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth-cli.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W321.C dashboard /cli/authorize ↔ auth-cli route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  it('page calls POST /v1/auth/cli-authorize/bind-device-code', () => {
    expect(page).toContain('/v1/auth/cli-authorize/bind-device-code');
  });

  it('server registers /v1/auth/cli-authorize/bind-device-code', () => {
    expect(route).toContain("'/v1/auth/cli-authorize/bind-device-code'");
  });

  it('server registers /v1/auth/cli-authorize/initiate (CLI side, kicks off flow)', () => {
    expect(route).toContain("'/v1/auth/cli-authorize/initiate'");
  });

  it('server registers /v1/auth/cli-authorize/exchange (CLI side, polls for token)', () => {
    expect(route).toContain("'/v1/auth/cli-authorize/exchange'");
  });
});
