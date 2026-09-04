// W259.B — drift-guard for docs.driftstack.io/guides/profile-management.
// Pins:
// 1. Profile id prefix is `prof_` (route serialiser), not the legacy `prf_`.
// 2. Snapshot id prefix is `psnap_` (matches W256.C).
// 3. /v1/profiles/* + /v1/profile-snapshots/* paths cited are registered.
// 4. Tier-cap exceeded returns 429 (TierLimitError), not the legacy 402.
// 5. Profile cap values match PROFILES_PER_TIER.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROFILES_PER_TIER } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/guides/profile-management.md');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/profiles.ts');
const SNAP_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/profile-snapshots.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W259.B docs/guides/profile-management ↔ live profiles surface parity', () => {
  const doc = read(DOC);
  const route = read(ROUTE);
  const snapRoute = read(SNAP_ROUTE);

  it('profile id prefix is prof_ (no legacy prf_)', () => {
    expect(doc).not.toMatch(/`prf_/);
    expect(doc).toMatch(/prof_/);
    // Live serialiser.
    expect(route).toMatch(/`prof_\$\{[^}]+\}`/);
  });

  it('snapshot id prefix is psnap_ (matches the live serialiser)', () => {
    expect(doc).toMatch(/psnap_</);
    expect(snapRoute).toMatch(/`psnap_\$\{[^}]+\}`/);
  });

  it('every /v1/profiles/* endpoint cited is registered', () => {
    for (const path of [
      '/v1/profiles',
      '/v1/profiles/:id',
      '/v1/profiles/:id/clone',
      '/v1/profiles/:id/snapshots',
    ]) {
      expect(doc).toContain(path);
      expect(route + snapRoute).toContain(`'${path}'`);
    }
  });

  it('snapshot delete endpoint /v1/profile-snapshots/:id is documented + registered', () => {
    expect(doc).toContain('/v1/profile-snapshots/:id');
    expect(snapRoute).toContain(`'/v1/profile-snapshots/:id'`);
  });

  it('tier-cap exceeded returns 429 (TierLimitError), not the legacy 402', () => {
    expect(doc).not.toMatch(/returns `402`/);
    expect(doc).toMatch(/returns `429`/);
    expect(doc).toMatch(/errors\.driftstack\.dev\/tier-limit/);
  });

  it('tier-cap table values match PROFILES_PER_TIER exactly', () => {
    // Spot-check the public tiers shown in the doc.
    expect(PROFILES_PER_TIER.solo_manual).toBe(10);
    expect(PROFILES_PER_TIER.team_manual).toBe(50);
    expect(PROFILES_PER_TIER.agency_manual).toBe(200);
    expect(PROFILES_PER_TIER.api_starter).toBe(25);
    expect(PROFILES_PER_TIER.api_builder).toBe(100);
    expect(PROFILES_PER_TIER.api_scale).toBe(500);
    // Doc must reproduce them.
    for (const cap of [10, 50, 200, 25, 100, 500]) {
      expect(doc).toMatch(new RegExp(`\\|\\s*${cap}\\s*\\|`));
    }
  });

  it('cross-link targets exist', () => {
    expect(doc).toMatch(/\/guides\/session-lifecycle/);
    expect(doc).toMatch(/\/api\/versioning/);
    expect(doc).toMatch(/\/webhooks\/events/);
    expect(
      readFileSync(resolve(REPO_ROOT, 'apps/docs/src/pages/guides/session-lifecycle.md'), 'utf8')
        .length,
    ).toBeGreaterThan(0);
    expect(
      readFileSync(resolve(REPO_ROOT, 'apps/docs/src/pages/api/versioning.md'), 'utf8').length,
    ).toBeGreaterThan(0);
  });
});
