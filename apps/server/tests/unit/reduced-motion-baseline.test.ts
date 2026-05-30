// Drift guard: every customer-facing app's base stylesheet must carry a
// GLOBAL prefers-reduced-motion rule that neutralises animations +
// transitions for motion-sensitive users. The apps use repeating
// animations (animate-pulse skeletons, the live-session animate-ping dot,
// animate-spin) + opacity/scroll motion; without this, those play for
// everyone regardless of OS reduced-motion preference. The per-component
// hero-glow rule that predated this only covered one decorative element.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const BASE_CSS = [
  'apps/customer-dashboard/src/styles/base.css',
  'apps/marketing-site/src/styles/base.css',
  'apps/admin-panel/src/styles/base.css',
];

describe('prefers-reduced-motion global baseline across apps', () => {
  for (const rel of BASE_CSS) {
    it(`${rel} neutralises animation + transition under prefers-reduced-motion (global *)`, () => {
      const p = resolve(REPO_ROOT, rel);
      expect(existsSync(p)).toBe(true);
      const css = readFileSync(p, 'utf8');
      // A global rule: prefers-reduced-motion media query containing a `*`
      // selector that forces animation/transition durations near-zero.
      expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
      expect(css).toMatch(/\*,\s*\n?\s*\*::before,\s*\n?\s*\*::after\s*\{/);
      expect(css).toMatch(/animation-duration: 0\.01ms !important/);
      expect(css).toMatch(/transition-duration: 0\.01ms !important/);
    });
  }
});
