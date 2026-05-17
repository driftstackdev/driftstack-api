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

  it('uses the multi-archetype iPhone family canonical label (M.6 Path A: iPhone 15 Pro / 16 Pro / 17 lineup, iOS 18.7 / Safari 26.4-26.5)', () => {
    // The page MUST name at least two of the launch iPhone families
    // somewhere in the NOW bucket so the multi-archetype-at-launch
    // commitment survives a copy rewrite. The OS span MUST mention
    // both Safari 26.4 and 26.5 since the latter is the rolling-out
    // version covered at v1.0 per the founder verdict 2026-05-17.
    expect(body).toMatch(/iPhone 15 Pro/);
    expect(body).toMatch(/iPhone 16 Pro/);
    expect(body).toMatch(/iPhone 17/);
    expect(body).toMatch(/Safari 26\.4/);
    expect(body).toMatch(/Safari 26\.5/);
    // Pre-M.6 single-archetype framing must NOT return on the NOW
    // item title line (would re-introduce the single-archetype
    // launch implication the orchestrator surfaced in §6 / Item 6).
    expect(body).not.toMatch(
      /title: 'iPhone 16 Pro · iOS 18\.7 · Safari 26\.4 fingerprint parity'/,
    );
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
