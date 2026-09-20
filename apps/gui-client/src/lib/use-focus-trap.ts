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

  // ⛔ WHO TO GIVE THE KEYBOARD BACK TO IS DECIDED DURING RENDER, NOT IN THE
  // EFFECT — found by final QA's keyboard walk of the AI view, and it silently
  // broke the restore for every modal with an `autoFocus` child.
  //
  // React applies `autoFocus` while it COMMITS the DOM, and passive effects run
  // after that. So by the time the effect below asked `document.activeElement`
  // "who was focused before this opened?", the answer was already the modal's
  // OWN first input — and on close it dutifully focused a node it had just
  // detached, which lands the keyboard on `<body>`. Measured on the AI view's
  // save-as-task dialog: the trap logged `prevFocus = INPUT`, and Escape put a
  // keyboard user back at the top of the window, ~20 tab stops from the bar
  // they were working in.
  //
  // The render pass of the update that sets `active` is the last moment before
  // that commit, so it is the only place the real trigger is still focused.
  // Writing a ref there is the documented escape hatch for exactly this; the
  // guard makes it idempotent, so StrictMode's double render (and any re-render
  // while the modal stays open) captures once and never overwrites with a node
  // from inside the modal.
  const restoreTo = useRef<HTMLElement | null>(null);
  const wasActive = useRef(false);
  if (active && !wasActive.current) {
    restoreTo.current = document.activeElement as HTMLElement | null;
  }
  wasActive.current = active;

  useEffect(() => {
    if (!active) return undefined;
    const prevFocus = restoreTo.current;
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
      // so keyboard context isn't lost when it closes. `isConnected` because a
      // trigger can legitimately be gone by then (a row deleted by the very
      // dialog that was open over it) — focusing a detached node is what put
      // the keyboard on `<body>` in the first place, and doing nothing leaves
      // the browser's own focus where it fell instead of moving it further.
      if (prevFocus !== null && prevFocus.isConnected && typeof prevFocus.focus === 'function') {
        prevFocus.focus();
      }
    };
  }, [active, containerRef]);
}
