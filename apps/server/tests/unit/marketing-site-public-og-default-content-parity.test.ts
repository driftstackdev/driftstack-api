// W524.C — drift guard for apps/marketing-site/public/og-default.svg.
// Site-wide social-card fallback (1200x630 OpenGraph image). Drift here
// either changes the social-share preview (would create marketing↔
// social-platform preview divergence) or breaks the brand-color/
// tagline commitment (would erode brand recognition on shared links).
//
// Fleet rework (2026-06-12, founder-locked): light + violet card with
// the L2 Drift Layers mark + the W2 DRIFTSTACK two-tone wordmark.
//
//   • 1200x630 SVG canvas (OpenGraph standard size).
//   • Light (#f2f3f6) background + violet (#6d5efc) top rule.
//   • The L2 mark: ink outline back layer + violet filled front layer
//     + white home-indicator dot.
//   • DRIFT (ink #15161a) / STACK (violet #6d5efc) black-italic
//     two-tone wordmark.
//   • 'iPhone Safari sessions, on demand.' primary tagline.
//   • 'never a bot' positioning subline (plain-language, W452-aligned).
//   • 'driftstack.dev' mono footer in the accent violet.

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

  it('SVG canvas + Fleet light-bg framing pinned: \'<?xml version="1.0" encoding="UTF-8"?>\' + 1200x630 viewBox + light #f2f3f6 background + violet #6d5efc top rule — pinned so the OpenGraph canvas + the founder-locked light+violet brand surface survives', () => {
    expect(body).toMatch(/<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(body).toMatch(
      /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1200 630" width="1200" height="630">/,
    );
    expect(body).toMatch(/<rect width="1200" height="630" fill="#f2f3f6"\/>/);
    expect(body).toMatch(/<rect x="0" y="0" width="1200" height="6" fill="#6d5efc"\/>/);
  });

  it('L2 Drift Layers mark pinned: ink-outline back layer (stroke #474a55, opacity .55, rotate -7) + violet #6d5efc filled front layer + white home-indicator dot — pinned so the social card carries the founder-picked brand mark (drift to a different mark would erode brand recognition on shared links)', () => {
    expect(body).toMatch(/stroke="#474a55" stroke-width="14" opacity="0\.55"/);
    expect(body).toMatch(/transform="rotate\(-7 105 127\)"/);
    expect(body).toMatch(/<rect x="86" y="30" width="118" height="194" rx="34" fill="#6d5efc"\/>/);
    expect(body).toMatch(/<circle cx="145" cy="192" r="12" fill="#ffffff"\/>/);
  });

  it('W2 two-tone wordmark pinned: black-italic 900-weight DRIFT (ink #15161a) + STACK (violet #6d5efc) tspans — pinned so the picked wordmark treatment survives on shared links', () => {
    expect(body).toMatch(/font-weight="900" font-style="italic"/);
    expect(body).toMatch(
      /<tspan fill="#15161a">DRIFT<\/tspan><tspan fill="#6d5efc">STACK<\/tspan>/,
    );
  });

  it("primary tagline pinned: 'iPhone Safari sessions, on demand.' (matches the BaseLayout default-description lead)", () => {
    expect(body).toMatch(/iPhone Safari sessions, on demand\./);
  });

  it("positioning subline pinned: the 'never a bot' outcome copy (plain-language, W452-aligned — replaces the prior 'Premium fingerprint fidelity' jargon subline)", () => {
    expect(body).toMatch(/A real iPhone browser in the cloud/);
    expect(body).toMatch(/sees a genuine iPhone, never a bot\./);
  });

  it("mono footer pinned: 'driftstack.dev' in the accent violet", () => {
    expect(body).toMatch(
      /<text[^>]*fill="#6d5efc"[^>]*font-family="ui-monospace[^"]*"[^>]*>driftstack\.dev<\/text>/,
    );
  });

  it('file exists at canonical path + the rendered og-default.png exists beside it', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/public/og-default.png'))).toBe(true);
  });
});
