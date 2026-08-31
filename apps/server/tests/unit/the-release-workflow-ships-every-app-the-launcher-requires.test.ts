// The GUI release must ship every app the launcher requires — and today it
// does not. Recorded here as a KNOWN GAP so it cannot be forgotten between the
// self-repair arc and the packaging fix.
//
// 2026-08-30: an owner installed the desktop app from the release DMG, clicked
// Launch, and got "Install the Driftstack Simulator app, then try again". The
// launcher hard-requires a second bundle (`Driftstack Simulator.app`, built from
// `tauri.simulator.conf.json` by `npm run tauri:build:simulator`), and NOTHING in
// `.github/workflows/gui-release.yml` builds it — `tauri-action@v0` runs the
// default config only, so the DMG carries `Driftstack.app` alone. Only the
// dev-local `scripts/build-install-gui.sh` builds both. The live-view feature is
// unreachable on every clean customer install, and five guards that read the
// workflow pinned other properties of it.
//
// This file pins three facts and the gap between them. When the packaging fix
// lands (the workflow builds the simulator config, or the main bundle carries
// the simulator inside its Resources), the KNOWN-GAP arm goes red and must be
// retired in the same commit — that is the point of writing the gap down as an
// assertion instead of a message.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const WORKFLOW = resolve(REPO, '.github/workflows/gui-release.yml');
const GUI_PKG = resolve(REPO, 'apps/gui-client/package.json');
const LAUNCHER = resolve(REPO, 'apps/gui-client/src-tauri/src/lib.rs');
const DEV_SCRIPT = resolve(REPO, 'scripts/build-install-gui.sh');
/** The companion build script's name — the ONE hardcoded token; everything else derives from it. */
const SIM_SCRIPT = 'tauri:build:simulator';

function read(p: string): string {
  if (!existsSync(p))
    throw new Error(`subject is missing: ${p} — if it moved, update this pin; do not skip`);
  return readFileSync(p, 'utf8');
}

const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Derived, not typed: the companion's config path comes from its build script,
 * its product name from that config. A rename of the app, the config or the
 * script therefore moves the pin with it instead of silently detaching it.
 */
function companion(): { configPath: string; productName: string; identifier: string } {
  const pkg = JSON.parse(read(GUI_PKG)) as { scripts?: Record<string, string> };
  const script = pkg.scripts?.[SIM_SCRIPT];
  if (script === undefined)
    throw new Error(
      `apps/gui-client/package.json has no "${SIM_SCRIPT}" script — re-anchor this pin`,
    );
  const m = /--config\s+(\S+)/.exec(script);
  if (m?.[1] === undefined)
    throw new Error(`"${SIM_SCRIPT}" no longer names a --config — re-anchor this pin`);
  const configPath = m[1];
  const cfg = JSON.parse(read(resolve(REPO, 'apps/gui-client', configPath))) as {
    productName?: string;
    identifier?: string;
  };
  if (!cfg.productName || !cfg.identifier)
    throw new Error(`${configPath} has no productName/identifier`);
  return { configPath, productName: cfg.productName, identifier: cfg.identifier };
}

describe('the GUI release ships every app the launcher requires', () => {
  const sim = companion();

  it('CRITICAL the launcher still requires the companion bundle — otherwise this pin is stale and must be retired', () => {
    const rs = read(LAUNCHER);
    // The requirement, keyed by the PRODUCT NAME the config declares, in either
    // spelling the launcher has used: the literal /Applications path or the
    // SIMULATOR_INSTALL_PATH constant that names it.
    // The literal path, or a SIMULATOR_INSTALL_PATH constant whose VALUE names
    // this product — the constant's name alone would let it point anywhere.
    const constValue = /SIMULATOR_INSTALL_PATH\s*:\s*&str\s*=\s*"([^"]+)"/.exec(rs)?.[1];
    const literal = new RegExp(`/Applications/${escapeRe(sim.productName)}\\.app`);
    expect(
      literal.test(rs) || (constValue !== undefined && literal.test(constValue)),
      `lib.rs no longer requires /Applications/${sim.productName}.app (constant value: ${constValue ?? 'none'}) — retire or re-anchor this pin`,
    ).toBe(true);
    // And the refusal the customer sees when it is absent — the Rust error or
    // the front-end copy built from it — must still exist somewhere.
    const copy = read(resolve(REPO, 'apps/gui-client/src/lib/simulator-open-error.ts'));
    expect(`${rs}\n${copy}`).toMatch(/is not installed|Install the Driftstack Simulator app/);
  });

  it('CRITICAL the companion is a real second bundle with its own config and build script, and the dev installer builds both', () => {
    expect(sim.identifier).not.toBe('dev.driftstack'); // a distinct app, not the main one under another name
    expect(read(resolve(REPO, 'apps/gui-client', sim.configPath))).toContain(sim.productName);
    // The dev-local installer builds both — the only place that does today.
    expect(read(DEV_SCRIPT)).toContain(SIM_SCRIPT);
  });

  it('KNOWN GAP — the release workflow does NOT build the companion; a clean DMG install cannot open a live-view session. Retire this arm in the commit that ships it.', () => {
    const wf = read(WORKFLOW);
    // Non-vacuity: this is the real release workflow, with the real build step.
    expect(wf).toMatch(/tauri-apps\/tauri-action@v0/);
    expect(wf).toMatch(/gui-v\*/);
    const buildsCompanion = new RegExp(
      [escapeRe(sim.configPath), escapeRe(SIM_SCRIPT), escapeRe(sim.productName)].join('|'),
    );
    expect(
      buildsCompanion.test(wf),
      `gui-release.yml no longer references the companion build (${sim.productName} / ${sim.configPath}). ` +
        'The packaging gap has REOPENED: every customer who installs from the release DMG and clicks ' +
        `Launch is told to install "${sim.productName}", an app no release would distribute.`,
    ).toBe(true);

    // Building it is not shipping it. The self-repair (V-2147) installs from
    // <bundle>.app/Contents/Resources/<companion>, so the workflow must put it
    // THERE. A build whose output is never embedded leaves the customer exactly
    // where the gap left them.
    expect(
      wf,
      'the workflow builds the companion but never embeds it in the main bundle Resources — ' +
        'repair_simulator_install would have nothing to install from',
    ).toMatch(/bundle\.resources|Contents\/Resources/);

    // And the embed must be VERIFIED in CI, not assumed: Tauri copies the resource
    // itself, and a lossy copy of an .app yields a bundle that exists and cannot
    // launch — invisible to any check that only tests for presence.
    expect(
      wf,
      'nothing in the release verifies the nested companion is intact; a lossy copy would ' +
        'ship a Simulator that installs and refuses to launch',
    ).toMatch(/Verify the Simulator really shipped/);
  });
});
