import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/roadmap.astro');

describe('legacy /roadmap route current-state parity', () => {
  const page = readFileSync(PAGE, 'utf8');

  it('is a current product-updates route', () => {
    expect(page).toContain('title="Product updates"');
    expect(page).toContain('title="What is available today."');
    expect(page).toContain(
      'Released Driftstack product changes and current capability references.',
    );
  });

  it('points to released changes and the live API contract', () => {
    expect(page).toContain('href="/changelog/"');
    expect(page).toContain('href="https://docs.driftstack.dev/api/"');
    expect(page).toContain('Read the changelog');
    expect(page).toContain('Browse the API');
  });

  it('does not publish a speculative feature deck', () => {
    expect(page).not.toMatch(/NOW|NEXT|LATER|V-NNN|forward-looking|active engineering/i);
    expect(page).not.toMatch(/roadmap|weeks ahead|on the deck|lands at v\d/i);
  });

  it('exists at the legacy route path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });
});
