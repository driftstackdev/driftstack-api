// W314.C — drift guard for /profiles page archetype baseline. The
// canonical LOCKED_ARCHETYPE_ID / LOCKED_ARCHETYPE_DISPLAY_LABEL stay
// pinned, and the page's archetype-label map must be DERIVED from the
// registry (archetypeDisplayLabel over ARCHETYPE_REGISTRY) rather than
// hardcoding a single archetype — so every selectable device renders a
// friendly label, not a raw slug.

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

  it('LOCKED_ARCHETYPE_ID is the canonical iphone17_ios18_7_safari26_4 slug', () => {
    expect(LOCKED_ARCHETYPE_ID).toBe('iphone17_ios18_7_safari26_4');
  });

  it('display label matches LOCKED_ARCHETYPE_DISPLAY_LABEL', () => {
    expect(LOCKED_ARCHETYPE_DISPLAY_LABEL).toBe('iPhone 17 / iOS 18.7 / Safari 26.4');
  });

  it('page derives the archetype-label map from the registry (no single-archetype hardcode)', () => {
    // The label map is built from ARCHETYPE_REGISTRY via archetypeDisplayLabel(),
    // so every selectable archetype renders friendly — not just the locked one.
    expect(body).toMatch(/ARCHETYPE_LABELS = Object\.fromEntries/);
    expect(body).toMatch(/archetypeDisplayLabel\(a\.id\)/);
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
