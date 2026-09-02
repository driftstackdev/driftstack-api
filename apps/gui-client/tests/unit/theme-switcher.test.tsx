// ThemeSwitcher — chrome-level LIGHT/DARK control. Asserts the mode button and
// ⌘⇧D each persist the right partial settings update. The SettingsProvider's
// <html> dataset effect is covered elsewhere; here we only verify the control
// drives update().
//
// The two accent arms that used to live here were removed with the swatches
// (2026-09-02, owner: keep the one original red). They pinned a picker that no
// longer exists, so keeping them would have meant keeping the picker. The
// replacement arm below asserts the ABSENCE, which is the property that can
// actually regress: a future change re-adding a colour picker fails here.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ThemeMode } from '../../src/lib/settings';

const update = vi.fn(() => Promise.resolve());
let settings: { themeMode: ThemeMode } = { themeMode: 'light' };

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ settings, update }),
}));

const { ThemeSwitcher } = await import('../../src/components/ThemeSwitcher');

describe('ThemeSwitcher', () => {
  beforeEach(() => {
    cleanup();
    update.mockClear();
    settings = { themeMode: 'light' };
  });

  it('offers NO accent picker — the product has one accent', () => {
    // The removal, pinned. Matches any "<name> accent" control rather than the
    // three that existed, so re-adding a picker under a new colour name still
    // fails here.
    render(<ThemeSwitcher />);
    expect(screen.queryAllByLabelText(/accent/i)).toHaveLength(0);
    expect(screen.queryByRole('group', { name: /accent/i })).toBeNull();
  });

  it('still renders the light/dark control it exists for', () => {
    // Vacuity control: the arm above must pass because the swatches are gone,
    // not because the component renders nothing.
    render(<ThemeSwitcher />);
    expect(screen.getByLabelText('Switch to dark mode')).toBeTruthy();
  });

  it('the mode button toggles light → dark', () => {
    render(<ThemeSwitcher />);
    fireEvent.click(screen.getByLabelText('Switch to dark mode'));
    expect(update).toHaveBeenCalledWith({ themeMode: 'dark' });
  });

  it('⌘⇧D toggles the mode from anywhere', () => {
    render(<ThemeSwitcher />);
    fireEvent.keyDown(document, { key: 'd', metaKey: true, shiftKey: true });
    expect(update).toHaveBeenCalledWith({ themeMode: 'dark' });
  });

  it('in dark mode the button offers a switch back to light', () => {
    settings = { themeMode: 'dark' };
    render(<ThemeSwitcher />);
    fireEvent.click(screen.getByLabelText('Switch to light mode'));
    expect(update).toHaveBeenCalledWith({ themeMode: 'light' });
  });
});
