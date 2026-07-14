// Cross-workspace guard: an absent backend must not produce a placeholder
// admin route, navigation affordance, or fabricated production fixture module.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ADMIN_ROOT = resolve(REPO_ROOT, 'apps/admin-panel/src');

describe('admin panel ships only live lead surfaces', () => {
  it('omits the backend-less leads route and obsolete fixture module', () => {
    expect(existsSync(resolve(ADMIN_ROOT, 'pages/leads.astro'))).toBe(false);
    expect(existsSync(resolve(ADMIN_ROOT, 'data/mocks.ts'))).toBe(false);
  });

  it('keeps the leads destination out of staff navigation', () => {
    const layout = readFileSync(resolve(ADMIN_ROOT, 'layouts/AdminLayout.astro'), 'utf8');
    expect(layout).not.toMatch(/href:\s*['"]\/leads['"]/);
  });
});
