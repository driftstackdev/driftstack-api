// Folder visual identity helpers (ProfilesView) — founder feedback that
// folders "look boring without any images". Each folder gets a glyph + a
// deterministic color so it's distinguishable at a glance. These guard the
// mapping + the hash determinism (a non-deterministic color would make the
// folder list flicker between renders).
import { describe, it, expect } from 'vitest';
import { folderGlyph, folderColor } from '../../src/views/ProfilesView';

describe('folderGlyph', () => {
  it('gives All/Unfiled fixed glyphs, keyword folders a themed emoji, and the rest the file glyph', () => {
    expect(folderGlyph('All profiles')).toBe('▦');
    expect(folderGlyph('Unfiled')).toBe('📥');
    expect(folderGlyph('Shopping')).toBe('🛒');
    expect(folderGlyph('Banking')).toBe('🏦');
    expect(folderGlyph('Ad accounts')).toBe('📣');
    expect(folderGlyph('Misc clients')).toBe('📁');
  });
});

describe('folderColor', () => {
  it('is deterministic for a given label (no flicker across renders)', () => {
    expect(folderColor('Shopping')).toBe(folderColor('Shopping'));
    expect(folderColor('Banking')).toBe(folderColor('Banking'));
  });

  it('returns an in-gamut hsl() string with hue 0..359', () => {
    for (const label of ['Shopping', 'Banking', 'Ad accounts', 'x', '']) {
      const c = folderColor(label);
      const m = /^hsl\((\d+) 55% 55%\)$/.exec(c);
      expect(m, `${label} → ${c}`).not.toBeNull();
      const hue = Number(m![1]);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThanOrEqual(359);
    }
  });

  it('distinguishes the common folder names (different hues)', () => {
    const colors = new Set(['Shopping', 'Banking', 'Ad accounts'].map(folderColor));
    expect(colors.size).toBe(3);
  });
});
