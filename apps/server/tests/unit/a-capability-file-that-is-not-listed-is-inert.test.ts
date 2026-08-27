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
    // The security property that makes the above safe: macOS may check and nothing
    // else. If this file ever gains install or download, the reason it was excluded
    // from updater-windows-linux is gone and that has to be a deliberate decision.
    const cap = JSON.parse(read('capabilities/updater-check-macos.json')) as {
      permissions: string[];
      platforms: string[];
    };
    expect(cap.permissions).toEqual(['updater:allow-check']);
    expect(cap.platforms).toEqual(['macOS']);
  });
});
