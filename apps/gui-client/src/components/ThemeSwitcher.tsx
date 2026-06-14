// Theme/accent switcher — chrome-level control over the two theme axes
// (data-mode light|dark × data-accent violet|oxblood|teal) that the
// SettingsProvider applies to <html>. These were only reachable buried in
// Settings; surfacing them in the title bar makes the whole-app restyle a
// one-click delight. ⌘⇧D (Ctrl+⇧+D) toggles light/dark from anywhere.
//
// Accent swatches use the fixed brand hexes (they identify the accent
// regardless of the active theme), so they're inline styles, not tokens.

import { useEffect } from 'react';
import { useSettings } from '../lib/SettingsContext';
import type { ThemeAccent } from '../lib/settings';

const ACCENTS: ReadonlyArray<{ id: ThemeAccent; label: string; color: string }> = [
  { id: 'violet', label: 'Violet', color: '#6d5efc' },
  { id: 'oxblood', label: 'Oxblood', color: '#722f37' },
  { id: 'teal', label: 'Teal', color: '#109a82' },
];

export function ThemeSwitcher(): JSX.Element {
  const { settings, update } = useSettings();
  const { themeMode, themeAccent } = settings;

  // Global ⌘⇧D / Ctrl+⇧+D → toggle light/dark.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        void update({ themeMode: themeMode === 'dark' ? 'light' : 'dark' });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [themeMode, update]);

  return (
    <div className="flex items-center gap-1.5" data-component="theme-switcher">
      <div className="flex items-center gap-1" role="group" aria-label="Accent colour">
        {ACCENTS.map((a) => {
          const active = a.id === themeAccent;
          return (
            <button
              key={a.id}
              type="button"
              aria-label={`${a.label} accent`}
              aria-pressed={active}
              title={`${a.label} accent`}
              onClick={() => void update({ themeAccent: a.id })}
              className={`h-3 w-3 rounded-full border transition-transform hover:scale-110 ${
                active ? 'border-ink-primary ring-1 ring-ink-primary/40' : 'border-transparent'
              }`}
              style={{ backgroundColor: a.color }}
            />
          );
        })}
      </div>
      <button
        type="button"
        aria-label={themeMode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        title={`${themeMode === 'dark' ? 'Light' : 'Dark'} mode (⌘⇧D)`}
        onClick={() => void update({ themeMode: themeMode === 'dark' ? 'light' : 'dark' })}
        className="flex h-5 w-5 items-center justify-center rounded text-ink-muted hover:text-ink-primary"
      >
        {themeMode === 'dark' ? <IconSun /> : <IconMoon />}
      </button>
    </div>
  );
}

function IconSun(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M13 3l-1 1M4 12l-1 1" />
    </svg>
  );
}

function IconMoon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" />
    </svg>
  );
}
