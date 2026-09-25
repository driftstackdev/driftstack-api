// "set_title not allowed by ACL", repeated in the Simulator window's log (from
// the audit of the owner's developer logs).
//
// A Tauri capability is an allowlist per window label. The Simulator window
// sets its OS title from the page on the phone (so the Dock menu, Mission
// Control and the taskbar name the page, not a bare "Driftstack Simulator"),
// but neither Simulator capability granted `core:window:allow-set-title`, so
// every page change was refused and logged. `setMaximizable(false)` — which
// turns the zoom button off on an aspect-locked phone — was refused the same
// way, silently (its rejection is caught).
//
// The requirement is DERIVED from the source, not restated: every window
// method SimulatorWindow calls on a window handle must be granted, as
// `core:window:allow-<method in kebab case>`, by BOTH capabilities that govern
// Simulator windows — the separate macOS app's (`simulator-app.json`) and the
// in-process window's on Windows and Linux (`simulator.json`).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUI = resolve(HERE, '..', '..');
const SOURCE = readFileSync(resolve(GUI, 'src/views/SimulatorWindow.tsx'), 'utf8');

/** Window methods that need a grant beyond `core:window:default` (which holds
 *  only the read-only queries). */
const MUTATING = [
  'setTitle',
  'setSize',
  'setPosition',
  'setAlwaysOnTop',
  'setMaximizable',
  'setFocus',
  'minimize',
  'close',
  'destroy',
  'startDragging',
] as const;

const kebab = (m: string): string => m.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Every mutating window call the Simulator makes, on a window handle. */
function windowCallsInSource(): string[] {
  const found = new Set<string>();
  for (const m of SOURCE.matchAll(/\b(?:w|win)\.([a-zA-Z]+)\(/g)) {
    const method = m[1] ?? '';
    if ((MUTATING as readonly string[]).includes(method)) found.add(method);
  }
  return [...found].sort();
}

function granted(file: string): Set<string> {
  const cap = JSON.parse(readFileSync(resolve(GUI, 'src-tauri/capabilities', file), 'utf8')) as {
    permissions: (string | { identifier: string })[];
  };
  return new Set(cap.permissions.map((p) => (typeof p === 'string' ? p : p.identifier)));
}

describe('every window call the Simulator makes is granted to its windows', () => {
  it('CONTROL — the scan sees the calls it is about (a scan that found nothing would pass anything)', () => {
    const calls = windowCallsInSource();
    expect(calls).toContain('setTitle');
    expect(calls).toContain('setSize');
    expect(calls).toContain('startDragging');
  });

  for (const file of ['simulator-app.json', 'simulator.json']) {
    it(`${file} grants every one of them`, () => {
      const have = granted(file);
      const missing = windowCallsInSource()
        .map((m) => `core:window:allow-${kebab(m)}`)
        .filter((perm) => !have.has(perm));
      expect(missing).toEqual([]);
    });
  }
});
