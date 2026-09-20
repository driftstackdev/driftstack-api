// "How wide is the view itself?" — measured, once per resize.
//
// Stage 6 of the AI-view rebuild. Spec §1 puts the reflow tiers in container
// queries on the view root (`@container aiview (max-width: 900px)` and
// `(min-width: 1300px)`), and stage 4 is the stage that establishes that
// container. This is the same measured-boolean answer `use-short-view.ts` gives
// for the HEIGHT tier, for the same two reasons, which are worth repeating
// rather than cross-referencing because they are what makes a hook the right
// answer at all:
//
//   1. ⛔ `container-type: size` / `inline-size` MAKES THE ELEMENT A CONTAINING
//      BLOCK FOR `position: fixed` DESCENDANTS (both types apply layout
//      containment). The view root holds the save-as-task dialog and the
//      screenshot lightbox, both `fixed inset-0`. Declaring the container in
//      this stage would quietly shrink two modal backdrops to the view they sit
//      in — a layout change in components this stage does not own.
//   2. The spec already names a `ResizeObserver` as the supported fallback for
//      the WebViews with no `cq` units at all (macOS 12 WKWebView, the oldest
//      WebKitGTK). Those are shipping targets, so the measurement has to exist
//      regardless; the container query is the optimisation, not the truth.
//
// ⚠️ NO `ResizeObserver` MEANS NEITHER TIER, never "narrow by default". jsdom
// has no ResizeObserver and a jsdom element measures 0x0 — which is ≤ 900 and
// would put every view test in the 44px-strip layout, where the saved-chat list
// is CSS-hidden and the tests that read it would be measuring a rail nobody
// sees. An unmeasured view keeps the layout the customer gets at the default
// window size.

import { useEffect, useState, type RefObject } from 'react';

/** Spec §1's small tier: the view's own box, 900px wide or less. At the 960px
 *  minimum window the view is 736px; at 1024x640 it is 800px. */
export const NARROW_VIEW_MAX_PX = 900;
/** Spec §1's wide tier: 1300px or more. At a 1600px window the view is 1376px. */
export const WIDE_VIEW_MIN_PX = 1300;

export interface ViewTier {
  /** The 44px rail strip, the 44px bar, no sparkle chip, budget only when low. */
  narrow: boolean;
  /** The roomy tier: the budget spells itself out. */
  wide: boolean;
}

/**
 * Which width tier the observed element is in.
 *
 * Both false until something is actually measured, and both false forever where
 * there is nothing to measure with. A width of exactly 0 is treated as "not
 * measured": an element that has not been laid out yet reports 0, and 0 ≤ 900
 * would flip the layout for one frame on every mount.
 */
export function useViewTier(ref: RefObject<Element>): ViewTier {
  const [tier, setTier] = useState<ViewTier>({ narrow: false, wide: false });
  useEffect(() => {
    const node = ref.current;
    if (node === null || typeof ResizeObserver === 'undefined') return undefined;
    const read = (width: number): void => {
      const next: ViewTier = {
        narrow: width > 0 && width <= NARROW_VIEW_MAX_PX,
        wide: width >= WIDE_VIEW_MIN_PX,
      };
      // Object identity matters here: this value is a prop on two components and
      // a dependency of the effect that closes the rail overlay, so a new object
      // per resize frame would re-run both for a tier that did not change.
      setTier((prev) => (prev.narrow === next.narrow && prev.wide === next.wide ? prev : next));
    };
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry === undefined) return;
      // `contentRect` is the content box — the box the spec's tiers are written
      // against, and the one a container query would measure.
      read(entry.contentRect.width);
    });
    // ⚠️ ORDER MATTERS, and only one way round is right — see use-short-view.ts:
    // the synchronous read is the first measurement, taken without waiting for a
    // resize that may never come; observing first lets a synchronously-firing
    // callback be overwritten by the fallback read a line later.
    read(node.getBoundingClientRect().width);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return tier;
}
