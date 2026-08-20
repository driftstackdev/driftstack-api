// A Tauri capability is a permission ALLOWLIST keyed by window label. Get it wrong and
// nothing crashes — the plugin call is denied, the feature silently does nothing, and
// the window looks fine.
//
// That is what the in-process simulator window was about to ship as. `simulator.json`
// scopes label `simulator-*` and, until this commit, granted nine core windowing
// permissions with an explicit "Deliberately minimal — no fs/shell/store; the device
// window only needs windowing + webview + events."
//
// That sentence stopped being true and nothing noticed. `SimulatorWindow` gained
// `persistBaseUrl` (2026-06-23) — `@tauri-apps/plugin-store` — precisely because the
// simulator otherwise falls back to `localhost:3000` and EVERY control call fails
// (founder-hit #48). Under a capability with no `store` permission that call is denied,
// so the window would open, show video, and be unable to change mode, end the session,
// or read cookies: a phone-shaped picture.
//
// It did not bite because the in-process window had been deleted (0b1fe535f) and only
// the SEPARATE app's `sim-*` windows were reachable — and `simulator-app.json` grants
// `sim-*` the store and fs it needs. Restoring the in-process window for Windows and
// Linux made `simulator-*` live again, against a stale allowlist.
//
// ── what this file asserts, and why it is derived ─────────────────────────────
//
// The requirement is DERIVED from the source, not restated: SimulatorWindow's import
// graph is scanned for the Tauri plugins it actually uses, and every plugin found must
// be granted by the capability that governs the windows it renders in. A hand-listed
// "simulator needs store" would be one more copy of a fact, and copies are what rot.
//
// ⚠️ This cannot prove Windows works. It proves the window is not denied the plugins
// its own code calls. Whether WebView2 renders LiveKit video is a real-device question.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const GUI = resolve(REPO, 'apps/gui-client');
const CAPS = resolve(GUI, 'src-tauri/capabilities');

const read = (p: string): string => readFileSync(p, 'utf8');

interface Capability {
  identifier: string;
  description?: string;
  windows?: string[];
  permissions: (string | { identifier: string })[];
}

function capabilities(): Capability[] {
  return readdirSync(CAPS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(read(resolve(CAPS, f))) as Capability);
}

const permIds = (c: Capability): string[] =>
  c.permissions.map((p) => (typeof p === 'string' ? p : p.identifier));

/** Tauri plugin prefixes a capability can grant, keyed by the npm package that needs it. */
const PLUGIN_BY_PACKAGE: ReadonlyArray<{ pkg: string; prefix: string }> = [
  { pkg: '@tauri-apps/plugin-store', prefix: 'store:' },
  { pkg: '@tauri-apps/plugin-fs', prefix: 'fs:' },
  { pkg: '@tauri-apps/plugin-shell', prefix: 'shell:' },
  { pkg: '@tauri-apps/plugin-updater', prefix: 'updater:' },
];

/**
 * Local modules SimulatorWindow imports, one level deep, plus itself.
 *
 * One level is enough for the property under test and is stated rather than sold as
 * exhaustive: `persistBaseUrl` lives in `lib/settings`, a direct import. A full
 * transitive walk would be stricter but would also drag in the whole app graph and
 * turn this into an assertion about everything.
 */
function simulatorSources(): string[] {
  const entry = resolve(GUI, 'src/views/SimulatorWindow.tsx');
  const src = read(entry);
  const out = [entry];
  for (const m of src.matchAll(/from '(\.\.?\/[^']+)'/g)) {
    const rel = m[1];
    if (rel === undefined) continue;
    for (const ext of ['.ts', '.tsx']) {
      try {
        const p = resolve(dirname(entry), rel + ext);
        read(p);
        out.push(p);
        break;
      } catch {
        /* not this extension */
      }
    }
  }
  return out;
}

