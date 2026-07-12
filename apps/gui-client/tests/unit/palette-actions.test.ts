// P2 #7 — the ⌘K command palette must offer the same primary sidebar destinations
// as the rail. Session log / Mac mini fleet / Team were missing. These pin the
// builder's destination set + the gating (fleet on self-hosted, Team for a member
// or team-capable tier) so the palette stays in lockstep with the Sidebar.

import { describe, expect, it, vi } from 'vitest';
import { buildPaletteActions, paletteShowTeam, type View } from '../../src/App';

function ids(showFleet: boolean, showTeam: boolean): string[] {
  return buildPaletteActions({
    setView: vi.fn<(v: View) => void>(),
    onShowShortcuts: vi.fn(),
    showFleet,
    showTeam,
  }).map((a) => a.id);
}

describe('buildPaletteActions — sidebar destination parity (P2 #7)', () => {
  it('always includes Session log (the destination that was missing)', () => {
    expect(ids(false, false)).toContain('nav-sessions-history');
  });

  it('includes Mac mini fleet ONLY when showFleet (self-hosted), and Team ONLY when showTeam', () => {
    expect(ids(false, false)).not.toContain('nav-fleet');
    expect(ids(false, false)).not.toContain('nav-team');
    const all = ids(true, true);
    expect(all).toContain('nav-fleet');
    expect(all).toContain('nav-team');
  });

  it('routes each new destination to its matching view kind', () => {
    const routed: View[] = [];
    const actions = buildPaletteActions({
      setView: (v) => routed.push(v),
      onShowShortcuts: vi.fn(),
      showFleet: true,
      showTeam: true,
    });
    for (const id of ['nav-sessions-history', 'nav-fleet', 'nav-team']) {
      actions.find((a) => a.id === id)?.run();
    }
    expect(routed.map((v) => v.kind)).toEqual(['sessions-history', 'fleet', 'team']);
  });

  it('still carries the existing primary destinations', () => {
    const all = ids(true, true);
    expect(all).not.toContain('nav-marketplace');
    for (const id of [
      'nav-home',
      'nav-ai',
      'nav-recipes',
      'nav-profiles',
      'nav-sessions',
      'nav-recordings',
      'nav-proxies',
      'nav-billing',
      'nav-settings',
      'show-shortcuts',
    ]) {
      expect(all).toContain(id);
    }
  });
});

describe('paletteShowTeam — matches the Sidebar Team gate', () => {
  it('true for a team member (count>0) regardless of tier', () => {
    expect(paletteShowTeam('solo_manual', 1)).toBe(true);
  });
  it('true for a team-capable tier even with no members yet', () => {
    expect(paletteShowTeam('team_manual', 0)).toBe(true);
    expect(paletteShowTeam('agency_manual', 0)).toBe(true);
    expect(paletteShowTeam('enterprise', 0)).toBe(true);
  });
  it('false for a non-team tier with no team membership', () => {
    expect(paletteShowTeam('solo_manual', 0)).toBe(false);
    expect(paletteShowTeam(null, 0)).toBe(false);
  });
});
