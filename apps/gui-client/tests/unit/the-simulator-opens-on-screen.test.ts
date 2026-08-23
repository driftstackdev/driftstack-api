// The simulator window opened mostly off-screen on Windows.
//
// Placement was two lines with no reference to the display: x = main.x +
// main.width + 16. "Beside the main window" is the right intent, but on a main
// window that is maximised — the normal case on Windows — main.x + main.width
// IS the right edge of the monitor, so the simulator was pushed entirely past
// it. Near-but-not-at the edge produced the reported "mostly outside of view".
//
// It is a borderless, decorationless window, so an off-screen one leaves no
// title bar on-screen to drag back. That is what makes this worse than a
// cosmetic misplacement.
//
// A 1440x900 monitor at origin, and a simulator 330 wide, are the numbers used
// throughout; MAIN_W 1000 leaves room on the right, and a maximised main window
// leaves none.

import { describe, expect, it } from 'vitest';
import { placeSimulatorWindow } from '../../src/lib/open-simulator';

const MONITOR = { x: 0, y: 0, width: 1440, height: 900 };
const SIM = { width: 330, height: 718 };
const GAP = 16;

const place = (main: { x: number; y: number; width: number }, monitor = MONITOR) =>
  placeSimulatorWindow({ main, monitor, sim: SIM, gap: GAP });

/** Fully within the monitor on both axes. */
function isFullyOnScreen(p: { x: number; y: number }, monitor = MONITOR): boolean {
  return (
    p.x >= monitor.x &&
    p.y >= monitor.y &&
    p.x + SIM.width <= monitor.x + monitor.width &&
    p.y + SIM.height <= monitor.y + monitor.height
  );
}

describe('the simulator window opens on screen', () => {
  it('prefers the right of the main window when there is room — the original intent, preserved', () => {
    const p = place({ x: 100, y: 60, width: 800 });
    expect(p).toEqual({ x: 100 + 800 + GAP, y: 60 });
    expect(isFullyOnScreen(p)).toBe(true);
  });

  it('CRITICAL a MAXIMISED main window no longer pushes the simulator off the screen — the reported Windows case', () => {
    // Maximised: x=0, width = full monitor. The old rule computed x = 1456 on a
    // 1440-wide monitor, i.e. the entire window past the right edge.
    const p = place({ x: 0, y: 0, width: 1440 });
    expect(p.x + SIM.width).toBeLessThanOrEqual(MONITOR.width);
    expect(isFullyOnScreen(p)).toBe(true);
  });

  it('CRITICAL a main window merely NEAR the right edge is caught too, not just the maximised extreme', () => {
    // The "mostly outside of view" report: enough room for a sliver, not for
    // the window. Old rule → x = 1216, leaving 106px of 330 on-screen.
    const p = place({ x: 400, y: 40, width: 800 });
    expect(isFullyOnScreen(p)).toBe(true);
    // It went to the LEFT of the main window rather than being jammed against
    // the right edge, because the left side had room.
    expect(p.x).toBe(400 - SIM.width - GAP);
  });

  it('falls back to a clamp when NEITHER side fits, and never to a negative coordinate', () => {
    // A wide main window centred with < 346px free on either side.
    const p = place({ x: 200, y: 30, width: 1000 });
    expect(isFullyOnScreen(p)).toBe(true);
    expect(p.x).toBeGreaterThanOrEqual(MONITOR.x);
  });

  it('keeps the window on-screen VERTICALLY, so a low main window cannot bury the drag handle', () => {
    // The old rule copied main.y verbatim: a main window near the bottom put
    // the simulator's top edge on-screen and everything below it off.
    const p = place({ x: 100, y: 860, width: 600 });
    expect(p.y + SIM.height).toBeLessThanOrEqual(MONITOR.height);
    expect(isFullyOnScreen(p)).toBe(true);
  });

  it('respects a monitor whose origin is not 0,0 — a second display left of or above the primary', () => {
    // Windows gives left-hand secondary monitors NEGATIVE origins. Clamping to
    // 0 instead of the monitor origin would throw the window onto the wrong
    // display.
    const secondary = { x: -1920, y: -200, width: 1920, height: 1080 };
    const p = place({ x: -100, y: -180, width: 1800 }, secondary);
    expect(p.x).toBeGreaterThanOrEqual(secondary.x);
    expect(p.y).toBeGreaterThanOrEqual(secondary.y);
    expect(p.x + SIM.width).toBeLessThanOrEqual(secondary.x + secondary.width);
    expect(p.y + SIM.height).toBeLessThanOrEqual(secondary.y + secondary.height);
  });

  it('a simulator taller or wider than the monitor still starts at the visible corner, not off it', () => {
    // Degenerate, but the clamp must not invert: `right - sim.width` is
    // negative here, and returning it would be worse than the bug being fixed.
    const tiny = { x: 0, y: 0, width: 300, height: 500 };
    const p = place({ x: 10, y: 10, width: 200 }, tiny);
    expect(p.x).toBeGreaterThanOrEqual(tiny.x);
    expect(p.y).toBeGreaterThanOrEqual(tiny.y);
  });
});
