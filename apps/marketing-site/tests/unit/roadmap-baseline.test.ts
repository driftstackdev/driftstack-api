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

  it('Now bucket cites the 81-archetype launch catalog spanning iPhone 13 → 17 Pro Max (iOS 18.6 / 18.7 · Safari 18.6–26.5)', () => {
    // The launch catalog ships 81 device profiles spanning the
    // iPhone 13 → 17 Pro Max family. The device-span endpoints +
    // the iOS + Safari version span must all survive a copy rewrite.
    expect(body).toMatch(/81 (?:device )?profiles/);
    expect(body).toMatch(/iPhone 13[\s\S]{0,80}17 Pro Max/);
    expect(body).toMatch(/iOS 18\.6 \/ 18\.7/);
    expect(body).toMatch(/Safari 18\.6/);
    expect(body).toMatch(/26\.5/);
    // The pre-broadening narrow "15 Pro / 16 Pro / 17 lineup" framing
    // must not return — the catalog spans the full iPhone 13 → 17
    // Pro Max family, not just the 15/16/17 lineup.
    expect(body).not.toMatch(/iPhone 15 Pro \/ 16 Pro \/ 17 lineup/);
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
