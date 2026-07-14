import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const PAGE = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'roadmap.astro');

describe('legacy roadmap route release-truth parity', () => {
  const page = readFileSync(PAGE, 'utf8');

  it('uses the changelog for customer-visible release history', () => {
    expect(page).toContain('href="/changelog/"');
    expect(page).toContain('released customer-facing changes');
  });

  it('uses the live API documentation for current capability truth', () => {
    expect(page).toContain('https://docs.driftstack.dev/api/');
    expect(page).toContain('current HTTP contract');
  });

  it('contains no staged feature taxonomy or delivery promise', () => {
    expect(page).not.toMatch(/const (?:NOW|NEXT|LATER)|in active engineering|on the deck/i);
    expect(page).not.toMatch(/forward-looking|roadmap|planned|coming soon|lands at v\d/i);
  });
});
