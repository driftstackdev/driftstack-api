// W286.B — drift guard for BaseLayout canonical-URL handling. The
// canonical URL must derive from Astro.site + the current pathname
// and be emitted as <link rel="canonical">. Catches drift where the
// canonical is hard-coded or dropped.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const BASE = resolve(REPO_ROOT, 'apps/marketing-site/src/layouts/BaseLayout.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W286.B BaseLayout canonical URL handling', () => {
  const body = read(BASE);

  it('declares <link rel="canonical" href={canonical} />', () => {
    expect(body).toMatch(/<link\s+rel=["']canonical["']\s+href=\{canonical\}/);
  });

  it('canonical derives from Astro.site + pathname', () => {
    expect(body).toMatch(/new URL\(\s*pathname\s*,\s*Astro\.site\s*\)/);
  });

  it('og:url uses the same canonical value', () => {
    expect(body).toMatch(/property=["']og:url["']\s+content=\{canonical\}/);
  });
});
