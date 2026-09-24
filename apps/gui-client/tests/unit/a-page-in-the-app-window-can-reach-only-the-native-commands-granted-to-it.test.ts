import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * GUI audit #13 — the app's own native commands had NO access list. Tauri checks
 * app commands against the capability files only once the app declares an app
 * manifest (tauri 2.11 `webview/mod.rs`: "we only check ACL on plugin commands or
 * if the app defined its ACL manifest"), and `build.rs` declared none. So every
 * page loaded in the window labelled `main` — a remote page included, if the
 * window were ever navigated to one — could call `secret_load` and read the
 * account key; the only guard was the bundle id + window label check in Rust.
 *
 * Now `build.rs` declares every command, and each capability grants exactly the
 * commands its windows call. Capabilities apply to the app's LOCAL origin only
 * (none declares `remote`), so a remote page reaches none of them. `cargo test`
 * runs build.rs, which refuses a capability naming a permission that does not
 * exist; this file pins the other direction — nothing called is left ungranted,
 * nothing registered is left out of the manifest, and no simulator window is
 * given the account-key commands.
 */

const SRC_TAURI = resolve(__dirname, '../../src-tauri');
const SRC = resolve(__dirname, '../../src');
const read = (p: string): string => readFileSync(p, 'utf8');

/** Commands `build.rs` declares in its app manifest. */
function manifestCommands(): string[] {
  const build = read(resolve(SRC_TAURI, 'build.rs'));
  const block = /APP_COMMANDS[^=]*=\s*&\[([\s\S]*?)\];/.exec(build)?.[1] ?? '';
  return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? '');
}

/** Commands `lib.rs` registers with `generate_handler!`. */
function registeredCommands(): string[] {
  const lib = read(resolve(SRC_TAURI, 'src/lib.rs'));
  const block = /generate_handler!\[([\s\S]*?)\]/.exec(lib)?.[1] ?? '';
  return block
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[a-z_]+$/.test(s));
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) return name === 'visual-harness' ? [] : walk(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

/** Commands the shipped front end invokes by name. */
function invokedCommands(): string[] {
  const names = new Set<string>();
  for (const file of walk(SRC)) {
    for (const m of read(file).matchAll(/invoke(?:<[^>]*>)?\(\s*['"]([a-z_]+)['"]/g)) {
      if (m[1] !== undefined) names.add(m[1]);
    }
  }
  return [...names].sort();
}

function capability(name: string): { windows: string[]; permissions: unknown[]; remote?: unknown } {
  return JSON.parse(read(resolve(SRC_TAURI, 'capabilities', `${name}.json`))) as {
    windows: string[];
    permissions: unknown[];
    remote?: unknown;
  };
}

function grants(name: string): Set<string> {
  return new Set(
    capability(name)
      .permissions.filter((p): p is string => typeof p === 'string')
      .filter((p) => p.startsWith('allow-'))
      .map((p) => p.slice('allow-'.length).replace(/-/g, '_')),
  );
}

/** The commands a Simulator window calls: its control key, its Dock tile, and
 *  marking a website's file it saved. Everything else is the main window's. */
const SIMULATOR_COMMANDS = [
  'mark_session_download',
  'reset_dock_tile',
  'set_dock_tile',
  'simulator_control_key_delete',
  'simulator_control_key_load',
];
const ACCOUNT_KEY_COMMANDS = ['secret_delete', 'secret_load', 'secret_save'];

describe('the native command access list', () => {
  it('CRITICAL build.rs declares an app manifest naming every registered command', () => {
    const manifest = manifestCommands();
    expect(manifest.length).toBeGreaterThan(10);
    expect([...manifest].sort()).toEqual([...registeredCommands()].sort());
  });

  it('CRITICAL every command the front end calls is declared', () => {
    const manifest = new Set(manifestCommands());
    const invoked = invokedCommands();
    expect(invoked.length).toBeGreaterThan(10); // the scan read the source
    expect(invoked.filter((c) => !manifest.has(c))).toEqual([]);
  });

  it('CRITICAL the main window is granted every main-window command, and only on its own origin', () => {
    const main = capability('default');
    expect(main.windows).toEqual(['main']);
    expect(main.remote).toBeUndefined();
    const granted = grants('default');
    const expected = manifestCommands().filter((c) => !SIMULATOR_COMMANDS.includes(c));
    expect(expected.filter((c) => !granted.has(c))).toEqual([]);
  });

  it.each(['simulator', 'simulator-app'])(
    'CRITICAL the %s windows are granted their own commands and never the account-key ones',
    (name) => {
      const cap = capability(name);
      expect(cap.remote).toBeUndefined();
      const granted = grants(name);
      expect(SIMULATOR_COMMANDS.filter((c) => !granted.has(c))).toEqual([]);
      for (const c of ACCOUNT_KEY_COMMANDS) expect(granted.has(c)).toBe(false);
      for (const c of granted) expect(SIMULATOR_COMMANDS).toContain(c);
    },
  );
});
