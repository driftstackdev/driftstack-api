// W524.C — drift guard for apps/marketing-site/public/og-default.svg.
// Site-wide social-card fallback (1200x630 OpenGraph image). Drift here
// either changes the social-share preview (would create marketing↔
// social-platform preview divergence) or breaks the brand-color/
// tagline commitment (would erode brand recognition on shared links).
//
//   • 1200x630 SVG canvas (OpenGraph standard size).
//   • Slate-900 (#0f172a) background.
//   • Oxblood (#722F37) 120x120 rounded-22 D-tile.
//   • Georgia/serif white 'D' glyph.
//   • 'Driftstack' brand text in ui-monospace 64px.
//   • 'iPhone Safari sessions, on demand.' primary tagline.
//   • 'Premium fingerprint fidelity for the device that matters.'
//     subline (note: 'fingerprint fidelity' here vs 'fidelity' alone
//     in BaseLayout default-description — SVG carries the longer
//     fingerprint-fidelity-positioning copy).
//   • 'driftstack.dev' mono footer.

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

  it('SVG canvas + slate-900-bg framing pinned: \'<?xml version="1.0" encoding="UTF-8"?>\' + \'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">\' + \'<rect width="1200" height="630" fill="#0f172a"/>\' — pinned so the 1200x630-OpenGraph-canvas + slate-900 #0f172a-background commitment survives', () => {
    expect(body).toMatch(/<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(body).toMatch(
      /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1200 630" width="1200" height="630">/,
    );
    expect(body).toMatch(/<rect width="1200" height="630" fill="#0f172a"\/>/);
  });

  it('Oxblood D-tile framing pinned: \'<rect x="60" y="60" width="120" height="120" rx="22" fill="#722F37"/>\' + \'<text x="120" y="143" text-anchor="middle" fill="#ffffff" font-family="Georgia, ...serif" font-size="78" font-weight="700">D</text>\' — pinned so the 120x120 oxblood-tile + rx-22 rounded corners + Georgia-serif white-D-glyph + center-anchored commitment survives (drift to a different brand color in the social card would erode brand recognition on shared links)', () => {
    expect(body).toMatch(/<rect x="60" y="60" width="120" height="120" rx="22" fill="#722F37"\/>/);
    expect(body).toMatch(
      /<text x="120" y="143" text-anchor="middle" fill="#ffffff" font-family="Georgia, 'Times New Roman', serif" font-size="78" font-weight="700">D<\/text>/,
    );
  });

  it('Driftstack brand text framing pinned: \'<text x="60" y="280" fill="#f8fafc" font-family="ui-monospace, ...monospace" font-size="64" font-weight="600">Driftstack</text>\' — pinned so the brand-text-monospace + 64px + slate-50-fill + 600-weight commitment survives', () => {
    expect(body).toMatch(
      /<text x="60" y="280" fill="#f8fafc" font-family="ui-monospace, 'SF Mono', Consolas, monospace" font-size="64" font-weight="600">Driftstack<\/text>/,
    );
  });

  it('Primary tagline framing pinned: \'<text x="60" y="360" fill="#cbd5e1" font-family="-apple-system, ...sans-serif" font-size="44" font-weight="500">iPhone Safari sessions, on demand.</text>\' — pinned so the primary-tagline canonical-copy + 44px + slate-300-fill commitment survives', () => {
    expect(body).toMatch(
      /<text x="60" y="360" fill="#cbd5e1" font-family="-apple-system, BlinkMacSystemFont, 'Inter', sans-serif" font-size="44" font-weight="500">iPhone Safari sessions, on demand\.<\/text>/,
    );
  });

  it('Subline tagline framing pinned: \'<text x="60" y="420" fill="#94a3b8" font-family="-apple-system, ...sans-serif" font-size="32" font-weight="400">Premium fingerprint fidelity for the device that matters.</text>\' — pinned so the subline-fingerprint-fidelity-positioning + 32px + slate-400-fill commitment survives (note: SVG-card subline uses the longer \'fingerprint fidelity\' phrasing vs \'fidelity\' alone in BaseLayout default-description — pinning both forms separately so each is anchored to its own surface)', () => {
    expect(body).toMatch(
      /<text x="60" y="420" fill="#94a3b8" font-family="-apple-system, BlinkMacSystemFont, 'Inter', sans-serif" font-size="32" font-weight="400">Premium fingerprint fidelity for the device that matters\.<\/text>/,
    );
  });

  it('driftstack.dev mono footer framing pinned: \'<text x="60" y="560" fill="#64748b" font-family="ui-monospace, ...monospace" font-size="24" font-weight="400">driftstack.dev</text>\' — pinned so the driftstack.dev-mono-domain-footer + 24px + slate-500-fill commitment survives', () => {
    expect(body).toMatch(
      /<text x="60" y="560" fill="#64748b" font-family="ui-monospace, 'SF Mono', Consolas, monospace" font-size="24" font-weight="400">driftstack\.dev<\/text>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
