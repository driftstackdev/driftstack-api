import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const surfaces = [
  {
    name: 'customer dashboard',
    source: readFileSync(
      resolve(REPO_ROOT, 'apps/customer-dashboard/src/layouts/DashboardLayout.astro'),
      'utf8',
    ),
    controlId: 'customer-mobile-navigation',
    openLabel: 'Open navigation',
    closeLabel: 'Close navigation',
    toggleName: 'toggle',
  },
  {
    name: 'admin panel',
    source: readFileSync(
      resolve(REPO_ROOT, 'apps/admin-panel/src/layouts/AdminLayout.astro'),
      'utf8',
    ),
    controlId: 'admin-mobile-navigation',
    openLabel: 'Open navigation',
    closeLabel: 'Close navigation',
    toggleName: 'navToggle',
  },
  {
    name: 'docs tree',
    source: readFileSync(resolve(REPO_ROOT, 'apps/docs/src/layouts/DocLayout.astro'), 'utf8'),
    controlId: 'docs-mobile-navigation',
    openLabel: 'Open docs navigation',
    closeLabel: 'Close docs navigation',
    toggleName: 'toggle',
  },
] as const;

describe('cross-app mobile sidebar accessibility', () => {
  it.each(surfaces)('$name binds its trigger to a stable controlled aside', (surface) => {
    expect(surface.source).toContain(`aria-label="${surface.openLabel}"`);
    expect(surface.source).toContain(`aria-controls="${surface.controlId}"`);
    expect(surface.source).toContain(`id="${surface.controlId}"`);
    expect(surface.source).toContain('aria-expanded="false"');
  });

  it.each(surfaces)(
    '$name keeps its accessible label synchronized with expanded state',
    (surface) => {
      expect(surface.source).toContain(
        `${surface.toggleName}.setAttribute('aria-label', '${surface.closeLabel}')`,
      );
      expect(surface.source).toContain(
        `${surface.toggleName}.setAttribute('aria-label', '${surface.openLabel}')`,
      );
    },
  );

  it.each(surfaces)('$name restores trigger focus after Escape hides the overlay', (surface) => {
    expect(surface.source).toMatch(/e\.key === 'Escape'[\s\S]*?set(?:Nav)?Open\(false\);/);
    expect(surface.source).toContain(`${surface.toggleName}.focus()`);
  });
});
