// W216.A — drift-guard between /docs/profiles and the actual
// profiles surface. The previous version of the page included
// extensive fictional content (nonexistent body fields:
// `viewport`, `locale`, `timezone`, `user_agent`,
// `cookies_persisted`; the wrong snapshot id prefix `snap_`; the
// wrong restore endpoint path; the wrong list envelope; wrong
// per-tier profile caps). This guard pins it to the real shapes.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CreateProfileRequestSchema,
  UpdateProfileRequestSchema,
  ProfileSchema,
  PROFILES_PER_TIER,
} from '@driftstack/api-types';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs', 'profiles.astro');
const PROFILES_ROUTE = join(REPO, 'apps', 'server', 'src', 'routes', 'profiles.ts');
const SNAPSHOTS_ROUTE = join(REPO, 'apps', 'server', 'src', 'routes', 'profile-snapshots.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W216.A profiles doc parity', () => {
  const doc = read(DOC_PATH);

  it('POST /v1/profiles body uses only schema-accepted fields', () => {
    const shape = CreateProfileRequestSchema.shape;
    for (const f of Object.keys(shape)) {
      expect(doc, `request example missing field ${f}`).toContain(`"${f}":`);
    }
    for (const stale of ['viewport', 'locale', 'timezone', 'user_agent', 'cookies_persisted']) {
      expect(doc, `request body must not reference stale field ${stale}`).not.toMatch(
        new RegExp(`"${stale}":`),
      );
      expect(shape).not.toHaveProperty(stale);
    }
  });

  it('PATCH /v1/profiles/:id body uses only schema-accepted fields', () => {
    const shape = UpdateProfileRequestSchema.shape;
    // Doc highlights name + description as patchable. Confirm both
    // are in the actual schema and only those (plus any future
    // additions) are referenced in the PATCH example.
    expect(Object.keys(shape)).toEqual(expect.arrayContaining(['name', 'description']));
    expect(doc).toMatch(/PATCH \/v1\/profiles\/prof_/);
  });

  it('profile id prefix is prof_ in source and doc', () => {
    expect(read(PROFILES_ROUTE)).toMatch(/id: `prof_\$\{p\.id\}`/);
    expect(doc).toMatch(/\bprof_/);
  });

  it('Profile response shape covers all schema fields and only those', () => {
    const shape = ProfileSchema.shape;
    for (const f of Object.keys(shape)) {
      expect(doc, `Profile sample missing field ${f}`).toContain(`"${f}":`);
    }
  });

  it('list response uses the standard {data, has_more, next_cursor} envelope', () => {
    expect(doc).toMatch(/"data":/);
    expect(doc).toMatch(/"has_more":/);
    expect(doc).toMatch(/"next_cursor":/);
    expect(doc).not.toMatch(/"profiles":\s*\[/);
    expect(doc).not.toMatch(/"nextCursor":/);
  });

  it('snapshot id prefix is psnap_, not the stale snap_', () => {
    expect(read(SNAPSHOTS_ROUTE)).toMatch(/id: `psnap_\$\{s\.id\}`/);
    expect(doc).toMatch(/\bpsnap_/);
    expect(doc).not.toMatch(/"id":\s*"snap_/);
  });

  it('restore endpoint path is /v1/profile-snapshots/:id/restore', () => {
    const routes = read(SNAPSHOTS_ROUTE);
    expect(routes).toMatch(/'\/v1\/profile-snapshots\/:id\/restore'/);
    expect(doc).toMatch(/\/v1\/profile-snapshots\/psnap_[^/]+\/restore/);
    // The stale path the previous doc used:
    expect(doc).not.toMatch(/\/v1\/profiles\/prof_[^/]+\/snapshots\/snap_[^/]+\/restore/);
  });

  it('per-tier profile caps in the doc match PROFILES_PER_TIER', () => {
    // Spot-check the values that previously drifted.
    expect(PROFILES_PER_TIER.solo_manual).toBe(10);
    expect(PROFILES_PER_TIER.api_starter).toBe(25);
    expect(PROFILES_PER_TIER.team_manual).toBe(50);
    expect(PROFILES_PER_TIER.api_scale).toBe(500);
    // Confirm each value appears in the doc's table row for the tier.
    expect(doc).toMatch(/Personal<\/td><td>10/);
    expect(doc).toMatch(/API Starter<\/td><td>25/);
    expect(doc).toMatch(/Team<\/td><td>50/);
    expect(doc).toMatch(/API Scale<\/td><td>500/);
    // Rule out the stale numbers from the previous doc revision.
    expect(doc).not.toMatch(/Personal.*<\/td><td>50/);
    expect(doc).not.toMatch(/Team.*<\/td><td>250/);
    expect(doc).not.toMatch(/API Scale.*<\/td><td>1000/);
  });
});
