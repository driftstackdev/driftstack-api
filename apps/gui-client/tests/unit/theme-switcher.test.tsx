// ThemeSwitcher — chrome-level theme/accent control. Asserts the active
// accent is marked pressed, that clicking an accent / the mode button / ⌘⇧D
// each persist the right partial settings update. The SettingsProvider's
// <html> dataset effect is covered elsewhere; here we only verify the control
// drives update().

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ThemeAccent, ThemeMode } from '../../src/lib/settings';

const update = vi.fn(() => Promise.resolve());
let settings: { themeMode: ThemeMode; themeAccent: ThemeAccent } = {
  themeMode: 'light',
  themeAccent: 'violet',
};

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ settings, update }),
}));

const { ThemeSwitcher } = await import('../../src/components/ThemeSwitcher');

describe('ThemeSwitcher', () => {
  beforeEach(() => {
    cleanup();
    update.mockClear();
    settings = { themeMode: 'light', themeAccent: 'violet' };
  });

  it('marks the active accent pressed and the others not', () => {
    render(<ThemeSwitcher />);
    expect(screen.getByLabelText('Violet accent').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('Oxblood accent').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByLabelText('Teal accent').getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking an accent persists it', () => {
    render(<ThemeSwitcher />);
    fireEvent.click(screen.getByLabelText('Teal accent'));
    expect(update).toHaveBeenCalledWith({ themeAccent: 'teal' });
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
    settings = { themeMode: 'dark', themeAccent: 'oxblood' };
    render(<ThemeSwitcher />);
    fireEvent.click(screen.getByLabelText('Switch to light mode'));
    expect(update).toHaveBeenCalledWith({ themeMode: 'light' });
  });
});
