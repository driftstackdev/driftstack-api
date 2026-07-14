// W343.C — drift guard for admin /api-keys SCOPE_LABEL maps.
// Mirror of the customer-dashboard parity test (W340.B): the
// admin page has one SCOPE_LABEL block in the live renderer. It must:
//
//   1. Hold only valid ApiKeyScope values (catches typos / stale
//      scope names after a schema rename).
//   2. Cover the four broad scopes (read/write/admin/account_owner)
//      plus driftstack_internal_admin (the admin-side cross-account
//      surface explicitly needs to render the staff scope clearly).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiKeyScopeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/api-keys.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W343.C admin /api-keys SCOPE_LABEL parity', () => {
  const page = read(PAGE);
  const validScopes = new Set<string>(
    (ApiKeyScopeSchema._def as { values: readonly string[] }).values,
  );

  const blocks = [...page.matchAll(/SCOPE_LABEL[^={]*=\s*\{([^}]*)\}/g)].map((m) => m[1]!);

  it('one live-renderer SCOPE_LABEL block is present', () => {
    expect(blocks.length).toBe(1);
  });

  function keysOf(block: string): string[] {
    return [...block.matchAll(/^\s*([a-z_]+):\s*'[^']+',/gm)].map((m) => m[1]!).sort();
  }

  it('live SCOPE_LABEL keys are unique', () => {
    const keys = keysOf(blocks[0] ?? '');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every SCOPE_LABEL key is a real ApiKeyScope', () => {
    const keys = new Set(blocks.flatMap(keysOf));
    const offenders = [...keys].filter((k) => !validScopes.has(k));
    expect(offenders).toEqual([]);
  });

  it('admin view explicitly renders driftstack_internal_admin (staff badge)', () => {
    // Customer-facing dashboard renders this only because the schema
    // permits it; the admin panel deliberately surfaces it so staff
    // can identify their own keys at a glance.
    const keys = new Set(blocks.flatMap(keysOf));
    expect(keys.has('driftstack_internal_admin')).toBe(true);
  });

  it('SCOPE_LABEL covers the 4 broad scopes (read/write/admin/account_owner)', () => {
    const keys = new Set(blocks.flatMap(keysOf));
    for (const expected of ['read', 'write', 'admin', 'account_owner']) {
      expect(keys.has(expected)).toBe(true);
    }
  });

  it('live rendering uses the raw scope as a defensive fallback', () => {
    expect(page).toMatch(/SCOPE_LABEL\[s\]\s*\|\|\s*s/);
  });

  it('admin warning copy pins immediate-revocation + audit-row guarantees', () => {
    expect(page).toMatch(/invalidates the key immediately/);
    expect(page).toMatch(/Audit row records/);
  });

  it('page filters: account_id input + hide-revoked checkbox', () => {
    expect(page).toMatch(/data-field="account-id"/);
    expect(page).toMatch(/data-field="hide-revoked"/);
  });
});
