// Keyboard-shortcuts cheatsheet overlay (5→10 polish, 2026-06-14). A discover-
// able reference for the app's real shortcuts, opened with `?` (or ⌘/) and from
// the ⌘K palette. Pure presentational + a self-managed Escape-to-close; zero
// blast radius (an overlay over whatever view is active). Only documents
// shortcuts that actually exist (⌘K palette, ⌘⇧D theme, ⌘, settings, ⌘⇧L sign
// out, Enter/⇧Enter in the AI composer) + the live-iPhone mouse/trackpad→touch
// mapping (click=tap, drag=swipe, scroll, typing forwarded) — no aspirational keys.

import { useRef } from 'react';
import type { ReactNode } from 'react';
import { useFocusTrap } from '../lib/use-focus-trap';

const isMac =
  typeof navigator !== 'undefined' &&
  (navigator.platform.startsWith('Mac') || /Mac OS X|Macintosh/.test(navigator.userAgent));
const MOD = isMac ? '⌘' : 'Ctrl';

interface Shortcut {
  keys: string[];
  label: string;
}
interface Group {
  title: string;
  items: Shortcut[];
}

const GROUPS: ReadonlyArray<Group> = [
  {
    title: 'General',
    items: [
      { keys: [MOD, 'K'], label: 'Command palette' },
      { keys: ['?'], label: 'This shortcuts sheet' },
      { keys: [MOD, ','], label: 'Open Settings' },
    ],
  },
  {
    title: 'Appearance',
    items: [{ keys: [MOD, '⇧', 'D'], label: 'Toggle light / dark' }],
  },
  {
    title: 'AI Browser Automation',
    items: [
      { keys: ['Enter'], label: 'Send message' },
      { keys: ['⇧', 'Enter'], label: 'New line' },
    ],
  },
  {
    title: 'Session',
    items: [{ keys: [MOD, '⇧', 'L'], label: 'Sign out (forget key)' }],
  },
  {
    // The live iPhone is a touchscreen driven by the mouse/trackpad — first-timers
    // don't know the mapping (there's no on-device hint), so the one discoverable
    // reference should cover the device itself, not just app shortcuts.
    title: 'iPhone (live session)',
    items: [
      { keys: ['Click'], label: 'Tap' },
      { keys: ['Drag'], label: 'Swipe / drag' },
      { keys: ['Scroll'], label: 'Scroll the page' },
      { keys: ['Type'], label: 'Sent to the device' },
    ],
  },
];

export function ShortcutsCheatsheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Focus-trap the dialog, close on Escape, and restore focus to the opener on
  // close (was Escape-only, so keyboard focus leaked to the view behind it).
  useFocusTrap(open, dialogRef, onClose);

  if (!open) return null;
  return (
    <div
      data-component="shortcuts-cheatsheet"
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="w-[480px] max-w-[92vw] overflow-hidden rounded-xl border border-surface-divider bg-surface-raised shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-surface-divider px-4 py-3">
          <span className="text-sm font-medium text-ink-primary">Keyboard shortcuts</span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="mono text-2xs text-ink-muted hover:text-ink-primary"
          >
            esc
          </button>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 p-4">
          {GROUPS.map((g) => (
            <div key={g.title} className="flex flex-col gap-1.5">
              <span className="section-label">{g.title}</span>
              {g.items.map((s) => (
                <div key={s.label} className="flex items-center justify-between gap-3">
                  <span className="text-xs text-ink-secondary">{s.label}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {s.keys.map((k, i) => (
                      <Kbd key={i}>{k}</Kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }): JSX.Element {
  return (
    <kbd className="mono inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-[5px] border border-surface-divider bg-surface-elevated px-1.5 text-[10px] text-ink-secondary shadow-sm">
      {children}
    </kbd>
  );
}
