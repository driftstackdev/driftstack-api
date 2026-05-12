// W314.C — drift guard for /profiles page archetype baseline. The
// dashboard's inline archetype-label helper must mirror the canonical
// LOCKED_ARCHETYPE_ID and LOCKED_ARCHETYPE_DISPLAY_LABEL from
// @driftstack/api-types. Catches drift if either side changes
// without the other.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCKED_ARCHETYPE_ID, LOCKED_ARCHETYPE_DISPLAY_LABEL } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/profiles.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W314.C /profiles archetype baseline', () => {
  const body = read(PAGE);

  it('LOCKED_ARCHETYPE_ID is the canonical iphone16pro_ios18_7_safari26_4 slug', () => {
    expect(LOCKED_ARCHETYPE_ID).toBe('iphone16pro_ios18_7_safari26_4');
  });

  it('display label matches LOCKED_ARCHETYPE_DISPLAY_LABEL', () => {
    expect(LOCKED_ARCHETYPE_DISPLAY_LABEL).toBe('iPhone 16 Pro / iOS 18.7 / Safari 26.4');
  });

  it('page inline archetype-label helper hardcodes the canonical slug', () => {
    expect(body).toContain(LOCKED_ARCHETYPE_ID);
  });

  it('page inline archetype-label helper hardcodes the canonical display label', () => {
    expect(body).toContain(LOCKED_ARCHETYPE_DISPLAY_LABEL);
  });

  it('page imports archetypeDisplayLabel from @driftstack/api-types', () => {
    expect(body).toMatch(
      /import\s*\{[\s\S]*?archetypeDisplayLabel[\s\S]*?\}\s+from\s+['"]@driftstack\/api-types['"]/,
    );
  });

  it('page does NOT reference the fictional iphone16pro_ios26 slug (V-136 regression guard)', () => {
    expect(body).not.toMatch(/iphone16pro_ios26/);
  });
});
