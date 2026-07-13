// W320.B — drift guard for /trust landing card grid. The trust
// landing is the bookmark URL for compliance evaluations. Pins:
//   • Hero says "One bookmark for everything compliance-relevant"
//   • Card grid links to /security, /trust/sub-processors,
//     /trust/incidents, /legal/dpa
//   • Each card is wrapped in an <a href="..."> (clickable target)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/index.astro');

const REQUIRED_CARDS = ['/security/', '/trust/sub-processors/', '/trust/incidents/', '/legal/dpa/'];

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W320.B /trust landing baseline', () => {
  const body = read(PAGE);

  it('hero promises a single bookmark for compliance', () => {
    expect(body).toMatch(/One bookmark for everything compliance-relevant/i);
  });

  for (const href of REQUIRED_CARDS) {
    it(`landing links to ${href}`, () => {
      expect(body).toContain(`href="${href}"`);
    });
  }

  it('references Article 28(2) sub-processor amendment notices', () => {
    expect(body).toMatch(/Article 28\(2\)/);
  });

  it('renders StatusBadge for live platform health', () => {
    expect(body).toContain('<StatusBadge');
  });
});