describe('a window that can be opened must be able to work', () => {
  it('CRITICAL the scan really finds SimulatorWindow and its imports. Every assertion below is driven off this list, so an empty or one-file result would make them all pass having checked nothing — the exact vacuity that let a stale allowlist survive.', () => {
    const files = simulatorSources();
    expect(files.length, 'the simulator import scan collapsed').toBeGreaterThan(10);
    expect(
      files.some((f) => f.endsWith('lib/settings.ts')),
      'lib/settings is not in the scan, yet it is where persistBaseUrl lives',
    ).toBe(true);
  });

  it('CRITICAL SimulatorWindow really does reach plugin-store. This is the premise of the whole file: if it stopped using it, the requirement below would be vacuous rather than satisfied, and a green would mean nothing.', () => {
    const uses = simulatorSources()
      .map(read)
      .some((s) => s.includes('@tauri-apps/plugin-store'));
    expect(uses, 'no simulator source imports plugin-store — this guard is now vacuous').toBe(true);
  });

  it('CRITICAL every Tauri plugin the simulator sources use is GRANTED by the capability governing simulator-* windows. A denied plugin call does not crash — it silently does nothing — so the failure this prevents is a window that opens, shows video, and cannot change mode, end the session, or reach the right API host.', () => {
    const sources = simulatorSources().map(read);
    const needed = PLUGIN_BY_PACKAGE.filter(({ pkg }) => sources.some((s) => s.includes(pkg)));
    expect(needed.length, 'no plugin requirement was derived at all').toBeGreaterThan(0);

    const cap = capabilities().find((c) => (c.windows ?? []).includes('simulator-*'));
    expect(cap, 'no capability governs simulator-* windows').toBeDefined();
    const granted = permIds(cap as Capability);

    const missing = needed
      .filter(({ prefix }) => !granted.some((g) => g.startsWith(prefix)))
      .map(({ pkg, prefix }) => `${pkg} (needs a ${prefix}* permission)`);
    expect(
      missing,
      `simulator-* windows call plugins their capability does not grant:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('CRITICAL a window that may CLOSE may also DESTROY. Tauri calls api.prevent_close() the moment a window has a JS onCloseRequested listener and hands the real close to JavaScript, whose only mechanism is destroy() — so allow-close without allow-destroy is not a narrower grant, it is a window that cannot be closed at all. The rejection lands in a fire-and-forget listen callback, becomes an unhandled rejection, and paints the fatal overlay over the in-content toolbar that holds the only close button a decorations:false window has.', () => {
    const cap = capabilities().find((c) => (c.windows ?? []).includes('simulator-*'));
    const granted = permIds(cap as Capability);
    if (granted.includes('core:window:allow-close')) {
      expect(
        granted,
        'simulator-* may close but not destroy — every close path dead-ends in a denied command and the window becomes unclosable',
      ).toContain('core:window:allow-destroy');
    }
  });

  it('CRITICAL the in-process window is granted no MORE than the separate app already has. The separate app’s sim-* windows render the same view for the same purpose, so its grant is the honest ceiling — a capability that quietly grew past it would be widening the attack surface under cover of a bug fix.', () => {
    const caps = capabilities();
    const inProcess = caps.find((c) => (c.windows ?? []).includes('simulator-*'));
    const separate = caps.find((c) => (c.windows ?? []).includes('sim-*'));
    expect(inProcess, 'no simulator-* capability').toBeDefined();
    expect(separate, 'no sim-* capability to compare against').toBeDefined();

    const sep = new Set(permIds(separate as Capability));
    const extra = permIds(inProcess as Capability).filter(
      (p) => !sep.has(p) && !p.startsWith('core:'),
    );
    expect(
      extra,
      `simulator-* holds data permissions the separate app does not:\n  ${extra.join('\n  ')}`,
    ).toEqual([]);
  });

  it('CRITICAL the account API key stays unreachable from a simulator window, enforced in RUST and not by this allowlist. Widening a capability must never be the thing that exposes a credential — and here it cannot be, because the keychain commands require the window label to be exactly "main".', () => {
    const rust = read(resolve(GUI, 'src-tauri/src/lib.rs'));
    expect(
      rust,
      'the keychain caller gate no longer routes through the main-window check',
    ).toContain(
      'is_main_gui_command_caller(app_identifier, window_label) && is_valid_main_gui_secret_key(key)',
    );
    expect(rust, 'the main-window gate stopped requiring the literal "main" label').toMatch(
      /window_label == "main"/,
    );
    for (const cmd of ['secret_save', 'secret_load', 'secret_delete']) {
      const body = new RegExp(`fn ${cmd}\\([\\s\\S]{0,400}?ensure_secret_command`);
      expect(body.test(rust), `${cmd} no longer calls ensure_secret_command`).toBe(true);
    }
  });

  it('the capability description must not still claim it grants no store or fs. A description is what the next reader trusts instead of counting permissions, and this one asserted "no fs/shell/store" for weeks after that stopped being true.', () => {
    const cap = capabilities().find((c) => (c.windows ?? []).includes('simulator-*'));
    const desc = (cap as Capability).description ?? '';
    const granted = permIds(cap as Capability);
    // V-972 — the implication asserted directly rather than guarded by an `if`.
    // Every assertion used to sit inside `if (granted.some(…))`, so the arm passed
    // having checked nothing on any capability that granted neither store nor fs —
    // which is the shape `a-test-arm-may-not-hide-all-its-assertions` refuses.
    // Stated as "it never both grants them and claims it does not", the check runs
    // on every capability and means the same thing.
    const grantsStoreOrFs = granted.some((p) => p.startsWith('store:') || p.startsWith('fs:'));
    const claimsNeither = /no fs\/shell\/store/i.test(desc);
    expect(
      grantsStoreOrFs && claimsNeither,
      'the description still says "no fs/shell/store" while granting them',
    ).toBe(false);
  });
});
