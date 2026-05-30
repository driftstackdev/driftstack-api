// W335.B — drift guard for /pricing page section anchors. The
// homepage CTAs deep-link to /pricing#free / /pricing#manual
// / /pricing#api / /pricing#self-hosted. Each anchor must exist
// on the pricing page or the deep links 404.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing.astro');

const REQUIRED_ANCHORS = ['free', 'manual', 'api', 'self-hosted'];

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W335.B /pricing section-anchor coverage', () => {
  const body = read(PAGE);

  for (const id of REQUIRED_ANCHORS) {
    it(`page declares <section id="${id}">`, () => {
      expect(body).toMatch(new RegExp(`<section\\s+id="${id}"`));
    });
  }

  it('page renders one summary card per Manual ladder tier (Solo / Team / Agency)', () => {
    expect(body).toMatch(/Personal\s+—\s+\$79\/mo/);
    expect(body).toMatch(/Team\s+—\s+\$249\/mo/);
    expect(body).toMatch(/Agency\s+—\s+\$699\/mo/);
  });

  it('page renders one summary card per API ladder tier (Starter / Builder / Scale / Enterprise)', () => {
    expect(body).toMatch(/API Starter\s+—\s+\$149\/mo/);
    expect(body).toMatch(/API Builder\s+—\s+\$499\/mo/);
    expect(body).toMatch(/API Scale\s+—\s+\$1,499\/mo/);
    expect(body).toMatch(/Enterprise\s+—\s+from\s+\$4,000\/mo/);
  });
});
