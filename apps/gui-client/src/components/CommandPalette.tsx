// ⌘K command palette — the demo-concepts arc's navigation accelerator
// (mocked first in docs/internal/visual-demos/gui-profiles-hub.html per the
// demo-first workflow; founder previewed the overlay there).
//
// Deliberately dependency-free and data-agnostic: the caller passes a flat
// list of actions (navigate / launch-profile / quick-session / …); the
// palette filters case-insensitively over label + keywords, supports
// ↑/↓/Enter/Escape, and closes on backdrop click. Match ranking is
// startsWith-first then substring — predictable beats clever for a
// muscle-memory surface.

import { useEffect, useMemo, useRef, useState } from 'react';

export interface PaletteAction {
  id: string;
  /** Primary label, e.g. "Launch · amsterdam-shopper". */
  label: string;
  /** Right-aligned kind chip, e.g. "profile" | "view" | "action". */
  kind: string;
  /** Extra match terms (profile archetype, view aliases …). */
  keywords?: string[];
  /** Leading glyph (emoji/char — keeps the component icon-library-free). */
  glyph?: string;
  run: () => void;
}

export function filterActions(actions: PaletteAction[], query: string): PaletteAction[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return actions.slice(0, 8);
  const starts: PaletteAction[] = [];
  const contains: PaletteAction[] = [];
  for (const a of actions) {
    const hay = [a.label, ...(a.keywords ?? [])].map((s) => s.toLowerCase());
    if (hay.some((h) => h.startsWith(q))) starts.push(a);
    else if (hay.some((h) => h.includes(q))) contains.push(a);
  }
  return [...starts, ...contains].slice(0, 8);
}

export function CommandPalette({
  open,
  actions,
  onClose,
}: {
  open: boolean;
  actions: PaletteAction[];
  onClose: () => void;
}): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const matches = useMemo(() => filterActions(actions, query), [actions, query]);

  // Reset + focus on every open; cursor clamps as the match list shrinks.
  // (Tab-containment + Escape are handled on the input's onKeyDown — the palette
  // deliberately CLOSES on Tab rather than trapping, so useFocusTrap isn't the
  // right fit here; the only gap was restoring focus to the opener on close.)
  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      const prevFocus = document.activeElement as HTMLElement | null;
      // focus after paint so the overlay exists
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => {
        clearTimeout(t);
        // Return focus to whatever opened the palette (keyboard context was lost).
        if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
      };
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, matches.length - 1)));
  }, [matches.length]);

  if (!open) return null;

  function runAt(index: number): void {
    const action = matches[index];
    if (!action) return;
    onClose();
    action.run();
  }

  return (
    <div
      data-component="command-palette"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-50 grid place-items-start justify-center bg-black/35 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[560px] max-w-[90vw] overflow-hidden rounded-xl border border-surface-divider bg-surface-raised shadow-2xl">
        <div className="flex items-center gap-2.5 border-b border-surface-divider px-4 py-3">
          <span className="text-xs text-ink-muted">⌘K</span>
          <input
            ref={inputRef}
            value={query}
            placeholder="Search profiles, views, actions…"
            aria-label="Command palette search"
            role="combobox"
            aria-expanded={matches.length > 0}
            aria-controls="palette-results"
            aria-activedescendant={
              matches[cursor] ? `palette-opt-${matches[cursor].id}` : undefined
            }
            className="flex-1 border-0 bg-transparent text-sm text-ink-primary outline-none placeholder:text-ink-muted"
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'Tab') {
                // containment: the palette is modal — Tab must not move focus
                // behind the backdrop. Close instead (same as Escape).
                e.preventDefault();
                onClose();
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, matches.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                runAt(cursor);
              }
            }}
          />
          <span className="mono text-2xs text-ink-muted">esc</span>
        </div>
        <ul id="palette-results" className="p-2" role="listbox" aria-label="Command results">
          {matches.length === 0 && (
            <li className="px-3 py-4 text-center text-sm text-ink-muted">No matches.</li>
          )}
          {matches.map((a, i) => (
            <li key={a.id} id={`palette-opt-${a.id}`} role="option" aria-selected={i === cursor}>
              <button
                type="button"
                className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm ${
                  i === cursor ? 'bg-accent-subtle text-ink-primary' : 'text-ink-secondary'
                }`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => runAt(i)}
              >
                {a.glyph ? <span aria-hidden="true">{a.glyph}</span> : null}
                <span className="truncate">{a.label}</span>
                <span className="mono ml-auto shrink-0 text-2xs text-ink-muted">{a.kind}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
