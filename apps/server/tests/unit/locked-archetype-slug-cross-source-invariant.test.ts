// Cross-source invariant: the locked-default archetype slug
// 'iphone16pro_ios18_7_safari26_4' appears in 3+ places — DB
// schema defaults (profiles + sessions tables) + docs/guides/
// profile-management.md + docs/api/profiles.md. Drift would either
// have the DB default mint a slug the docs don't promise, or the
// docs promise a slug the DB won't mint.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SCHEMA = resolve(REPO_ROOT, 'apps/server/src/db/schema.ts');
const PROFILE_DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/guides/profile-management.md');
const PROFILE_API = resolve(REPO_ROOT, 'apps/docs/src/pages/api/profiles.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('locked-archetype-slug cross-source invariant', () => {
  const schema = read(SCHEMA);
  const profileDoc = read(PROFILE_DOC);
  const profileApi = read(PROFILE_API);

  it("DB schema profiles + sessions tables BOTH default archetype to 'iphone16pro_ios18_7_safari26_4'", () => {
    const occurrences = (
      schema.match(
        /archetype: text\('archetype'\)\.notNull\(\)\.default\('iphone16pro_ios18_7_safari26_4'\)/g,
      ) || []
    ).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("docs/guides/profile-management.md customer copy explicitly names the locked slug + the 'current iPhone 16 Pro on iOS 18.7 with Safari 26.4' decode + 'when iOS 18.8 ships, the locked archetype slug bumps' framing", () => {
    expect(profileDoc).toMatch(/`iphone16pro_ios18_7_safari26_4`/);
    expect(profileDoc).toMatch(/current iPhone 16 Pro on iOS 18\.7 with Safari 26\.4/);
    expect(profileDoc).toMatch(/when iOS 18\.8 ships, the locked archetype slug bumps/);
  });

  it("docs/api/profiles.md exposes the locked slug in the resource shape example: 'archetype': 'iphone16pro_ios18_7_safari26_4'", () => {
    expect(profileApi).toMatch(/"archetype": "iphone16pro_ios18_7_safari26_4",/);
  });

  it("docs/guides/profile-management.md commits to profile-archetype-pin stability: 'a profile created against iphone16pro_ios18_7_safari26_4 keeps that fingerprint forever, even after the locked default rolls forward' — pinned so the no-surprise-iOS-bump contract stays documented (drift to auto-bumping pinned profiles would surprise downstream behavioural-detection systems)", () => {
    expect(profileDoc).toMatch(
      /a profile created against `iphone16pro_ios18_7_safari26_4` keeps that fingerprint forever, even after the locked default rolls forward/,
    );
  });

  it('apps/server/src/lib/bootstrap.ts seeds a default profile with the locked archetype slug — pinned so dev/test seed data stays consistent with the production-locked default', () => {
    const bootstrap = read(resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts'));
    expect(bootstrap).toMatch(/archetype: 'iphone16pro_ios18_7_safari26_4',/);
  });
});
