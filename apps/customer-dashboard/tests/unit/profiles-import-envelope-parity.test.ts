// W345.B — drift guard for the /profiles page Import / Export
// envelope. The page's placeholder JSON shows the exact envelope
// shape the server expects (V-480 ProfileExportEnvelopeSchema):
//
//   {
//     version: 1,
//     exported_at: ISO8601,
//     source_profile_id: 'prof_…',
//     source_account_id: '…',
//     profile: { name, archetype, description }
//   }
//
// If the schema bumps version 1 → 2 (which would be a breaking
// change), the placeholder needs to bump too; otherwise customers
// paste a v1 envelope and the server rejects it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROFILE_EXPORT_ENVELOPE_VERSION } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/profiles.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/profiles.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W345.B /profiles import/export envelope parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  it('placeholder JSON declares the current envelope version', () => {
    expect(PROFILE_EXPORT_ENVELOPE_VERSION).toBe(1);
    expect(page).toMatch(/"version":1/);
  });

  it('placeholder JSON enumerates every required envelope key', () => {
    for (const key of [
      'version',
      'exported_at',
      'source_profile_id',
      'source_account_id',
      'profile',
    ]) {
      expect(page).toMatch(new RegExp(`"${key}":`));
    }
  });

  it('placeholder cites the prof_ id-prefix convention for source_profile_id', () => {
    expect(page).toMatch(/"source_profile_id":"prof_/);
  });

  it('nested profile payload exposes the canonical fields (name / archetype / description)', () => {
    // The ProfileExportPayloadSchema is { name, archetype,
    // description: nullable }. The placeholder must list all three.
    for (const key of ['name', 'archetype', 'description']) {
      expect(page).toMatch(new RegExp(`"${key}":`));
    }
  });

  it('cites every server-side /v1/profiles* route the page exercises', () => {
    // Import / export / list / create / delete — all must be
    // registered.
    for (const path of [
      '/v1/profiles',
      '/v1/profiles/:id',
      '/v1/profiles/:id/export',
      '/v1/profiles/import',
    ]) {
      expect(route).toContain(`'${path}'`);
    }
  });

  it('page wires the rename-on-import override and shows the env-file picker', () => {
    expect(page).toMatch(/data-import-name-override-input/);
    expect(page).toMatch(/data-import-file-input/);
    expect(page).toMatch(/data-import-text-input/);
  });

  it('page narrative cites Profile import/export as the V-480 capability', () => {
    // The mention of "Importing into a different account is
    // permitted" is canonical (transfer between teammate accounts);
    // pin the customer-facing affordance.
    expect(page).toMatch(/Import/);
    expect(page).toMatch(/Export/);
  });

  it('uses prof_ prefix display convention for profile ids', () => {
    // Echoes the id-prefix convention. The export endpoint mints
    // `source_profile_id: prof_<uuid>` server-side.
    expect(route).toMatch(/source_profile_id:\s*`prof_/);
  });
});
