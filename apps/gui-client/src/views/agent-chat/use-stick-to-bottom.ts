// Keep the log at the bottom — WITHOUT ever yanking a customer who scrolled up.
//
// Until stage 2 the transcript did not auto-scroll at all: a running turn wrote
// steps off the bottom of the column and the customer had to chase them with
// the wheel. The naive fix is worse than the defect — scrolling to the bottom
// on every frame steals the page back from anyone reading an earlier step while
// the next one lands.
//
// So: remember whether the customer was AT the bottom before the update, and
// only then follow. `scroll` events fire when the customer scrolls; appending
// content does not move `scrollTop`, so the flag read inside the layout effect
// still describes where they were standing when the new content arrived.
//
// Cost per streamed frame: one `scrollHeight` read and one write. Nothing per
// animation frame, and no observer on a subtree that re-renders ten times a
// second.

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/** How close to the bottom still counts as "at the bottom". One line of a step
 *  row, so a customer who nudged the wheel by a few pixels is still followed. */
const STICK_SLACK_PX = 48;

/** A little air above the anchor, so its first line is not flush with the edge. */
const ANCHOR_GAP_PX = 12;

export interface StickOptions {
  /**
   * A selector for the element whose TOP should be brought into view instead of
   * the container's bottom, when the thing that just arrived is taller than the
   * column. The answer card: on a long turn, scrolling to the bottom lands on
   * the last step of the plan and pushes the answer — the thing that was asked
   * for — off the top of the screen.
   *
   * Null while a turn is still running: there the newest step IS the thing to
   * look at, and anchoring on a streamed answer would freeze the column.
   */
  anchorSelector?: string | null;
  /**
   * ⛔ OFF WHEN THERE IS NO TRANSCRIPT. "Follow the newest content" is only a
   * sentence about a log. With this on over the IDLE hero the column opened
   * scrolled to the bottom and the headline — the first thing a customer is
   * meant to read — started above the fold. A chat that HAS turns does want to
   * open at its newest, which is why this is the caller's call and not a
   * first-render skip.
   */
  enabled?: boolean;
}

export function useStickToBottom(
  ref: RefObject<HTMLElement | null>,
  deps: ReadonlyArray<unknown>,
  { anchorSelector = null, enabled = true }: StickOptions = {},
): void {
  const stuck = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    const onScroll = (): void => {
      stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLACK_PX;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
    };
  }, [ref]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || !enabled || !stuck.current) return;
    const bottom = el.scrollHeight - el.clientHeight;
    if (anchorSelector !== null) {
      const all = el.querySelectorAll(anchorSelector);
      const anchor = all.length > 0 ? all[all.length - 1] : undefined;
      if (anchor !== undefined) {
        const top =
          anchor.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
        // Only when going to the bottom would carry the anchor off the top.
        if (top < bottom) {
          el.scrollTop = Math.max(0, top - ANCHOR_GAP_PX);
          return;
        }
      }
    }
    el.scrollTop = bottom;
    // ⚠️ The dependency array is the CALLER'S. What "new content" means for this
    // log — a turn count, a streamed step count, the answer — is the caller's
    // statement, not something derivable here, and guessing wrong is either a
    // scroll that never happens or one that happens on every render. (No
    // eslint-disable: this repo does not load the react-hooks plugin, and a
    // disable for a rule that is not configured is itself an error.)
  }, deps);
}
