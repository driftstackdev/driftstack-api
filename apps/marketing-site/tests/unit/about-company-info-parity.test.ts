// W301.A — drift guard for /about page company info. The page
// must accurately reflect the legal entity (Driftstack B.V.,
// Netherlands jurisdiction) consistent with the legal/terms.md
// declarations. Catches drift where copy invents a non-existent
// office location or legal entity name.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ABOUT = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/about.astro');
const TERMS = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/terms.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W301.A /about ↔ legal/terms.md company-info parity', () => {
  const about = read(ABOUT);
  const terms = read(TERMS);

  it('about page locates the company in the Netherlands', () => {
    expect(about).toMatch(/Netherlands|Nederland/);
  });

  it('about page does not claim US / UK / DE / IE incorporation', () => {
    expect(about).not.toMatch(
      /incorporated in the (US|United States|UK|United Kingdom|Germany|Ireland)/i,
    );
    expect(about).not.toMatch(/Delaware\s+(corporation|LLC|C-corp)/i);
  });

  it('terms.md continues to name "Driftstack B.V." as the legal entity', () => {
    expect(terms).toMatch(/Driftstack B\.V\./);
  });

  it('terms.md references VAT/BTW handling for EU customers', () => {
    expect(terms).toMatch(/BTW/);
    expect(terms).toMatch(/reverse[- ]charge|VAT/i);
  });
});
