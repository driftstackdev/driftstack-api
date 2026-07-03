// Mirror of apps/server/tests/unit/marketing-site-components-v2-kit-content-parity.test.ts
// (W529) — the marketing-local guard for the Fleet v2 shared component kit.
// Pins the invariants a page author could silently break from this side:
// the HonestyChip verbatim labels, PriceCard's no-figures rule, the
// CodeWindow plain-code script, and that every kit component stays free
// of inline handlers / baked hexes.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENTS = resolve(HERE, '..', '..', 'src', 'components');

function read(name: string): string {
  return readFileSync(resolve(COMPONENTS, name), 'utf8');
}

const KIT = [
  'Section.astro',
  'PageHero.astro',
  'Card.astro',
  'IconTile.astro',
  'Stat.astro',
  'HonestyChip.astro',
  'FeatureRow.astro',
  'PriceCard.astro',
  'CtaBand.astro',
  'CodeWindow.astro',
];

describe('Fleet v2 component kit content parity (marketing mirror)', () => {
  it('all 10 kit components exist', () => {
    for (const name of KIT) {
      expect(existsSync(resolve(COMPONENTS, name)), name).toBe(true);
    }
  });

  it('HonestyChip labels stay verbatim (Live / Rolling out / Roadmap) with status-token tones', () => {
    const body = read('HonestyChip.astro');
    expect(body).toMatch(/live: 'Live',/);
    expect(body).toMatch(/'rolling-out': 'Rolling out',/);
    expect(body).toMatch(/roadmap: 'Roadmap',/);
    expect(body).toMatch(/text-tk-ready/);
    expect(body).toMatch(/text-tk-busy/);
  });

  it('PriceCard never carries figures or imports pricing data (the caller binds from src/data/pricing.ts)', () => {
    const body = read('PriceCard.astro');
    expect(body).not.toMatch(/\$\d/);
    expect(body).not.toMatch(/from '\.\.\/data\/pricing/);
    expect(body).toMatch(/price: string;/);
  });

  it('CodeWindow inline script is plain executable code with a double-bind guard (no template-literal expression container)', () => {
    const body = read('CodeWindow.astro');
    expect(body).toMatch(/window\.__dsCopyWired = true;/);
    expect(body).not.toMatch(/<script is:inline>\s*\{/);
  });

  it('Section/PageHero render the mono // section-label and tokened headlines', () => {
    expect(read('Section.astro')).toMatch(/class="section-label">\{label\}/);
    expect(read('PageHero.astro')).toMatch(/class="section-label">\{label\}/);
  });

  it('kit hygiene: no inline event handlers, no baked hex colors, .dev TLD only', () => {
    for (const name of KIT) {
      const body = read(name);
      expect(body, name).not.toMatch(/\son[a-z]+="/);
      expect(body, name).not.toMatch(/#[0-9a-fA-F]{6}\b/);
      expect(body, name).not.toMatch(/driftstack\.(com|io|app|co)\b/);
    }
  });
});
