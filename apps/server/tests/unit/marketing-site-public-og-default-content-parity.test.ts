// W524.C (v2 2026-07-03) — drift guard for apps/marketing-site/public/og-default.svg.
// Site-wide social-card fallback (1200x630 OpenGraph image). Drift here
// either changes the social-share preview (would create marketing↔
// social-platform preview divergence) or breaks the brand-color/
// tagline commitment (would erode brand recognition on shared links).
//
// 2026-07-03 SUPERSESSION: the card is now DARK + OXBLOOD ("Fleet Mission
// Control — Dark + Red", founder-locked 2026-06-15) with the CURRENT fleet
// tagline. The prior light+violet card (2026-06-12 direction) shipped for
// weeks after the site itself flipped dark — every social preview was
// off-brand and carried the retired "iPhone Safari sessions, on demand."
// tagline. Negative pins below keep the stale art from returning. The
// rendered og-default.png is regenerated from this SVG via
// scripts/gen-og-image.mjs, and BaseLayout serves it as
// /og-default.png?v=2 (immutable-1y edge cache bust).
//
//   • 1200x630 SVG canvas (OpenGraph standard size).
//   • Dark (#060608) background + oxblood (#9b3b46) top rule + a faint
//     radially-masked 40px grid (the site's grid-bg idiom).
//   • The L2 mark: muted-ink outline back layer + oxblood filled front
//     layer + white home-indicator dot.
//   • DRIFT (ink #f5f5f7) / STACK (accent-2 #c04b58) black-italic
//     two-tone wordmark.
//   • 'Command a fleet of real iPhones.' primary tagline (the hero H1).
//   • 'they're just people on phones.' positioning subline (Band A).
//   • 'driftstack.io' mono footer in accent-2 + quiet 'App · Code · AI'
//     pills bottom-right.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/public/og-default.svg');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W524.C apps/marketing-site/public/og-default.svg content parity', () => {
  const body = read(LIB);

  it('SVG canvas + dark+oxblood framing pinned: \'<?xml version="1.0" encoding="UTF-8"?>\' + 1200x630 viewBox + dark #060608 background + oxblood #9b3b46 top rule + faint masked grid — pinned so the OpenGraph canvas + the founder-locked dark+red brand surface survives', () => {
    expect(body).toMatch(/<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(body).toMatch(
      /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1200 630" width="1200" height="630">/,
    );
    expect(body).toMatch(/<rect width="1200" height="630" fill="#060608"\/>/);
    expect(body).toMatch(/<rect x="0" y="0" width="1200" height="6" fill="#9b3b46"\/>/);
    expect(body).toMatch(/<pattern id="grid" width="40" height="40"/);
    expect(body).toMatch(/mask="url\(#gridmask\)"/);
    // the superseded light+violet surface must not return
    expect(body).not.toMatch(/#f2f3f6/);
    expect(body).not.toMatch(/#6d5efc/);
  });

  it('L2 Drift Layers mark pinned: muted-ink outline back layer (stroke #8c8c96, opacity .5, rotate -7) + oxblood #9b3b46 filled front layer + white home-indicator dot — the founder-picked brand mark, recolored to the dark+red axis', () => {
    expect(body).toMatch(/stroke="#8c8c96" stroke-width="14" opacity="0\.5"/);
    expect(body).toMatch(/transform="rotate\(-7 105 127\)"/);
    expect(body).toMatch(/<rect x="86" y="30" width="118" height="194" rx="34" fill="#9b3b46"\/>/);
    expect(body).toMatch(/<circle cx="145" cy="192" r="12" fill="#ffffff"\/>/);
  });

  it('W2 two-tone wordmark pinned: black-italic 900-weight DRIFT (ink #f5f5f7) + STACK (accent-2 #c04b58, the brighter oxblood for legibility on near-black) tspans', () => {
    expect(body).toMatch(/font-weight="900" font-style="italic"/);
    expect(body).toMatch(
      /<tspan fill="#f5f5f7">DRIFT<\/tspan><tspan fill="#c04b58">STACK<\/tspan>/,
    );
  });

  it("primary tagline pinned: 'Command a fleet of real iPhones.' (the homepage hero H1 — replaces the retired 'iPhone Safari sessions, on demand.')", () => {
    expect(body).toMatch(/Command a fleet of real iPhones\./);
    expect(body).not.toMatch(/iPhone Safari sessions, on demand\./);
  });

  it("positioning subline pinned: the Band-A 'just people on phones' close (mirrors the hero paragraph)", () => {
    expect(body).toMatch(/Real iPhone Safari in the cloud — to every website,/);
    expect(body).toMatch(/they're just people on phones\./);
  });

  it("mono footer pinned: 'driftstack.io' in accent-2 + the quiet 'App · Code · AI' access-paths line bottom-right", () => {
    expect(body).toMatch(
      /<text[^>]*fill="#c04b58"[^>]*font-family="ui-monospace[^"]*"[^>]*>driftstack\.io<\/text>/,
    );
    expect(body).toMatch(/App · Code · AI/);
  });

  it('file exists at canonical path + the rendered og-default.png exists beside it', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/public/og-default.png'))).toBe(true);
  });
});
