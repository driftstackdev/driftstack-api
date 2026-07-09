// Reusable modal focus management (round-2 a11y, 2026-07-09). Generalises the
// ConfirmProvider dialog's behaviour so any overlay can: keep keyboard focus
// inside itself while open (Tab / Shift+Tab wrap at the edges instead of
// escaping to the view behind), focus the first control on open, restore focus
// to the previously-focused element on close, and close on Escape. Without this
// a keyboard user tabs straight out of a "modal" into the hidden UI behind it.

import { useEffect, useRef, type RefObject } from 'react';

// Interactive, tabbable descendants — disabled controls and tabindex=-1 are
// intentionally excluded so the wrap lands on real stops.
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Trap keyboard focus inside `containerRef` while `active`.
 *
 * @param active       whether the trap is engaged (usually the modal's `open`)
 * @param containerRef the modal container to trap focus within
 * @param onEscape     optional — called when Escape is pressed while active
 */
export function useFocusTrap(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onEscape?: () => void,
): void {
  // Hold onEscape in a ref so an inline arrow from the caller doesn't re-run the
  // effect (which would re-focus the first control) on every parent render.
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return undefined;
    const prevFocus = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    // Move focus inside on open so the keyboard user starts in the modal.
    const initial = container?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    (initial && initial.length > 0 ? initial[0] : container)?.focus();

    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        if (onEscapeRef.current) {
          e.preventDefault();
          onEscapeRef.current();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const items = containerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (!items || items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      // Restore focus to whatever opened the modal (a menu item / trigger),
      // so keyboard context isn't lost when it closes.
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
    };
  }, [active, containerRef]);
}
