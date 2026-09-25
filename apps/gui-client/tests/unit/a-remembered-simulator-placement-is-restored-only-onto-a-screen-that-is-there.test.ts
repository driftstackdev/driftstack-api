// Owner item 3 — the pure half of "reopen where the customer left it"
// (lib/simulator-window-placement.ts): which screen, where on it, how big, and
// what a fresh open does with nothing remembered. The rendered half is
// the-simulator-reopens-where-it-was-left-and-scales-to-the-screen.test.tsx.

import { describe, expect, it } from 'vitest';
import {
  COMFORTABLE_SCREEN_SHARE,
  comfortableSimulatorHeight,
  isSiblingSimulatorWindow,
  placementFrom,
  planPlacementRestore,
  type SimulatorWindowPlacement,
} from '../../src/lib/simulator-window-placement';
import { SCREEN_EDGE_MARGIN, SMALL_SCREEN_SHARE } from '../../src/lib/simulator-window-fit';

const RETINA = {
  name: 'Built-in Retina Display',
  position: { x: 0, y: 0 },
  size: { width: 3024, height: 1964 },
  workArea: { position: { x: 0, y: 74 }, size: { width: 3024, height: 1890 } },
  scaleFactor: 2,
};
const EXTERNAL = {
  name: 'DELL U2723QE',
  position: { x: 3024, y: 0 },
  size: { width: 2560, height: 1440 },
  workArea: { position: { x: 3024, y: 0 }, size: { width: 2560, height: 1440 } },
  scaleFactor: 1,
};

const onExternal: SimulatorWindowPlacement = {
  v: 1,
  x: 3400,
  y: 100,
  width: 520,
  height: 1100,
  monitor: { name: 'DELL U2723QE', x: 3024, y: 0, width: 2560, height: 1440 },
};

const widthFor = (h: number): number => Math.round(h * 0.47) + 44;

describe('planPlacementRestore', () => {
  it('restores onto the remembered screen at the remembered spot and size', () => {
    expect(
      planPlacementRestore({
        remembered: onExternal,
        monitors: [RETINA, EXTERNAL],
        windowWidthFor: widthFor,
      }),
    ).toEqual({ position: { x: 3400, y: 100 }, height: 1100, availHeight: 1440 });
  });

  it('nothing when that screen is not connected (a laptop off its dock)', () => {
    expect(
      planPlacementRestore({
        remembered: onExternal,
        monitors: [RETINA],
        windowWidthFor: widthFor,
      }),
    ).toBeNull();
  });

  it('nothing when the same-named screen now has a different size (it is not the same screen)', () => {
    const resized = { ...EXTERNAL, size: { width: 1920, height: 1080 } };
    expect(
      planPlacementRestore({
        remembered: onExternal,
        monitors: [RETINA, resized],
        windowWidthFor: widthFor,
      }),
    ).toBeNull();
  });

  it('keeps the whole window on the screen: a corner left hanging off is pulled back', () => {
    const plan = planPlacementRestore({
      remembered: { ...onExternal, x: 5500, y: 900 },
      monitors: [EXTERNAL],
      windowWidthFor: widthFor,
    });
    expect(plan).not.toBeNull();
    const outerW = widthFor(plan!.height);
    expect(plan!.position.x + outerW).toBeLessThanOrEqual(3024 + 2560);
    expect(plan!.position.y + plan!.height).toBeLessThanOrEqual(1440);
  });

  it('a remembered height taller than the screen is brought within it', () => {
    const plan = planPlacementRestore({
      remembered: { ...onExternal, height: 2000 },
      monitors: [EXTERNAL],
      windowWidthFor: widthFor,
    });
    expect(plan!.height).toBe(1440 - SCREEN_EDGE_MARGIN);
  });

  it('on a 2x screen the clamp works in physical px against a logical height', () => {
    const plan = planPlacementRestore({
      remembered: {
        ...onExternal,
        x: 2900,
        y: 1800,
        height: 800,
        monitor: { name: 'Built-in Retina Display', x: 0, y: 0, width: 3024, height: 1964 },
      },
      monitors: [RETINA],
      windowWidthFor: widthFor,
    });
    expect(plan!.availHeight).toBe(945); // 1890 physical / 2
    // 800 logical = 1600 physical tall; the work area ends at 74 + 1890.
    expect(plan!.position.y + 1600).toBeLessThanOrEqual(74 + 1890);
    expect(plan!.position.x + widthFor(800) * 2).toBeLessThanOrEqual(3024);
  });
});

describe('comfortableSimulatorHeight — a fresh phone fills the screen nicely', () => {
  it('a big screen gets a share of its height larger than a 1:1 phone', () => {
    expect(comfortableSimulatorHeight(1415)).toBe(Math.round(1415 * COMFORTABLE_SCREEN_SHARE));
    expect(comfortableSimulatorHeight(1415)!).toBeGreaterThan(960);
  });
  it("a small screen keeps T-12's share", () => {
    expect(comfortableSimulatorHeight(875)).toBe(Math.round(875 * SMALL_SCREEN_SHARE));
  });
  it('an unknown screen gives no answer', () => {
    expect(comfortableSimulatorHeight(0)).toBeNull();
  });
});

describe('placementFrom — a stored record is validated, never trusted', () => {
  it('round-trips a good record', () => {
    expect(placementFrom(JSON.parse(JSON.stringify(onExternal)))).toEqual(onExternal);
  });
  it.each([
    ['null', null],
    ['a wrong version', { ...onExternal, v: 2 }],
    ['a NaN position', { ...onExternal, x: Number.NaN }],
    ['a zero size', { ...onExternal, height: 0 }],
    ['no monitor', { ...onExternal, monitor: undefined }],
  ])('reads %s as nothing remembered', (_label, raw) => {
    expect(placementFrom(raw)).toBeNull();
  });
});

describe('isSiblingSimulatorWindow', () => {
  it('the separate app: `main` and `sim-*` are phones', () => {
    expect(isSiblingSimulatorWindow('sim-a', 'main')).toBe(true);
    expect(isSiblingSimulatorWindow('main', 'sim-b')).toBe(true);
    expect(isSiblingSimulatorWindow('sim-a', 'sim-a')).toBe(false);
  });
  it("the in-process window: only `simulator-*` — the app's own `main` is not a phone", () => {
    expect(isSiblingSimulatorWindow('simulator-a', 'main')).toBe(false);
    expect(isSiblingSimulatorWindow('simulator-a', 'simulator-b')).toBe(true);
  });
});
