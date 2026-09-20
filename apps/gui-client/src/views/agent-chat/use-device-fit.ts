// How wide the iPhone may be, in the box it is standing in.
//
// Stage 4 of the AI-view rebuild (spec §1 "Phone sizing", §3.4). The bezel must
// never letterboxe the stream: the device is as wide as the WIDTH allows, or as
// wide as the HEIGHT allows at the iPhone's own proportions, whichever is
// smaller. In CSS that is one line on `.ai-fit`'s child:
//
//   --w: var(--ai-phone-w, min(calc(100cqw - var(--ai-fit-gx)),
//                              calc((100cqh - var(--ai-fit-gy)) / 2.0943)));
//
// 2.0943 = 0.932 × 874/402 + 0.068 — the bezel's padding is 3.4 % of `--w` per
// side, so the OUTER height of the device is 2.0943 × its outer width.
//
// ⛔ WHY THE JS ARM EXISTS. `100cqh` needs container queries with a SIZE
// container, and the spec names two shipping WebViews without `cq` units at all
// (macOS 12 WKWebView, the oldest WebKitGTK). There the `min()` resolves to
// nothing usable and the phone would collapse. So: when the runtime cannot do
// `cq` units, a ResizeObserver writes `--ai-phone-w` and the `var()` fallback
// never runs. Where `cq` units DO work nothing is written and the browser does
// the arithmetic itself — no style write per resize frame on the path every
// supported desktop actually takes.
//
// The gutters are read from the element rather than repeated here: the narrow
// tier tightens them (spec §1) and a second copy of those numbers in TypeScript
// is a second thing to keep in step with the stylesheet.

import { useEffect, type RefObject } from 'react';

/** Outer height ÷ outer width of the framed device. */
export const DEVICE_ASPECT = 2.0943;

/** Does this runtime understand container-query units? Wrapped because `CSS`
 *  and `CSS.supports` are both absent in jsdom, and a throw in a layout effect
 *  would take the whole view down. */
export function supportsContainerUnits(): boolean {
  try {
    return typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
      ? CSS.supports('width', '1cqw')
      : false;
  } catch {
    return false;
  }
}

/**
 * The device's outer width inside a `fitW × fitH` box, given the gutters.
 *
 * Pure, so the arithmetic the two WebViews depend on is pinned without a
 * browser. Never negative: a box too small for any phone yields 0 and the
 * device simply has no width, rather than a negative one that paints inside
 * out.
 */
export function deviceWidthFor(fitW: number, fitH: number, gx: number, gy: number): number {
  const byWidth = fitW - gx;
  const byHeight = (fitH - gy) / DEVICE_ASPECT;
  return Math.max(0, Math.min(byWidth, byHeight));
}

/** The gutter custom properties `.ai-fit` carries, in px. Absent or unparsable
 *  → the default tier's numbers, which is what the stylesheet declares. */
function guttersOf(node: Element): { gx: number; gy: number } {
  const style = getComputedStyle(node);
  const num = (name: string, fallback: number): number => {
    const parsed = Number.parseFloat(style.getPropertyValue(name));
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return { gx: num('--ai-fit-gx', 36), gy: num('--ai-fit-gy', 8) };
}

/**
 * Keep `--ai-phone-w` correct on `ref` — but ONLY where the browser cannot do
 * it in CSS. Does nothing (and observes nothing) otherwise.
 */
export function useDeviceFit(ref: RefObject<HTMLElement>): void {
  useEffect(() => {
    const node = ref.current;
    if (node === null) return undefined;
    // The supported path: the stylesheet's `min(100cqw…, 100cqh…)` is the
    // answer and JS must not second-guess it a frame later.
    if (supportsContainerUnits()) return undefined;
    if (typeof ResizeObserver === 'undefined') return undefined;
    const write = (width: number, height: number): void => {
      const { gx, gy } = guttersOf(node);
      node.style.setProperty('--ai-phone-w', `${String(deviceWidthFor(width, height, gx, gy))}px`);
    };
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry === undefined) return;
      write(entry.contentRect.width, entry.contentRect.height);
    });
    const box = node.getBoundingClientRect();
    write(box.width, box.height);
    observer.observe(node);
    return () => {
      observer.disconnect();
      node.style.removeProperty('--ai-phone-w');
    };
  }, [ref]);
}
