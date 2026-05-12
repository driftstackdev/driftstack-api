// W288.C — drift guard for DashboardLayout active-state highlight.
// The sidebar nav must derive the active item from the current
// pathname (not from a stored variable or hard-coded key) so the
// highlight always matches the route the user is on.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LAYOUT = resolve(REPO_ROOT, 'apps/customer-dashboard/src/layouts/DashboardLayout.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W288.C DashboardLayout active-state parity', () => {
  const body = read(LAYOUT);

  it('layout reads the current pathname from Astro.url', () => {
    expect(body).toMatch(/const\s+pathname\s*=\s*Astro\.url\.pathname/);
  });

  it('active-item check compares pathname to item.href', () => {
    expect(body).toMatch(/pathname\s*===\s*item\.href/);
  });

  it('active state also matches nested routes via startsWith', () => {
    expect(body).toMatch(/pathname\.startsWith\(item\.href\s*\+\s*['"]\/['"]\)/);
  });
});
