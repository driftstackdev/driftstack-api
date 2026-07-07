// W264.D — drift-guard for /docs/cli-quickstart. Pins:
// 1. CLI-authorize three-step flow routes are registered.
// 2. 5-minute activation TTL claim matches the live cli-authorize service.
// 3. CLI binary name `driftstack` is consistent.
// 4. Cross-link /docs/api-quickstart exists.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/cli-quickstart.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth-cli.ts');
const SERVICE = resolve(REPO_ROOT, 'apps/server/src/services/cli-authorize.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W264.D /docs/cli-quickstart ↔ live cli-authorize parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);
  const service = read(SERVICE);

  it('CLI-facing /initiate + /exchange endpoints documented; /bind is server-side', () => {
    // The CLI binary only ever calls initiate + exchange. The /bind
    // endpoint is server-internal (called by the dashboard during the
    // V-266 activation flow), so the doc doesn't mention it.
    for (const path of ['/v1/auth/cli-authorize/initiate', '/v1/auth/cli-authorize/exchange']) {
      expect(page).toContain(path);
      expect(route).toContain(`'${path}'`);
    }
    // Verify /bind exists on the route file even though the doc doesn't cite it.
    expect(route).toContain(`'/v1/auth/cli-authorize/bind'`);
  });

  it('5-minute activation TTL claim matches the live service constant', () => {
    expect(page).toMatch(/5 minutes/);
    expect(service).toMatch(/5-minute TTL/);
  });

  it('CLI binary name "driftstack" is the live convention', () => {
    expect(page).toMatch(/`driftstack`|driftstack login|driftstack --version/);
  });

  it('OS keyring storage claim matches the supported platforms', () => {
    expect(page).toMatch(/macOS Keychain/);
    expect(page).toMatch(/Linux libsecret/);
    expect(page).toMatch(/Windows\s+Credential Manager/);
  });

  it('/cli/authorize browser URL points at the dashboard origin (app.driftstack.dev)', () => {
    expect(page).toMatch(/app\.driftstack\.dev\/cli\/authorize/);
  });

  it('cross-link points at the docs curl-quickstart successor; the deleted mirror stays gone (S47 2026-07-07 mirror deprecation)', () => {
    expect(page).toContain('https://docs.driftstack.dev/quickstart-curl/');
    expect(existsSync(resolve(REPO_ROOT, 'apps/docs/src/pages/quickstart-curl.md'))).toBe(true);
    // A restored mirror page would shadow its 301 in public/_redirects.
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/api-quickstart.astro')),
    ).toBe(false);
  });
});
