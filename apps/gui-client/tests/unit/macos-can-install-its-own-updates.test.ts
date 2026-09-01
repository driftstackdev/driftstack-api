import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Owner, item 1 of the 2026-08-31 batch: "Auto update on Mac, I don't know if
 * this is purpose... it takes me to GitHub page instead of self updating."
 *
 * It was on purpose. macOS was granted `updater:allow-check` and nothing else,
 * so `canSelfInstall()` returned false and the banner offered the releases page.
 * The stated reason was that a minisign-only artifact must not replace the
 * "stable OS-signed bundle" and change its code requirement.
 *
 * ⛔ MEASURED ON THE SHIPPED APP, that premise is false: `codesign -dv` reports
 * `Signature=adhoc`, `flags=(adhoc,linker-signed)`, `TeamIdentifier=not set`,
 * and `spctl -a` rejects it with "no usable signature". There is no OS-signed
 * bundle and no code requirement to protect — the guard cost every Mac customer
 * a manual download to defend a property this build has never had. The owner's
 * install was two releases behind as a direct result.
 *
 * What DOES protect the artifact is minisign, which is unchanged: the updater
 * verifies the .app.tar.gz against the pubkey compiled into the binary before
 * replacing anything.
 */

const TAURI = resolve(__dirname, '../../src-tauri');
const read = (p: string): string => readFileSync(resolve(TAURI, p), 'utf8');

describe('macOS can install its own updates', () => {
  it('the macOS capability grants install and relaunch, not check alone', () => {
    const cap = JSON.parse(read('capabilities/updater-check-macos.json')) as {
      permissions: string[];
      platforms: string[];
    };
    expect(cap.platforms).toEqual(['macOS']);
    expect(cap.permissions).toContain('updater:default');
    // `process:default` is what lets the app relaunch into the new bundle. Without
    // it the download succeeds and the customer is left on the old version with no
    // indication why — worse than the download-only banner it replaced.
    expect(cap.permissions).toContain('process:default');
  });

  it('the client no longer refuses to self-install on macOS', () => {
    const src = readFileSync(resolve(__dirname, '../../src/lib/updater.ts'), 'utf8');
    // The old implementation was `return !mac`, sniffing navigator.platform.
    expect(src).not.toMatch(/return\s+!mac\s*;/);
    expect(src).not.toMatch(/navigator\.platform\.startsWith\('Mac'\)/);
  });

  it('⛔ keeps the download-only path alive for the platform that needs it next', () => {
    // Dead code today — no platform sets it. Kept because it becomes live the
    // moment a platform is granted allow-check WITHOUT default, and Developer ID
    // signing is exactly when that trade-off gets re-argued. Deleting it would
    // hand the next such platform a button that always fails.
    const src = readFileSync(resolve(__dirname, '../../src/lib/updater.ts'), 'utf8');
    expect(src).toContain('downloadOnly');
    expect(src).toContain('canSelfInstall');
  });

  it('records the measurement that retired the old justification', () => {
    // A widened capability with no stated reason is the thing a future reader
    // cannot evaluate. The file must carry both the evidence and the trigger to
    // revisit it.
    const desc = (
      JSON.parse(read('capabilities/updater-check-macos.json')) as { description: string }
    ).description;
    expect(desc).toMatch(/adhoc/i);
    expect(desc).toMatch(/spctl/i);
    expect(desc).toMatch(/minisign/i);
    expect(desc).toMatch(/DEVELOPER ID/i);
  });
});
