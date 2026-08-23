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
// NOT pinned, deliberately: nsis.headerImage / nsis.sidebarImage / dmg.background
// are real BMP and PNG artwork that does not exist yet. Asserting them now would
// be asserting a file into existence.

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
