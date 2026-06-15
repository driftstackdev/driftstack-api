// Profile grid IDENTITY card helpers (G2, 2026-06-14). The old MiniPage faux
// webpage read as "random browser images" (founder); the card now shows a
// deterministic monogram on a per-profile hue. These guard the monogram
// derivation (initials, casing, edge cases) + the hue determinism (a
// non-deterministic hue would flicker the grid between renders).
import { describe, it, expect } from 'vitest';
import { profileMonogram, identityHue, formatDeviceName } from '../../src/views/ProfilesView';

describe('profileMonogram', () => {
  it('takes the first two initials for a multi-word name, uppercased', () => {
    expect(profileMonogram('amsterdam shopper')).toBe('AS');
    expect(profileMonogram('Acme Bank EU')).toBe('AB');
    expect(profileMonogram('shop_eu_01')).toBe('SE'); // splits on _ and -
    expect(profileMonogram('ad-account-3')).toBe('AA');
  });

  it('takes the first two letters of a single-word name', () => {
    expect(profileMonogram('Shopper')).toBe('SH');
    expect(profileMonogram('x')).toBe('X');
  });

  it('degrades to "?" for an empty / whitespace name', () => {
    expect(profileMonogram('')).toBe('?');
    expect(profileMonogram('   ')).toBe('?');
  });
});

describe('identityHue', () => {
  it('is deterministic for a given name (no flicker across renders)', () => {
    expect(identityHue('amsterdam shopper')).toBe(identityHue('amsterdam shopper'));
    expect(identityHue('Acme Bank')).toBe(identityHue('Acme Bank'));
  });

  it('stays within 0..359', () => {
    for (const n of ['amsterdam shopper', 'x', '', 'Acme Bank EU', 'a'.repeat(200)]) {
      const h = identityHue(n);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(359);
    }
  });

  it('distinguishes common names (different hues)', () => {
    const hues = new Set(['shop-eu', 'bank-us', 'ads-meta'].map(identityHue));
    expect(hues.size).toBe(3);
  });
});

describe('formatDeviceName', () => {
  it('renders the model from the archetype id (takes the first _ segment)', () => {
    expect(formatDeviceName('iphone17_ios18_7_safari26_4')).toBe('iPhone 17');
    expect(formatDeviceName('iphone16pro_ios18_7_safari26_4')).toBe('iPhone 16 Pro');
    expect(formatDeviceName('iphone16promax')).toBe('iPhone 16 Pro Max');
    expect(formatDeviceName('iphone16e')).toBe('iPhone 16e');
  });

  it('degrades gracefully for an unrecognized archetype', () => {
    expect(formatDeviceName('pixel8_android14')).toBe('pixel8');
    expect(formatDeviceName('')).toBe('iPhone');
  });
});
