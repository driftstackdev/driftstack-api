// Theme switcher — chrome-level control over light/dark, which the
// SettingsProvider applies to <html>. ⌘⇧D (Ctrl+⇧+D) toggles from anywhere.
//
// The accent swatches that used to sit here were removed 2026-09-02 at the
// owner's request: the product keeps its one original red, and the light/dark
// axis stays. A picker with a single option is not a choice, so the control is
// gone rather than rendered disabled.

import { useEffect } from 'react';
import { useSettings } from '../lib/SettingsContext';

export function ThemeSwitcher(): JSX.Element {
  const { settings, update } = useSettings();
  const { themeMode } = settings;

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
