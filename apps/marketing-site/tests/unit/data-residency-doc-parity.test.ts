// W263.C — drift-guard for /docs/data-residency. Pins:
// 1. Region preference enum matches AccountRegionSchema (us / eu / apac).
// 2. PATCH /v1/account/me is the documented mutation endpoint.
// 3. MFA secret encryption + API key hashing claims match the live setup.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRegionSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/data-residency.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W263.C /docs/data-residency ↔ live AccountRegionSchema parity', () => {
  const page = read(PAGE);

  it('region values match AccountRegionSchema enum exactly', () => {
    const live = AccountRegionSchema.options.slice().sort();
    expect(live).toEqual(['apac', 'eu', 'us']);
    for (const r of live) {
      expect(page).toMatch(new RegExp(`<code>${r}</code>`));
    }
  });

  it('PATCH /v1/account/me is the documented mutation endpoint', () => {
    expect(page).toMatch(/PATCH \/v1\/account\/me/);
    const route = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-me.ts'));
    expect(route).toContain(`'/v1/account/me'`);
  });

  it('MFA secret encryption claim matches the live AES-256 setup', () => {
    expect(page).toMatch(/AES-256/);
    expect(page).toMatch(/MFA_ENCRYPTION_KEY/);
    const mfa = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(mfa).toMatch(/MFA_ENCRYPTION_KEY/);
  });

  it('API key hashing claim matches the live scrypt N=2^15 setup', () => {
    expect(page).toMatch(/scrypt/);
    expect(page).toMatch(/logN=15|N=2\^15/);
    const apiKeys = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    // The live cost parameter is N=2^15.
    expect(apiKeys).toMatch(/scrypt/i);
  });

  it('Postgres + R2 sub-processor regions match the SUB_PROCESSORS list', () => {
    expect(page).toMatch(/Postgres \(Neon, EU\)/);
    expect(page).toMatch(/R2/);
  });
});
