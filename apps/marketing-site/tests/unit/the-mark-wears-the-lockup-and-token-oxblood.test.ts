// 2026-09-25 — the brand mark wears the SAME oxblood as the horizontal lockup
// and the token accent. The final theme review found driftstack-mark.svg (the
// header and footer of every page, and the favicon) still filling its front
// layer with the retired #9b3b46 and outlining the back layer in the old ink
// #474a55, while driftstack-horizontal.svg had moved to #a83b4d / #525863: the
// same mark in two reds, next to the #a83b4d "Start free" button. The colour
// sweep missed it because it lives in an asset file, not in CSS.
//
// The arms tie the mark to its SOURCES (the token accent, the light secondary
// ink, the lockup), not to a literal, so the next recolour fails here until the
// mark follows it. The five byte-identical copies and the lockstep ?v= bump are
// guarded in apps/server/tests/unit/docs-public-headers-robots-and-cross-app-svg-parity.test.ts.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PUBLIC = resolve(REPO_ROOT, 'apps/marketing-site/public');
const MARK = resolve(PUBLIC, 'driftstack-mark.svg');
const LOCKUP = resolve(PUBLIC, 'driftstack-horizontal.svg');
const TOKENS = resolve(REPO_ROOT, 'packages/design-tokens/tokens.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// The two layers of the L2 mark, read the same way from the mark and from the
// lockup (which embeds the mark in a scaled <g>).
function layerColours(svg: string): { front: string; back: string } {
  const front =
    /<rect x="86" y="30" width="118" height="194" rx="34" fill="(#[0-9a-f]{6})"\/>/i.exec(svg);
  const back = /fill="none" stroke="(#[0-9a-f]{6})" stroke-width="14" opacity="0\.55"/i.exec(svg);
  expect(front, 'front layer <rect … fill="#…"/> found').not.toBeNull();
  expect(back, 'back layer outline stroke="#…" found').not.toBeNull();
  return { front: front![1]!.toLowerCase(), back: back![1]!.toLowerCase() };
}

describe('the mark wears the lockup and token oxblood', () => {
  const tokens = JSON.parse(read(TOKENS)) as {
    accent: { accent: string };
    modes: { light: { 'ink-secondary': string } };
  };

  it('the mark fills its front layer with the token accent and outlines its back layer in the light secondary ink', () => {
    const mark = layerColours(read(MARK));
    expect(mark.front).toBe(tokens.accent.accent.toLowerCase());
    expect(mark.back).toBe(tokens.modes.light['ink-secondary'].toLowerCase());
  });

  it('the mark and the horizontal lockup draw their two layers in the same two colours', () => {
    expect(layerColours(read(MARK))).toEqual(layerColours(read(LOCKUP)));
  });

  it('no retired red or old ink survives in the mark, its comment included', () => {
    const svg = read(MARK).toLowerCase();
    for (const retired of ['#9b3b46', '#474a55', '#6d5efc', '#c04b58', '#722f37']) {
      expect(svg, `mark still names ${retired}`).not.toContain(retired);
    }
  });
});
