// The installer was the first thing a customer saw, and it introduced nothing.
//
// `bundle` carried no publisher, no homepage, no copyright, and no
// descriptions — those fields are what Windows Programs-and-Features, the NSIS
// pages and every Linux package manager read, so the app installed itself as an
// unnamed thing from nobody. `windows` was an empty object and there was no dmg
// layout at all, so the drag-to-Applications gesture was two icons the default
// had stacked rather than an instruction.
//
// None of that needs artwork, which is why it is fixed here and pinned: the
// blank state is the easy state to fall back into, and nothing else in the
// suite reads this file's bundle block.
//
// The NSIS artwork IS now pinned, and pinned by SHAPE rather than by path,
// because the failure that matters is not a missing file — it is a present file
// in the wrong format. NSIS accepts only 24-bit BOTTOM-UP BMP, and `sips` on
// macOS emits 32-bit TOP-DOWN ("164 x -314 x 32"), which builds fine locally and
// fails the Windows job. So these arms read the actual BMP headers.
//
// The DMG background is pinned the same way: by header bytes and by GEOMETRY,
// because the failure that matters there is not a missing file either — it is a
// background whose artwork sits underneath the two icons the window exists to
// present.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const conf = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'apps/gui-client/src-tauri/tauri.conf.json'), 'utf8'),
) as {
  bundle: {
    publisher?: string;
    homepage?: string;
    copyright?: string;
    shortDescription?: string;
    longDescription?: string;
    windows?: { nsis?: Record<string, unknown> };
    macOS?: { dmg?: Record<string, unknown> };
  };
};
const b = conf.bundle;

describe('the installer introduces the product', () => {
  it('CRITICAL names its publisher and itself. These are the strings Programs-and-Features and the package managers read; blank is how the app installs as an unnamed thing from nobody.', () => {
    expect(b.publisher).toBe('Driftstack');
    expect(b.homepage).toBe('https://driftstack.dev');
    expect(b.copyright).toMatch(/Driftstack/);
    // A description long enough to actually say what it is — a one-word
    // placeholder would satisfy a mere presence check.
    expect((b.shortDescription ?? '').length).toBeGreaterThan(20);
    expect((b.longDescription ?? '').length).toBeGreaterThan(80);
  });

  it('installs per-user, so an UNSIGNED build does not also demand admin', () => {
    // The builds carry no OS code signature yet, so Windows already shows a
    // SmartScreen warning. Stacking a UAC elevation on top is the difference
    // between "unfamiliar app" and "unfamiliar app asking for admin rights".
    expect(b.windows?.nsis?.installMode).toBe('currentUser');
  });

  it('does not ask a question with one possible answer', () => {
    // A language selector offering exactly one language is a dialog that exists
    // only to be clicked through.
    expect(b.windows?.nsis?.languages).toEqual(['English']);
    expect(b.windows?.nsis?.displayLanguageSelector).toBe(false);
  });

  it('carries its own icon through the installer and uninstaller', () => {
    expect(b.windows?.nsis?.installerIcon).toBe('icons/icon.ico');
    expect(b.windows?.nsis?.uninstallerIcon).toBe('icons/icon.ico');
  });

  it('CRITICAL the NSIS artwork is 24-bit BOTTOM-UP BMP. A 32-bit or top-down file is what every macOS converter produces by default, passes every check that only asks whether the file exists, and fails the Windows build.', () => {
    const nsis = b.windows?.nsis ?? {};
    for (const key of ['headerImage', 'sidebarImage', 'uninstallerHeaderImage'] as const) {
      const rel = nsis[key] as string | undefined;
      expect(rel, `${key} is wired`).toBeDefined();
      const buf = readFileSync(resolve(REPO_ROOT, 'apps/gui-client/src-tauri', rel!));
      expect(buf.subarray(0, 2).toString('ascii'), `${key} is a BMP`).toBe('BM');
      // BITMAPINFOHEADER: height at 22 (signed — NEGATIVE means top-down, which
      // NSIS rejects), bit depth at 28.
      expect(buf.readInt32LE(22), `${key} height is positive (bottom-up)`).toBeGreaterThan(0);
      expect(buf.readUInt16LE(28), `${key} is 24-bit`).toBe(24);
    }
  });

  it('the artwork is the sizes NSIS actually draws — 150x57 header, 164x314 sidebar', () => {
    const nsis = b.windows?.nsis ?? {};
    const dims = (rel: string): [number, number] => {
      const buf = readFileSync(resolve(REPO_ROOT, 'apps/gui-client/src-tauri', rel));
      return [buf.readInt32LE(18), buf.readInt32LE(22)];
    };
    expect(dims(nsis.headerImage as string)).toEqual([150, 57]);
    expect(dims(nsis.sidebarImage as string)).toEqual([164, 314]);
  });

  it('CRITICAL the DMG background is a real PNG at exactly the window size. A mismatched image is scaled or tiled by the installer window, which is how a brand asset turns into visible distortion.', () => {
    const dmg = b.macOS?.dmg ?? {};
    const rel = dmg.background as string | undefined;
    expect(rel, 'dmg.background is wired').toBeDefined();
    const buf = readFileSync(resolve(REPO_ROOT, 'apps/gui-client/src-tauri', rel!));
    expect(buf.subarray(1, 4).toString('ascii'), 'is a PNG').toBe('PNG');
    // IHDR width/height live at byte 16 and 20, big-endian.
    const size = dmg.windowSize as { width: number; height: number } | undefined;
    expect(buf.readUInt32BE(16), 'width matches windowSize').toBe(size?.width);
    expect(buf.readUInt32BE(20), 'height matches windowSize').toBe(size?.height);
  });

  it('CRITICAL the background artwork clears the icon row. Tauri pins the app and Applications icons at a fixed y, so anything drawn across that band ends up BEHIND them — the one way a correct-looking background is still wrong.', () => {
    const dmg = b.macOS?.dmg ?? {};
    const app = dmg.appPosition as { x: number; y: number };
    const size = dmg.windowSize as { width: number; height: number };
    // The generator keeps the mark above the icon band; assert the band itself
    // is inside the window with room above it for artwork to occupy.
    const ICON_HALF = 64;
    expect(app.y - ICON_HALF, 'no room above the icons for the mark').toBeGreaterThan(24);
    expect(app.y + ICON_HALF, 'the icon row falls outside the window').toBeLessThan(size.height);
  });

  it('lays the DMG out so drag-to-Applications reads as an instruction', () => {
    const dmg = b.macOS?.dmg;
    expect(dmg).toBeDefined();
    // Side by side on one row: the gesture is only legible when the app and the
    // Applications folder are placed as a pair at the same height.
    const app = dmg?.appPosition as { x: number; y: number } | undefined;
    const folder = dmg?.applicationFolderPosition as { x: number; y: number } | undefined;
    expect(app?.y).toBe(folder?.y);
    expect(folder?.x ?? 0).toBeGreaterThan(app?.x ?? 0);
    // And both inside the window they are drawn in.
    const size = dmg?.windowSize as { width: number; height: number } | undefined;
    expect(folder?.x ?? 0).toBeLessThan(size?.width ?? 0);
    expect(app?.y ?? 0).toBeLessThan(size?.height ?? 0);
  });
});
