// The admin panel exposes only working operational surfaces. Lead capture has
// no persistence or API contract, so it must not appear as a route or nav item.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/leads.astro');
const LAYOUT = resolve(REPO_ROOT, 'apps/admin-panel/src/layouts/AdminLayout.astro');
const ROUTES_DIR = resolve(REPO_ROOT, 'apps/server/src/routes');

function allRoutes(): string {
  return readdirSync(ROUTES_DIR)
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => readFileSync(join(ROUTES_DIR, entry), 'utf8'))
    .join('\n');
}

describe('admin leads surface absence', () => {
  it('does not ship a placeholder page or sidebar destination', () => {
    expect(existsSync(PAGE)).toBe(false);
    expect(readFileSync(LAYOUT, 'utf8')).not.toMatch(/href:\s*['"]\/leads['"]/);
  });

  it('does not advertise an API contract that has no persistence model', () => {
    expect(allRoutes()).not.toMatch(/['"]\/v1\/admin\/leads(?:\/[^'"]*)?['"]/);
  });
});
