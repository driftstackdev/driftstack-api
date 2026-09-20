// "Is this window too short to spend a row on?" — measured, once per resize.
//
// Stage 5 of the AI-view rebuild. Spec §1 puts the short-view tier in a
// container query (`@container aiview (max-height: 620px)`), and stage 4 is the
// stage that establishes that container on the view root. Two things made a
// measured boolean the right answer for THIS stage rather than a rule that
// would lie dormant until then:
//
//   1. ⛔ `container-type: size` MAKES THE ELEMENT A CONTAINING BLOCK FOR
//      `position: fixed` DESCENDANTS. The view root holds the save-as-task
//      dialog and the screenshot lightbox, both `fixed inset-0`; the chat
//      column holds the lightbox. Declaring the container in this stage would
//      quietly shrink two modal backdrops to the column they happen to sit in —
//      a layout change in components this stage does not own, to serve a
//      20px composer decision. Stage 4 re-cuts those anyway.
//   2. The spec ALREADY names this mechanism as the supported fallback: "a
//      `ResizeObserver` … supplies the 'short view' boolean used to collapse the
//      settled plan by default", for the WebViews (macOS 12 WKWebView, the
//      oldest WebKitGTK) that have no `cq` units at all. Those WebViews are
//      shipping targets, so the boolean has to exist regardless — the container
//      query is the optimisation, not the source of truth.
//
// ⚠️ NO `ResizeObserver` MEANS NOT SHORT, NEVER "SHORT BY DEFAULT". jsdom has
// no ResizeObserver (the repo's precedent is ProfilePhoneCard: "jsdom measures
// 0 and keeps the default"), and a jsdom element measures 0x0 — which is ≤ 620
// and would make every view test render the short layout. An unmeasured view
// keeps the tall layout, which is the one the customer sees at every supported
// window size but the smallest.

import { useEffect, useState, type RefObject } from 'react';

/** Spec §1's short tier: the view's own box, 620px tall or less. */
export const SHORT_VIEW_MAX_PX = 620;

/**
 * Whether the observed element is at most `SHORT_VIEW_MAX_PX` tall.
 *
 * Returns false until something is actually measured, and false forever where
 * there is nothing to measure with. A height of exactly 0 is treated as "not
 * measured": an element that has not been laid out yet reports 0, and 0 ≤ 620
 * would flip the layout for one frame on every mount.
 */
export function useShortView(ref: RefObject<Element>): boolean {
  const [short, setShort] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (node === null || typeof ResizeObserver === 'undefined') return undefined;
    const read = (height: number): void => {
      setShort(height > 0 && height <= SHORT_VIEW_MAX_PX);
    };
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry === undefined) return;
      // `contentRect` is the content box — which is the box the spec's tiers are
      // written against, and the one a container query would measure.
      read(entry.contentRect.height);
    });
    // ⚠️ ORDER MATTERS, and only one way round is right. The synchronous read is
    // the first measurement, taken without waiting for a resize that may never
    // come; the observer's is the authoritative one, and in a real browser it
    // arrives after this effect returns. Observing FIRST let a callback that
    // fires synchronously be overwritten by the fallback read a line later —
    // which is how it is driven in a test, and how it failed there.
    read(node.getBoundingClientRect().height);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return short;
}
