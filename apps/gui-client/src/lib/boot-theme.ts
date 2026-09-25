// The theme the app paints BEFORE React and the stylesheet can say anything.
//
// Two things live here, and both exist because the first frames of a launch
// are painted by code that cannot read settings.json:
//
//   1. THE MIRROR. The saved theme mode lives in the Tauri store, which is read
//      asynchronously once the bundle has loaded. index.html's pre-paint script
//      runs long before that, so SettingsContext copies the mode into
//      localStorage under THEME_MODE_KEY every time it is known, and index.html
//      reads it back synchronously. Without it the splash (and, until settings
//      resolved, the whole window) painted the default mode on every launch —
//      a dark flash for everyone on the light theme.
//
//   2. THE BOOT COLOURS. The splash and the fatal panel paint with inline styles
//      on purpose (they must work when the CSS bundle did not load), so they
//      cannot use the token classes. These are the SAME values as the
//      [data-mode] token blocks in styles/index.css, restated as hex, and
//      index.html carries a byte-for-byte copy of this table for its own two
//      panels. The guard
//      tests/unit/a-new-install-opens-light-and-a-saved-theme-paints-from-the-first-frame.test.tsx
//      reads all three (this table, the index.html copy, index.css) and fails
//      when any of them disagree.

export type BootMode = 'light' | 'dark';

/** The localStorage key the saved theme mode is mirrored under. The web
 *  surfaces use the same key for the same meaning. */
export const THEME_MODE_KEY = 'ds_theme_mode';

export interface BootColours {
  /** --surface-base-rgb: the window ground. */
  base: string;
  /** --surface-raised-rgb: the message box. */
  raised: string;
  /** --surface-inset-rgb: the stack-trace well. */
  inset: string;
  /** --surface-divider-rgb: hairlines and the spinner track. */
  divider: string;
  /** --ink-primary-rgb: the heading and the error code. */
  ink: string;
  /** --ink-secondary-rgb: the body copy and the message. */
  inkSecondary: string;
  /** --ink-muted-rgb: the splash caption, the disclosure and the stack. */
  inkMuted: string;
  /** --accent-rgb: the Reload fill and the spinner head (the same in both modes). */
  accent: string;
  /** --on-accent-rgb: the Reload label. */
  onAccent: string;
}

export const BOOT_COLOURS: Readonly<Record<BootMode, BootColours>> = {
  light: {
    base: '#ebedf2',
    raised: '#f8f9fb',
    inset: '#e0e3ea',
    divider: '#cdd3dc',
    ink: '#1a1d23',
    inkSecondary: '#525863',
    inkMuted: '#5b6270',
    accent: '#a83b4d',
    onAccent: '#ffffff',
  },
  dark: {
    base: '#0f172a',
    raised: '#1e293b',
    inset: '#0a0f1c',
    divider: '#475569',
    ink: '#f1f5f9',
    inkSecondary: '#cbd5e1',
    inkMuted: '#94a3b8',
    accent: '#a83b4d',
    onAccent: '#ffffff',
  },
};

/** The colours for whatever mode <html> carries right now: the pre-paint
 *  script's choice at boot, the live setting once React has applied it, and
 *  dark in the simulator window, which main.tsx pins dark. */
export function bootColours(): BootColours {
  const mode = typeof document === 'undefined' ? null : document.documentElement.dataset.mode;
  return BOOT_COLOURS[mode === 'dark' ? 'dark' : 'light'];
}

/** The mirrored mode, or null when nothing (or nothing valid) was mirrored. */
export function readMirroredThemeMode(): BootMode | null {
  try {
    const saved = localStorage.getItem(THEME_MODE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : null;
  } catch {
    return null;
  }
}

/** Mirror the mode for the next launch's first frame. Best-effort: a blocked
 *  localStorage costs only the pre-paint, never the setting itself. */
export function writeMirroredThemeMode(mode: BootMode): void {
  try {
    if (localStorage.getItem(THEME_MODE_KEY) !== mode) localStorage.setItem(THEME_MODE_KEY, mode);
  } catch {
    /* the persisted setting still stands; only the pre-paint loses it */
  }
}
