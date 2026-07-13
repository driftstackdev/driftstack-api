// W327.B — drift guard for marketing /index CTAs. Pins the
// canonical CTA labels + hrefs:
//   • Primary above-the-fold: "Start free" → /pricing#free
//   • Manual ladder: "See Manual pricing →" → /pricing#manual
//   • API ladder: "See API pricing →" → /pricing#api
//   • Final "See pricing" → /pricing

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/index.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W327.B / index CTA baseline', () => {
  const body = read(PAGE);

  it('primary CTA above the fold points at /pricing#free', () => {
    expect(body).toMatch(/<a href="\/pricing\/#free" class="btn-primary">Start free<\/a>/);
  });

  it('Manual ladder CTA links to /pricing#manual', () => {
    expect(body).toContain('href="/pricing/#manual"');
    expect(body).toMatch(/See Manual pricing/i);
  });

  it('API ladder CTA links to /pricing#api', () => {
    expect(body).toContain('href="/pricing/#api"');
    expect(body).toMatch(/See API pricing/i);
  });

  it('pricing-section CTA points at /pricing (v2: btn-primary with a shrink-0 utility)', () => {
    expect(body).toMatch(/<a href="\/pricing\/" class="btn-primary[^"]*">See pricing<\/a>/);
  });
});
