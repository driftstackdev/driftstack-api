// V-292 — cross-surface vocabulary parity test.
//
// Asserts the V-284 dashboard /profiles empty state shares the same
// vocabulary as the V-275 GUI ProfilesView empty state. Cheap drift
// guard — if a future edit reworks one surface's empty-state copy
// without touching the other, this test fails.
//
// Implementation: source-string match against the Astro page +
// React component files. Brittle if either file moves (test will need
// updating in the same commit), but that's the point — it locks the
// shared vocabulary across both surfaces.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const dashboardProfiles = readFileSync(
  resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/profiles.astro'),
  'utf8',
);
const guiProfiles = readFileSync(
  resolve(REPO_ROOT, 'apps/gui-client/src/views/ProfilesView.tsx'),
  'utf8',
);

// Phrases that must appear verbatim in BOTH surfaces' empty-state copy.
// The wording is intentionally identical so customers see the same
// concept regardless of whether they're in the dashboard or the GUI.
const SHARED_PHRASES = [
  'No profiles yet',
  'persistent identity',
  'cookies, localStorage, IndexedDB',
  'Create your first profile',
];

describe('V-292 — dashboard /profiles empty-state parity with GUI ProfilesView', () => {
  it.each(SHARED_PHRASES)('phrase "%s" appears in both surfaces', (phrase) => {
    expect(dashboardProfiles).toContain(phrase);
    expect(guiProfiles).toContain(phrase);
  });

  it('both surfaces use the oxblood-50 / oxblood-700 (or accent / accent-subtle) tinted icon container', () => {
    // Dashboard uses Tailwind's bg-glow-red/10 + text-glow-red directly
    // because the Astro page styles map to the marketing-site token set.
    expect(dashboardProfiles).toMatch(/bg-oxblood-50|text-glow-red/);

    // GUI uses the bg-accent-subtle / text-accent semantic tokens which
    // map to the same oxblood palette via tailwind.config.ts.
    expect(guiProfiles).toMatch(/bg-accent-subtle|text-accent/);
  });
});
