// iOS-fidelity drift-guard: the floating Simulator window must cast a soft
// macOS drop shadow so the phone visibly lifts off the desktop instead of
// reading flat/pasted-on. The window is borderless + transparent, so the
// device-body CSS shadow blurs into the window's own opaque content area and
// is invisible at the window edges — the *window-level* `shadow: true` is the
// thing that actually renders the ambient lift. Pin it (and the borderless +
// transparent invariants the lift depends on) so a future config edit can't
// silently flip it back to a flat rectangle.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface SimulatorWindowConfig {
  label: string;
  decorations?: boolean;
  transparent?: boolean;
  shadow?: boolean;
}

interface SimulatorConfig {
  app?: { windows?: SimulatorWindowConfig[] };
}

const CONF_PATH = join(__dirname, '..', '..', 'src-tauri', 'tauri.simulator.conf.json');

function loadMainWindow(): SimulatorWindowConfig {
  const conf = JSON.parse(readFileSync(CONF_PATH, 'utf8')) as SimulatorConfig;
  const windows = conf.app?.windows ?? [];
  const main = windows.find((w) => w.label === 'main');
  if (!main) throw new Error('simulator conf has no "main" window');
  return main;
}

describe('simulator window drop shadow (iOS floating-app fidelity)', () => {
  it('the floating window casts a macOS drop shadow', () => {
    expect(loadMainWindow().shadow).toBe(true);
  });

  it('stays borderless + transparent so the window shadow is the visible lift', () => {
    const main = loadMainWindow();
    // If decorations came back, the OS title bar would render its own frame and
    // the device body would no longer fill the window edge-to-edge; if it lost
    // transparency, the rounded device corners would show window chrome behind
    // them. Both regressions make the `shadow: true` lift read wrong.
    expect(main.decorations).toBe(false);
    expect(main.transparent).toBe(true);
  });
});
