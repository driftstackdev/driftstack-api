import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * P-25 — the freeze instrument must be mounted on EVERY main thread, not one.
 *
 * ⛔ This guard exists because the instrument was mounted on the wrong thread and
 * nothing noticed. The stall watch and flight recorder were wired into `App.tsx`
 * and worked correctly there — but `main.tsx` gives the simulator its own webview
 * and never imports `App`, so the diagnostic built for "the app freezes while I
 * browse" was watching the chrome window. A correct instrument pointed at a
 * thread that never fails reports a clean bill of health through every failure,
 * which is worse than no instrument: it is evidence of absence that is not.
 *
 * ⭐ The roots are ENUMERATED FROM `main.tsx`, never listed here. A guard that
 * names today's two windows goes blind the moment a third is added — which is
 * exactly the shape of the defect it is guarding against.
 */

const SRC = resolve(__dirname, '../../src');
const read = (rel: string): string => readFileSync(resolve(SRC, rel), 'utf8');

/** Every component handed to `createRoot(...).render(...)` in the bootstrap. */
function webviewRootComponents(mainTsx: string): string[] {
  // The bootstrap lazy-imports each root, so the dynamic import is the honest
  // enumeration point: `import('./views/SimulatorWindow')`, `import('./App')`.
  const names = new Set<string>();
  for (const m of mainTsx.matchAll(/import\(['"]\.\/((?:views\/)?[A-Za-z0-9_-]+)['"]\)/g)) {
    const path = m[1];
    if (path === undefined) continue;
    const base = path.split('/').pop();
    // Roots are PascalCase components; `./lib/...` helpers and providers that are
    // merely composed inside a root are not themselves roots.
    if (base !== undefined && /^[A-Z]/.test(base)) names.add(path);
  }
  return [...names];
}

/** Providers wrap a root but do not own a thread; only the rendered tree root does. */
const NOT_A_ROOT = new Set(['ConfirmProvider', 'DevLogPanel', 'RecordingsProvider']);

describe('every webview root mounts the P-25 freeze instrument', () => {
  const mainTsx = read('main.tsx');
  const roots = webviewRootComponents(mainTsx).filter(
    (p) => !NOT_A_ROOT.has(p.split('/').pop() ?? ''),
  );

  it('finds more than one root, or this guard is asserting nothing', () => {
    // ⛔ Non-vacuity. If the enumeration silently matched zero or one file the
    // per-root assertion below would pass while covering nothing — the same
    // failure mode as the bug.
    expect(roots.length).toBeGreaterThanOrEqual(2);
    expect(roots.some((p) => p.endsWith('App'))).toBe(true);
    expect(roots.some((p) => p.endsWith('SimulatorWindow'))).toBe(true);
  });

  it.each(roots)('%s starts the stall watch and a flight recorder', (rootPath) => {
    const source = read(`${rootPath}.tsx`);
    expect(
      source,
      `${rootPath} is a webview root — its main thread can freeze independently, so it must call startStallWatch()`,
    ).toContain('startStallWatch(');
    expect(
      source,
      `${rootPath} must call startFlightRecorder(): a terminal freeze never lets the stall watch fire, so the periodic census is the only record that survives it`,
    ).toContain('startFlightRecorder(');
  });

  it('the two roots record to DIFFERENT store files', () => {
    // A shared key lets the main window's clean-shutdown mark erase the
    // simulator's crash evidence — and a clean main window is the normal case
    // when the simulator is the half that froze.
    const app = read('App.tsx');
    const sim = read('views/SimulatorWindow.tsx');
    expect(app).toContain('FLIGHT_STORE_FILE');
    expect(sim).toContain('SIMULATOR_FLIGHT_STORE_FILE');
    const detector = read('lib/main-thread-stall-detector.ts');
    const main = /FLIGHT_STORE_FILE = '([^']+)'/.exec(detector)?.[1];
    const simulator = /SIMULATOR_FLIGHT_STORE_FILE = '([^']+)'/.exec(detector)?.[1];
    expect(main).toBeDefined();
    expect(simulator).toBeDefined();
    expect(simulator).not.toBe(main);
  });

  it('the main window reports the simulator record, since it is what reopens', () => {
    const app = read('App.tsx');
    expect(app).toContain('SIMULATOR_FLIGHT_STORE_FILE');
    // Both stores must be handed to reportPreviousRun, not just the main one.
    expect(app.match(/reportPreviousRun\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
