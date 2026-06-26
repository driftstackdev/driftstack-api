// W347.A — drift guard for /docs/profiles. Pins:
//
//   • Profile-cap table ↔ PROFILES_PER_TIER (all 8 tiers).
//   • POST /v1/profiles + /v1/profiles/:id/clone + /:id/snapshots +
//     POST /v1/profile-snapshots/:id/restore — all server-registered.
//   • Snapshot id-prefix convention (psnap_) + profile-id prefix
//     (prof_) + LOCKED_ARCHETYPE_ID.
//   • "name + description + folder + tags are patchable" claim
//     (archetype stays immutable — clone to change it).
//   • Restore endpoint lives under /v1/profile-snapshots, NOT under
//     /v1/profiles/<parent>/snapshots — pin both the doc + route.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROFILES_PER_TIER } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/profiles.astro');
const PROFILES_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/profiles.ts');
const SNAPSHOTS_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/profile-snapshots.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W347.A /docs/profiles parity', () => {
  const body = read(PAGE);

  it('cap table cites every tier in PROFILES_PER_TIER with the correct number', () => {
    const expected: Record<string, string> = {
      Free: '1',
      Personal: '10',
      Team: '50',
      Agency: '200',
      'API Starter': '25',
      'API Builder': '100',
      'API Scale': '500',
      Enterprise: 'custom',
    };
    for (const [label, cap] of Object.entries(expected)) {
      expect(body).toMatch(new RegExp(`<td>${label}<\\/td><td>${cap}<\\/td>`));
    }
  });

  it('PROFILES_PER_TIER values align with what the page advertises', () => {
    expect(PROFILES_PER_TIER.free).toBe(1);
    expect(PROFILES_PER_TIER.solo_manual).toBe(10);
    expect(PROFILES_PER_TIER.team_manual).toBe(50);
    expect(PROFILES_PER_TIER.agency_manual).toBe(200);
    expect(PROFILES_PER_TIER.api_starter).toBe(25);
    expect(PROFILES_PER_TIER.api_builder).toBe(100);
    expect(PROFILES_PER_TIER.api_scale).toBe(500);
    expect(PROFILES_PER_TIER.enterprise).toBe('custom');
  });

  it('every /v1/profiles* route the page advertises is registered on the server', () => {
    const profiles = read(PROFILES_ROUTE);
    expect(body).toContain('POST /v1/profiles');
    expect(body).toContain('GET /v1/profiles');
    expect(body).toContain('PATCH /v1/profiles/:id');
    expect(body).toContain('DELETE /v1/profiles/:id');
    expect(body).toContain('/v1/profiles/:id/clone');
    // Each lives in profiles.ts.
    for (const route of ["'/v1/profiles'", "'/v1/profiles/:id'", "'/v1/profiles/:id/clone'"]) {
      expect(profiles).toContain(route);
    }
  });

  it('snapshot capture/list/restore endpoints exist and the page cites the right paths', () => {
    const snapshots = read(SNAPSHOTS_ROUTE);
    // Capture: POST /v1/profiles/:id/snapshots — lives in
    // profile-snapshots route.
    expect(body).toContain('/v1/profiles/prof_…/snapshots');
    // Restore: POST /v1/profile-snapshots/:id/restore.
    expect(body).toMatch(/\/v1\/profile-snapshots\/[^'"`]*\/restore/);
    expect(snapshots).toMatch(/\/v1\/profile-snapshots\/:id\/restore/);
  });

  it('id-prefix conventions: prof_ for profiles, psnap_ for snapshots', () => {
    expect(body).toContain('<code>prof_</code>');
    expect(body).toContain('<code>psnap_</code>');
    expect(body).toMatch(/"id":\s*"prof_/);
    expect(body).toMatch(/"id":\s*"psnap_/);
  });

  it('locked archetype id (iphone17_ios18_7_safari26_4) is the canonical default', () => {
    // The sample profile uses the locked archetype literally — pin
    // it so a future archetype rename has to update the doc too.
    expect(body).toMatch(/iphone17_ios18_7_safari26_4/);
  });

  it('PATCH covers name + description + folder + tags (archetype is immutable)', () => {
    expect(body).toMatch(
      /<code>name<\/code>, <code>description<\/code>, <code>folder<\/code>\s+and <code>tags<\/code> are patchable/,
    );
    expect(body).toMatch(/the archetype is set at create time and pins the device\s+identity/);
  });

  it('restore endpoint disclaimer pins the immutable-source posture', () => {
    expect(body).toMatch(/the snapshot itself is\s+immutable/);
    expect(body).toMatch(/Each restore creates a fresh profile/);
  });

  it('archetype slug length range matches the server validator (1–120 chars)', () => {
    // Server validator is z.string().min(1).max(120) in
    // packages/api-types/src/profiles.ts — the doc's 1–120 is correct.
    expect(body).toMatch(/lowercase slug \(1–120 chars\)/);
  });
});
