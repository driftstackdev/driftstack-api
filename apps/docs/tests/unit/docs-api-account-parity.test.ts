// W254.B — drift-guard for docs/api/account. Pins the documented
// /v1/account/me response shape to the live serialiser. A rename
// of any field (concurrent_session_cap, profile_count, region, …)
// without a doc update would silently make integrators
// `response.fieldName` against undefined.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/account.md');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-me.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W254.B docs/api/account ↔ /v1/account/me serialiser parity', () => {
  const doc = read(DOC);
  const route = read(ROUTE);

  const CORE_FIELDS = [
    'id',
    'email',
    'name',
    'tier',
    'status',
    'timezone',
    'slug',
    'region',
    'avatar_url',
    'mfa_enrolled',
    'concurrent_session_cap',
    'concurrent_session_active',
    'profile_cap',
    'profile_count',
    'teams',
  ] as const;

  it('every documented field appears in the live serialiser', () => {
    for (const f of CORE_FIELDS) {
      // Doc has it (in the `| field |` table).
      expect(doc, `doc missing ${f}`).toMatch(new RegExp(`\`${f}\``));
      // Route returns it.
      expect(route, `route missing ${f}`).toMatch(new RegExp(`${f}:`));
    }
  });

  it('GET /me account-id uses the acc_ prefix', () => {
    expect(doc).toMatch(/`acc_`/);
  });

  it('region enum matches the live us/eu/apac set', () => {
    expect(doc).toMatch(/`us` \/ `eu` \/ `apac`/);
  });

  it('avatar endpoint cited at /v1/account/me/avatar', () => {
    expect(doc).toMatch(/POST \/v1\/account\/me\/avatar/);
    expect(route).toMatch(/'\/v1\/account\/me\/avatar'/);
  });

  it('slug-collision response is 409 Conflict', () => {
    expect(doc).toMatch(/409 Conflict/);
  });
});
