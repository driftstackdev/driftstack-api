// Small presence helper for modal exit transitions. It deliberately owns no
// DOM refs or event listeners: callers keep their accessibility/focus effects
// keyed to the real `open` value and use this hook only to retain the inert
// render tree long enough for the exit animation to finish.

import { useEffect, useState } from 'react';

export interface ModalPresence {
  shouldRender: boolean;
  isExiting: boolean;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Retain an open modal during its exit animation (120ms by default). */
export function useModalPresence(open: boolean, exitDurationMs = 120): ModalPresence {
  const [retained, setRetained] = useState(open);

  useEffect(() => {
    if (open) {
      setRetained(true);
      return undefined;
    }

    if (!retained) return undefined;

    // The global CSS motion preference clamps animations already; removing the
    // retained tree immediately also prevents an invisible modal from lingering.
    if (prefersReducedMotion()) {
      setRetained(false);
      return undefined;
    }

    const timer = window.setTimeout(() => setRetained(false), exitDurationMs);
    return () => window.clearTimeout(timer);
  }, [exitDurationMs, open, retained]);

  const shouldRender = open || retained;
  return { shouldRender, isExiting: shouldRender && !open };
}
