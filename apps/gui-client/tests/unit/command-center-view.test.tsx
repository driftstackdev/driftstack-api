// Command Center home (G4) — the overview that leads with Automate. Asserts the
// Automate hero CTAs route to ai / recipes, the KPI strip renders from a mocked
// accountMe (and degrades to "—" when null), and the quick links navigate. Uses
// a controllable useSettings mock so it runs without the Tauri/SDK chain.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { HomeNavTarget } from '../../src/views/CommandCenterView';

let accountMe: unknown = null;
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ accountMe }),
}));

const { CommandCenterView } = await import('../../src/views/CommandCenterView');

function nav() {
  return vi.fn<(k: HomeNavTarget) => void>();
}

describe('CommandCenterView', () => {
  beforeEach(() => {
    cleanup();
    accountMe = null;
  });

  it('leads with Automate: the hero CTAs route to ai and recipes', () => {
    const onNavigate = nav();
    render(<CommandCenterView onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask Driftstack AI' }));
    expect(onNavigate).toHaveBeenCalledWith('ai');
    fireEvent.click(screen.getByRole('button', { name: 'Browse recipes' }));
    expect(onNavigate).toHaveBeenCalledWith('recipes');
  });

  it('renders the KPI strip from accountMe', () => {
    accountMe = {
      tier: 'builder',
      concurrent_session_active: 2,
      concurrent_session_cap: 4,
      profile_count: 7,
      profile_cap: 25,
    };
    render(<CommandCenterView onNavigate={nav()} />);
    expect(screen.getByText('Builder')).toBeTruthy(); // tier title-cased
    expect(screen.getByText('2 / 4')).toBeTruthy(); // sessions active/cap
    expect(screen.getByText('7 / 25')).toBeTruthy(); // profiles created/cap
  });

  it('degrades gracefully to "—" when accountMe is null (loading/unauth)', () => {
    accountMe = null;
    render(<CommandCenterView onNavigate={nav()} />);
    // Plan + both ratios all show the em-dash placeholder.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('quick links navigate to profiles / proxies / sessions', () => {
    const onNavigate = nav();
    render(<CommandCenterView onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: /Profiles/ }));
    fireEvent.click(screen.getByRole('button', { name: /Proxies/ }));
    fireEvent.click(screen.getByRole('button', { name: /Sessions/ }));
    expect(onNavigate).toHaveBeenCalledWith('profiles');
    expect(onNavigate).toHaveBeenCalledWith('proxies');
    expect(onNavigate).toHaveBeenCalledWith('sessions');
  });
});
