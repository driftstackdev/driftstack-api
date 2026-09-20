// "How big is the view itself?" — measured, once per resize, on ONE observer.
//
// Stage 6 asked this of the width; stage 5 asked it of the height in a second
// file. Stage 4 needs FIVE tiers off the same box (spec §1) and merges them:
// two observers on one element answer the same resize twice and can disagree
// for a frame, and the spec's tiers are written against ONE container.
//
// ⛔ WHY THIS IS A HOOK AND NOT `container-type: size` ON THE VIEW ROOT.
// Spec §1 writes these tiers as `@container aiview (…)`. The view root cannot
// be that container:
//
//   1. `container-type: size` / `inline-size` MAKES THE ELEMENT A CONTAINING
//      BLOCK FOR `position: fixed` DESCENDANTS (both apply layout containment).
//      The view root holds the save-as-task dialog and the screenshot lightbox,
//      both `fixed inset-0`, and the rail's own overlay. Declaring the container
//      here would shrink two modal backdrops to the view they sit in — a silent
//      layout change in components this stage does not own, to serve a
//      breakpoint. `the-ai-view-puts-the-stage-in-reading-order.test.tsx` pins
//      that trap shut, with `.ai-fit` as its positive control.
//   2. The spec ALREADY names a `ResizeObserver` as the supported fallback for
//      the WebViews with no `cq` units at all (macOS 12 WKWebView, the oldest
//      WebKitGTK). Those are shipping targets, so the measurement has to exist
//      regardless; a container query would be the optimisation, not the truth.
//
// The ONE container query the view does declare is `.ai-fit` — the box the
// phone is sized inside — which has no fixed descendant and needs `100cqh`
// (§3.4). Its own JS fallback lives in `use-device-fit.ts`.
//
// ⚠️ NO `ResizeObserver` MEANS NO TIER, never "narrow by default" or "short by
// default". jsdom has no ResizeObserver and a jsdom element measures 0x0 —
// which is ≤ 900 AND ≤ 620, and would put every view test in the 44px-strip,
// short-window layout, where the saved-chat list is CSS-hidden and the tests
// that read it would be measuring a rail nobody sees. An unmeasured view keeps
// the layout the customer gets at the default window size.

import { useEffect, useState, type RefObject } from 'react';

/** Spec §1's small tier: the view's own box, 900px wide or less. At the 960px
 *  minimum window the view is 736px; at 1024x640 it is 800px. */
export const NARROW_VIEW_MAX_PX = 900;
/** Spec §1's wide tier: 1300px or more. At a 1600px window the view is 1376px. */
export const WIDE_VIEW_MIN_PX = 1300;
/** Spec §1's short tier: 620px tall or less (the 600px-tall minimum window). */
export const SHORT_VIEW_MAX_PX = 620;
/** Spec §1's tall tier: 700px or more — the live turn is set larger. */
export const TALL_VIEW_MIN_PX = 700;
/** Spec §1's large tier, with `wide`: 860px or more (a 1600x1000 window). */
export const LARGE_VIEW_MIN_PX = 860;

export interface ViewTier {
  /** The 44px rail strip, the 44px bar, no sparkle chip, budget only when low. */
  narrow: boolean;
  /** The roomy tier: more rail, a wider stage, the budget spells itself out. */
  wide: boolean;
  /** The 600px-tall minimum window: the hero drops its beats, the composer
   *  gives a row back, a settled plan collapses so the answer stays on screen. */
  short: boolean;
  /** Room to breathe: the live turn is set larger rather than leaving the
   *  column half empty. No filler is invented — only the type steps up. */
  tall: boolean;
  /** `wide` AND 860px tall: one more step up the same scale. */
  large: boolean;
}

const NO_TIER: ViewTier = {
  narrow: false,
  wide: false,
  short: false,
  tall: false,
  large: false,
};

/** The tiers a box of this size is in. Pure, so every boundary is testable
 *  without a DOM — and so the five booleans are derived in ONE place rather
 *  than at each of the five call sites that ask.
 *
 *  A width or height of exactly 0 is "not measured", never "as small as can
 *  be": an element that has not been laid out yet reports 0, and 0 ≤ 900 would
 *  flip the layout for one frame on every mount. */
export function viewTierFor(width: number, height: number): ViewTier {
  const w = width > 0 ? width : null;
  const h = height > 0 ? height : null;
  const wide = w !== null && w >= WIDE_VIEW_MIN_PX;
  return {
    narrow: w !== null && w <= NARROW_VIEW_MAX_PX,
    wide,
    short: h !== null && h <= SHORT_VIEW_MAX_PX,
    tall: h !== null && h >= TALL_VIEW_MIN_PX,
    large: wide && h !== null && h >= LARGE_VIEW_MIN_PX,
  };
}

function sameTier(a: ViewTier, b: ViewTier): boolean {
  return (
    a.narrow === b.narrow &&
    a.wide === b.wide &&
    a.short === b.short &&
    a.tall === b.tall &&
    a.large === b.large
  );
}

/**
 * Which tiers the observed element is in. Every tier false until something is
 * actually measured, and false forever where there is nothing to measure with.
 */
export function useViewTier(ref: RefObject<Element>): ViewTier {
  const [tier, setTier] = useState<ViewTier>(NO_TIER);
  useEffect(() => {
    const node = ref.current;
    if (node === null || typeof ResizeObserver === 'undefined') return undefined;
    const read = (width: number, height: number): void => {
      const next = viewTierFor(width, height);
      // Object identity matters here: this value is a prop on three components
      // and a dependency of the effect that closes the rail overlay, so a new
      // object per resize frame would re-run all of them for a tier that did
      // not change.
      setTier((prev) => (sameTier(prev, next) ? prev : next));
    };
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry === undefined) return;
      // `contentRect` is the content box — the box the spec's tiers are written
      // against, and the one a container query would measure.
      read(entry.contentRect.width, entry.contentRect.height);
    });
    // ⚠️ ORDER MATTERS, and only one way round is right: the synchronous read is
    // the first measurement, taken without waiting for a resize that may never
    // come; observing first lets a synchronously-firing callback be overwritten
    // by the fallback read a line later — which is how it is driven in a test,
    // and how it failed there.
    //
    // ⛔ `getBoundingClientRect()` is the BORDER box and `contentRect` is the
    // CONTENT box. They are the same only while the view root has no padding
    // and no border; it has neither, and `the-ai-view-root-carries-no-padding`
    // in the layout test keeps it that way, because otherwise the first frame
    // and every frame after it would disagree by that amount and a tier could
    // flip once on mount.
    const box = node.getBoundingClientRect();
    read(box.width, box.height);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return tier;
}
