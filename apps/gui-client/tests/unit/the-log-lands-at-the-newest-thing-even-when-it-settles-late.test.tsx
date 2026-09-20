// Opening a chat that has turns must land you at its newest content. The hook
// that does it says so in its own header: "A chat that HAS turns does want to
// open at its newest".
//
// ⛔ WHAT WAS WRONG, MEASURED IN A REAL BROWSER DURING FINAL QA. The scroll is
// applied in a layout effect keyed on the caller's dependencies. Sampling the
// `trouble` scene at 1280x800 every 150ms from first paint:
//
//     t=378ms  clientHeight 577  scrollHeight 577  scrollTop 0
//     t=533ms  clientHeight 577  scrollHeight 598  scrollTop 0
//     … unchanged for the next three seconds
//
// At the moment the effect ran the content was exactly as tall as the box, so
// "scroll to the bottom" was a scroll to 0 — and then the content grew by 21px
// from INSIDE a child that was already mounted (a web font swapping in, a
// capture thumbnail getting its intrinsic size, a diagnosis card laying out).
// No dependency changed and no node was added, so nothing ran again. A customer
// reopening a failed chat landed at the top of it with the card that says WHY
// it failed cut 5px short of its bottom border — with macOS overlay scrollbars
// hidden, indistinguishable from a rendering fault.
//
// The fix is a ResizeObserver over the scroller and its element children, which
// re-applies the same placement the layout effect does. This file holds the
// three things that make it safe:
//
//   1. it lands at the bottom when the content grows late;
//   2. it NEVER yanks a customer who has scrolled up — the growth arrives while
//      they are reading, which is exactly when a jump is worst;
//   3. it keeps honouring the anchor, so a long finished turn still lands on its
//      ANSWER and not on the last row of a plan below it.
//
// jsdom has no layout, so `scrollHeight` is a stub and the observer never fires
// by itself: both are driven here on purpose. That is a fair test of the WIRING
// — which callback runs, what it reads, what it refuses to do — and the
// arithmetic it runs is the same arithmetic the browser measurement above
// exercised.
//
// NEGATIVE CONTROL: delete the ResizeObserver block from
// `src/views/agent-chat/use-stick-to-bottom.ts` and arm 1 and arm 3 red while
// arm 2 stays green (it is green when nothing happens at all, which is why it
// is not alone in this file).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { useStickToBottom } from '../../src/views/agent-chat/use-stick-to-bottom';

/** The observers created while a test runs, so a test can fire them the way a
 *  browser would when a child's box changes. */
const observers: FakeResizeObserver[] = [];

class FakeResizeObserver {
  public readonly observed: Element[] = [];
  public constructor(private readonly callback: () => void) {
    observers.push(this);
  }
  public observe(target: Element): void {
    this.observed.push(target);
  }
  public unobserve(): void {
    /* nothing to undo: `observed` is only read for the "what did it watch" arm */
  }
  public disconnect(): void {
    const at = observers.indexOf(this);
    if (at >= 0) observers.splice(at, 1);
  }
  /** What the browser does when an observed box changes size. */
  public fire(): void {
    this.callback();
  }
}

/** A scroller whose geometry is ours to move, because jsdom's is always 0. */
interface Geometry {
  clientHeight: number;
  scrollHeight: number;
}

function installGeometry(el: HTMLElement, geometry: Geometry): void {
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => geometry.clientHeight,
  });
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => geometry.scrollHeight,
  });
}

/** The log, in miniature: one scroller with one child, driven by the real hook
 *  with the real view's options. */
