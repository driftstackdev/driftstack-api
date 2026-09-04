// W256.A — drift-guard for docs.driftstack.io/api/auth. Pins every
// /v1/auth/* endpoint named in the doc to a live registration on
// auth.ts. The doc is the customer-facing reference for the
// dashboard auth flow; a stale path here breaks GUI activation and
// password-reset emails.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/auth.md');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');
const ROUTE_CLI = resolve(REPO_ROOT, 'apps/server/src/routes/auth-cli.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W256.A docs/api/auth ↔ /v1/auth/* parity', () => {
  const doc = read(DOC);
  const route = read(ROUTE);
  const cli = read(ROUTE_CLI);

  it('every documented /v1/auth/* endpoint is registered', () => {
    const CORE = [
      '/v1/auth/signup',
      '/v1/auth/verify-email',
      '/v1/auth/login',
      '/v1/auth/mfa/challenge',
      '/v1/auth/mfa/step-up',
      '/v1/auth/magic-link/request',
      '/v1/auth/magic-link/consume',
      '/v1/auth/password-reset/request',
      '/v1/auth/password-reset/confirm',
      '/v1/auth/refresh',
      '/v1/auth/logout',
    ];
    for (const path of CORE) {
      expect(doc).toContain(path);
      expect(route).toContain(`'${path}'`);
    }
  });

  it('CLI-authorize three-step flow uses the registered endpoints', () => {
    for (const path of [
      '/v1/auth/cli-authorize/initiate',
      '/v1/auth/cli-authorize/bind-device-code',
      '/v1/auth/cli-authorize/exchange',
    ]) {
      expect(doc).toContain(path);
      expect(cli).toContain(`'${path}'`);
    }
  });

  it('signup duplicate-email returns 409', () => {
    expect(doc).toMatch(/409 Conflict/);
  });

  it('cites the two token shapes the server accepts', () => {
    expect(doc).toMatch(/ds_live_/);
    expect(doc).toMatch(/ds_test_/);
  });

  it('says /v1/auth/* does not honor X-Driftstack-Account team scoping', () => {
    expect(doc).toMatch(/None of `\/v1\/auth\/\*` honors the team-RBAC/);
  });

  it('pins browser-authorized Free device credentials separately from paid API keys', () => {
    expect(doc).toMatch(/Driftstack has three auth surfaces/);
    expect(doc).toMatch(/Customer API-key bearer auth/);
    expect(doc).toMatch(/Browser-authorized device credentials/);
    expect(doc).toMatch(/not a general sandbox\/customer key/);
    expect(doc).toMatch(/The "apiAccess" feature is not available on the "free" tier/);
    expect(doc).not.toMatch(/feature_not_available/);
  });
});
