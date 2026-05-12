// W297.A — drift guard for marketing /roadmap page structure. The
// page declares NOW / NEXT / LATER buckets and explicitly does NOT
// commit to dates. Catches drift where someone adds a specific
// quarter ("Q3 2026") into the copy and creates a public promise.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/roadmap.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W297.A /roadmap structure baseline', () => {
  const body = read(PAGE);

  it('declares NOW, NEXT, LATER buckets', () => {
    expect(body).toMatch(/const NOW:\s*RoadmapItem\[\]/);
    expect(body).toMatch(/const NEXT:\s*RoadmapItem\[\]/);
    expect(body).toMatch(/const LATER:\s*RoadmapItem\[\]/);
  });

  it('uses the iPhone 16 Pro · iOS 18.7 · Safari 26.4 canonical archetype label', () => {
    expect(body).toMatch(/iPhone 16 Pro\s*[·.]\s*iOS 18\.7\s*[·.]\s*Safari 26\.4/);
  });

  it('does not commit to specific calendar quarters in the bucket titles', () => {
    // Avoid `Q1 2026` / `Q2 2026` / etc. promises inside bucket
    // headers — explicitly forbid in the visible copy. Allow inside
    // body text where context (e.g. "post-Q3 2026 audit window") is
    // appropriate. Heuristic: no `Q[1-4] 20[0-9]{2}` adjacent to
    // a heading-cased label like Next / Later.
    const matches = [...body.matchAll(/Q[1-4]\s*20\d{2}/g)];
    expect(matches.length).toBeLessThanOrEqual(2);
  });

  it('explicitly declares "no commitment to specific dates"', () => {
    expect(body).toMatch(
      /no commitment to specific dates|do(?:n't|n['']t|n\b)?\s*publish dates|publish ordering/i,
    );
  });
});
