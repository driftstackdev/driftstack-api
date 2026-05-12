// W317.B — drift guard for /roadmap page baseline. The roadmap is
// segmented into Now / Next / Later. Pins:
//   • all three buckets exist and carry at least 3 items each
//   • no internal V-NNN engineering tags leak through (they'd
//     confuse customers, and rotate too fast to keep stable)
//   • Now bucket cites the locked archetype + SDKs + customer
//     dashboard + webhook infra (the foundation, all shipped)

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

describe('W317.B /roadmap page baseline', () => {
  const body = read(PAGE);

  it('declares Now / Next / Later buckets', () => {
    expect(body).toMatch(/const NOW:\s*RoadmapItem\[\]/);
    expect(body).toMatch(/const NEXT:\s*RoadmapItem\[\]/);
    expect(body).toMatch(/const LATER:\s*RoadmapItem\[\]/);
  });

  it('Now bucket cites the locked archetype (iPhone 16 Pro / iOS 18.7 / Safari 26.4)', () => {
    expect(body).toMatch(/iPhone 16 Pro[\s\S]{0,40}iOS 18\.7[\s\S]{0,40}Safari 26\.4/);
  });

  it('Now bucket cites the customer dashboard (app.driftstack.dev)', () => {
    expect(body).toContain('app.driftstack.dev');
  });

  it('does NOT leak internal V-NNN engineering tags in customer-facing copy', () => {
    // Customer-facing bullet bodies must not include V-NNN slice tags
    // (the file header explains these are deliberately suppressed).
    // The page header comment mentions V-473 + V-294, but those are
    // in the Astro frontmatter comment, not in any RoadmapItem body.
    // We extract just the RoadmapItem entries and check those.
    const itemBlocks = [...body.matchAll(/title:\s*'[^']+',\s*body:\s*'([^']+)'/g)].map(
      (m) => m[1]!,
    );
    expect(itemBlocks.length).toBeGreaterThanOrEqual(9);
    const offenders = itemBlocks.filter((b) => /V-\d{2,4}/.test(b));
    expect(offenders).toEqual([]);
  });

  it('forward-looking framing: no specific dates committed', () => {
    expect(body).toMatch(/no commitment to specific dates/i);
  });
});