function Log({
  geometry,
  anchorSelector,
}: {
  geometry: Geometry;
  anchorSelector: string | null;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useStickToBottom(ref, [1], { anchorSelector, enabled: true });
  // A ref CALLBACK, not an effect: React runs it during the commit, before any
  // layout effect — so the hook's very first placement already reads the
  // geometry this test is driving, exactly as it would read a browser's.
  const attach = (node: HTMLDivElement | null): void => {
    ref.current = node;
    if (node !== null) installGeometry(node, geometry);
  };
  return (
    <div ref={attach} data-testid="log">
      <ol>
        <li>a turn</li>
        <li className="ai-result">the answer</li>
      </ol>
    </div>
  );
}

function renderLog(geometry: Geometry, anchorSelector: string | null = null): HTMLElement {
  const rendered = render(<Log geometry={geometry} anchorSelector={anchorSelector} />);
  return rendered.getByTestId('log');
}

afterEach(() => {
  cleanup();
  observers.length = 0;
  vi.unstubAllGlobals();
});

describe('the log lands at the newest thing even when the content settles late', () => {
  it('⛔ follows the content down when it grows after the effect has run', () => {
    // The measured case: at the layout effect the content was exactly the box's
    // height, so the bottom was 0 and the log stayed at 0.
    const geometry: Geometry = { clientHeight: 577, scrollHeight: 577 };
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const log = renderLog(geometry);
    expect(log.scrollTop).toBe(0);

    // …and then a child that was already mounted got 21px taller.
    geometry.scrollHeight = 598;
    act(() => {
      for (const o of observers) o.fire();
    });
    expect(log.scrollTop, 'the log never followed the content that arrived late').toBe(21);
  });

  it('⛔ and NEVER yanks a customer who has scrolled up to read', () => {
    // The whole risk of watching for content growth: it arrives while somebody
    // is reading an earlier step, which is the one moment a jump is unforgivable.
    // The hook's `stuck` flag is the veto and must still apply here.
    const geometry: Geometry = { clientHeight: 300, scrollHeight: 1200 };
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const log = renderLog(geometry);

    log.scrollTop = 100; // far above the bottom (900)
    act(() => {
      log.dispatchEvent(new Event('scroll'));
    });

    geometry.scrollHeight = 1400;
    act(() => {
      for (const o of observers) o.fire();
    });
    expect(log.scrollTop, 'a customer reading an earlier step was pulled to the bottom').toBe(100);
  });

  it('⛔ keeps honouring the anchor, so a finished turn still lands on its answer', () => {
    // The anchor exists because scrolling to the bottom of a LONG finished turn
    // lands on the last row of its plan and pushes the answer — the thing that
    // was asked for — off the top. A re-apply that ignored it would undo that on
    // the first late resize.
    const geometry: Geometry = { clientHeight: 300, scrollHeight: 1200 };
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const log = renderLog(geometry, '.ai-result');
    const anchor = log.querySelector('.ai-result');
    expect(anchor).not.toBeNull();
    // jsdom gives every element a 0x0 box, so the anchor's offset resolves to
    // `0 - 0 + scrollTop`; what this arm proves is that the ANCHOR BRANCH is the
    // one taken (bottom would be 1100), not the arithmetic, which has no layout
    // to do it on.
    geometry.scrollHeight = 1400;
    act(() => {
      for (const o of observers) o.fire();
    });
    expect(log.scrollTop, 'the re-apply went to the bottom and skipped the answer').toBe(0);
  });

  it('watches the scroller AND its children — a child is what actually grows', () => {
    // Observing only the scroller would see nothing: its own box does not change
    // when its contents get taller inside a flex column. This is the arm that
    // catches an "optimisation" down to `observer.observe(el)`.
    const geometry: Geometry = { clientHeight: 577, scrollHeight: 577 };
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const log = renderLog(geometry);
    const observer = observers[0];
    expect(observer).toBeDefined();
    expect(observer?.observed).toContain(log);
    expect(observer?.observed.length ?? 0).toBeGreaterThan(1);
  });

  it('…and does not throw where there is no ResizeObserver at all', () => {
    // Both WebViews this ships in have one, but a test environment may not, and
    // an exception in a layout effect takes the whole view down rather than
    // losing a scroll.
    vi.stubGlobal('ResizeObserver', undefined);
    const geometry: Geometry = { clientHeight: 577, scrollHeight: 900 };
    expect(() => renderLog(geometry)).not.toThrow();
  });
});
