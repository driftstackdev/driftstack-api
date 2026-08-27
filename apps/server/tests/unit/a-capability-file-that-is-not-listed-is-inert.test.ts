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
    expect(files.length).toBeGreaterThan(0);

    const identifiers = files.map(
      (f) => (JSON.parse(read(`capabilities/${f}`)) as { identifier: string }).identifier,
    );
    const named = new Set([...listed('tauri.conf.json'), ...listed('tauri.simulator.conf.json')]);

    // Named individually so a failure says WHICH capability is inert rather than
    // that some count did not match.
    for (const id of identifiers) {
      expect(
        named.has(id),
        `capability "${id}" exists on disk but no config lists it — it grants NOTHING`,
      ).toBe(true);
    }
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
