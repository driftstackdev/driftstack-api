// A capability file that exists but is not listed is silently INERT.
//
// ⛔ Shipped in gui-v0.1.5 and caught after the release. `updater-check-macos`
// was written, valid, compiled without complaint, and appeared in the generated
// `gen/schemas/capabilities.json` — and granted nothing, because
// `tauri.conf.json`'s `app.security.capabilities` list was non-empty and did not
// name it. Tauri's own words: "By default (not set or empty list), all capability
// files from ./capabilities/ are included, by setting values in this entry, you
// have fine grained control over which capabilities are included."
//
// ⚠️ The reason it survived review is the dangerous part: EVERY check passed.
// The build succeeded (an invalid identifier would have failed it), the file
// parsed, and the generated schema listed it — because that artifact enumerates
// what was DISCOVERED, not what was APPLIED. Verifying the resolved artifact is
// the right instinct and it still failed here, because there are two resolved
// artifacts and only one of them answers this question.
//
// There is no runtime symptom either. An ungranted permission does not warn; the
// IPC call simply rejects, and the caller in this codebase treats a rejected
// updater check as "offline" and resolves to null. Silence again.
//
// So this arm exists because nothing else in the pipeline can see it: every
// capability FILE must be named by exactly one of the two configs that ship.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TAURI = resolve(__dirname, '../../../../apps/gui-client/src-tauri');
const read = (p: string): string => readFileSync(resolve(TAURI, p), 'utf8');
const listed = (conf: string): string[] =>
  (JSON.parse(read(conf)) as { app?: { security?: { capabilities?: string[] } } }).app?.security
    ?.capabilities ?? [];

describe('a capability file that is not listed is inert', () => {
  it('CRITICAL every capability file on disk is named by one of the two shipping configs', () => {
    const files = readdirSync(resolve(TAURI, 'capabilities')).filter((f) => f.endsWith('.json'));
    // ⛔ NON-VACUITY FLOOR. This guard enumerates its OWN inputs, so it goes blind in
    // exactly the way the defect it guards did: rename the directory, nest it, or break
    // the extension filter, and the loop below runs zero times while the arm reports
    // GREEN — indistinguishable from "every capability is listed". A bare `> 0` is not
    // enough either; it survives a scan that finds one stray file.
    expect(
      files.length,
      'capability scan found almost nothing — the directory moved or the filter broke',
    ).toBeGreaterThanOrEqual(5);

    const identifiers = files.map(
      (f) => (JSON.parse(read(`capabilities/${f}`)) as { identifier: string }).identifier,
    );
    const named = new Set([...listed('tauri.conf.json'), ...listed('tauri.simulator.conf.json')]);

    // Named individually so a failure says WHICH capability is inert rather than
    // that some count did not match.
    let checked = 0;
    for (const id of identifiers) {
      expect(
        named.has(id),
        `capability "${id}" exists on disk but no config lists it — it grants NOTHING`,
      ).toBe(true);
      checked += 1;
    }
    // The loop having RUN is a separate fact from the files having been found: an
    // identifier that failed to parse would shrink `identifiers` without shrinking
    // `files`. Assert the comparison happened once per file.
    expect(checked, 'no identifier was compared — the assertions above are vacuous').toBe(
      files.length,
    );
    // ⭐ THE LOAD-BEARING FLOOR, and it is an EQUALITY rather than a containment on
    // purpose: a non-empty expected value IS a non-vacuity floor, because an empty or
    // narrowed scan cannot equal it. `arrayContaining` was the weaker form — it passes
    // over a superset, so a scan that quietly grew, or one that found these two plus
    // nothing else, both slip through.
    //
    // The cost is deliberate: adding a capability file REDDENS this arm until the
    // roster is updated. That is the point. A capability arriving without anyone
    // deciding whether it should be granted is exactly how 0.1.5 shipped one inert.
    expect([...identifiers].sort()).toEqual([
      'default',
      'simulator',
      'simulator-app',
      'updater-check-macos',
      'updater-windows-linux',
    ]);
  });

  it('the macOS updater check is listed, since an unlisted grant is why 0.1.5 shipped without its fix', () => {
    expect(listed('tauri.conf.json')).toContain('updater-check-macos');
    // ⛔ REPOINTED 2026-09-01, and this guard did exactly its job first. It said
    // "if this file ever gains install or download, the reason it was excluded
    // from updater-windows-linux is gone and that has to be a deliberate
    // decision" — it went red, and forced the decision to be argued here.
    //
    // The decision: macOS now carries the same grant as Windows/Linux. The reason
    // it was withheld — that a minisign-only artifact must not replace an
    // OS-SIGNED bundle and change its code requirement — described a bundle that
    // does not exist. Measured on the shipped app: codesign reports
    // Signature=adhoc, TeamIdentifier=not set, and spctl rejects it with "no
    // usable signature". The guard protected a property the build never had,
    // while costing every Mac customer a manual download.
    //
    // ⚠️ So the pin moves from the PERMISSION to the JUSTIFICATION: the grant may
    // be whatever the platform needs, but the file must still carry the
    // measurement and the condition under which it must be re-argued. A future
    // reader must not find a widened capability with no stated reason.
    const cap = JSON.parse(read('capabilities/updater-check-macos.json')) as {
      permissions: string[];
      platforms: string[];
      description: string;
    };
    expect(cap.permissions).toEqual(['updater:default', 'process:default']);
    expect(cap.platforms).toEqual(['macOS']);
    // The measurement that retired the old reason, and the trigger to revisit.
    expect(cap.description).toMatch(/adhoc/i);
    expect(cap.description).toMatch(/spctl/i);
    expect(cap.description).toMatch(/DEVELOPER ID/i);
    expect(cap.platforms).toEqual(['macOS']);
  });
});

describe('the two simulator windows are granted what their code actually calls (V-2165)', () => {
  /** The same index.html runs in BOTH simulator windows; only the CAPABILITY differs. */
  const SIM_IN_PROCESS = 'capabilities/simulator.json'; // windows: simulator-* (Windows/Linux)
  const SIM_MACOS_APP = 'capabilities/simulator-app.json'; // windows: main, sim-* (the separate app)

  const permsOf = (file: string): string[] =>
    (
      JSON.parse(read(file)) as { permissions: (string | { identifier: string })[] }
    ).permissions.map((x) => (typeof x === 'string' ? x : x.identifier));

  /**
   * The ONLY permissions the macOS app window may hold that the in-process window
   * does not, each with why. Anything else is drift — which is exactly how the
   * in-process window ended up without `core:resources:default` while
   * `FileHandle.close()` routes through `plugin:resources|close`.
   */
  const MACOS_ONLY: Readonly<Record<string, string>> = {
    'core:default':
      'the separate app owns its own top-level window (label "main"), so it needs the umbrella set the host app has; the in-process window is a CHILD of a main window that already holds it',
    'core:app:default':
      'app-level lifecycle (getName/getVersion/show/hide) belongs to the app that IS the process; the in-process window is not that process',
  };

  it('CRITICAL neither simulator window is missing a permission its own code invokes. An ungranted permission does not warn — the IPC call just rejects, and download.ts turns that into `return false`', () => {
    // Derived, not pinned: read the fs functions the simulator-reachable modules
    // actually import and require the matching `fs:allow-*` in BOTH capabilities.
    // `open` was imported by download.ts and granted NOWHERE, so the Simulator's
    // file download returned false on every platform while every test stayed green
    // (the suites mock @tauri-apps/plugin-fs, so the mock answers, not the grant).
    const GUI = resolve(__dirname, '../../../../apps/gui-client/src');
    // Modules the simulator window demonstrably executes: SimulatorWindow itself and
    // what it imports for downloads, recordings, logs and its crash marker.
    const SIM_MODULES = [
      'views/SimulatorWindow.tsx',
      'lib/download.ts',
      'lib/recordings-store.ts',
      'lib/log-buffer.ts',
      'lib/simulator-crash-marker.ts',
    ];
    // Imported names that are NOT commands (enums/types carry no permission).
    const NOT_A_COMMAND = new Set(['BaseDirectory', 'type']);
    const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

    const required = new Set<string>();
    let scanned = 0;
    for (const rel of SIM_MODULES) {
      const src = readFileSync(resolve(GUI, rel), 'utf8');
      scanned += 1;
      for (const m of src.matchAll(
        /(?:import|const)\s*\{([^}]*)\}\s*(?:=\s*await\s+import\(|from\s+)'@tauri-apps\/plugin-fs'/g,
      )) {
        for (const raw of (m[1] ?? '').split(',')) {
          const name =
            raw
              .trim()
              .split(/\s+as\s+/)[0]
              ?.trim() ?? '';
          if (name === '' || NOT_A_COMMAND.has(name)) continue;
          required.add(`fs:allow-${kebab(name)}`);
        }
      }
    }
    // Non-vacuity: this arm enumerates its own inputs, so a moved file or a broken
    // regex would leave `required` empty and report GREEN — the same blindness as
    // the defect above it.
    expect(scanned, 'simulator module scan read nothing').toBe(SIM_MODULES.length);
    expect(
      [...required],
      'no fs command was extracted — the import shape changed and this arm went blind',
    ).toContain('fs:allow-open');

    for (const file of [SIM_IN_PROCESS, SIM_MACOS_APP]) {
      const granted = new Set(permsOf(file));
      const missing = [...required].filter((p) => !granted.has(p)).sort();
      expect(missing, `${file} does not grant fs commands its own code calls`).toEqual([]);
    }
  });

  it('CRITICAL the two windows do not drift apart silently: every difference is stated', () => {
    const inProcess = new Set(permsOf(SIM_IN_PROCESS));
    const macApp = new Set(permsOf(SIM_MACOS_APP));

    const macOnly = [...macApp].filter((p) => !inProcess.has(p)).sort();
    const inProcessOnly = [...inProcess].filter((p) => !macApp.has(p)).sort();

    expect(
      macOnly,
      'the macOS window holds a permission the in-process window lacks and MACOS_ONLY does not explain — either grant it there too or say why not',
    ).toEqual(Object.keys(MACOS_ONLY).sort());
    expect(
      inProcessOnly,
      'the in-process window holds a permission the macOS window lacks — the same code runs in both',
    ).toEqual([]);
  });
});
