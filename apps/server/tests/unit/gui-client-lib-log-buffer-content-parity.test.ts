// Drift guard for apps/gui-client/src/lib/log-buffer.ts (GUI W232 d).
// The in-app dev-log ring buffer. Drift here would either unbound the buffer
// (memory leak in a long-lived desktop session), drop the delegate-to-original
// console behaviour (breaking the real dev console), or lose idempotency
// (double-patching console on a re-import / HMR).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/log-buffer.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('gui-client lib/log-buffer content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('Ring buffer is BOUNDED at 500 — pinned so a long-lived desktop session cannot leak memory through unbounded log growth', () => {
    expect(body).toMatch(/const MAX_ENTRIES = 500;/);
    expect(body).toMatch(/if \(entries\.length > MAX_ENTRIES\) entries\.splice\(0,/);
  });

  it('installLogCapture is idempotent + delegates to the original console — pinned so re-import/HMR cannot double-patch and the real dev console still prints', () => {
    expect(body).toMatch(/if \(installed\) return;/);
    expect(body).toMatch(/installed = true;/);
    // Capture then delegate to the bound original (not the other way / not instead).
    expect(body).toMatch(/record\(level, args\);\s*\n?\s*original\(\.\.\.args\);/);
  });

  it('Captures uncaught window errors + promise rejections into the buffer — pinned so a self-hosted operator sees crashes without remote devtools', () => {
    expect(body).toMatch(/window\.addEventListener\('error',/);
    expect(body).toMatch(/window\.addEventListener\('unhandledrejection',/);
  });

  it('Best-effort file mirror (the release-paint diagnostic): writes the buffer to the IN-SCOPE recordings/dev-log.txt under AppData, debounced ≤1/s, wrapped so a missing fs scope / non-Tauri context can never break logging — pinned so the on-disk copy stays available when the WKWebView runs but does not composite (b)', () => {
    expect(body).toMatch(
      /import \{ BaseDirectory, mkdir, writeTextFile \} from '@tauri-apps\/plugin-fs';/,
    );
    // Path must stay inside the granted fs:scope ($APPDATA/recordings/**).
    expect(body).toMatch(/const LOG_FILE = 'recordings\/dev-log\.txt';/);
    expect(body).toMatch(
      /await writeTextFile\(LOG_FILE, formatLogEntries\(\) \+ '\\n', \{ baseDir: BaseDirectory\.AppData \}\);/,
    );
    // Best-effort: persistNow must swallow all errors (no throw can escape).
    expect(body).toMatch(/async function persistNow\(\): Promise<void> \{\s*\n?\s*try \{/);
    // Debounced: at most one write per second.
    expect(body).toMatch(/if \(persistTimer !== null\) return;/);
    expect(body).toMatch(/\}, 1000\);/);
  });

  it('Public surface pinned: record / getLogEntries / clearLogEntries / subscribeLogs / formatLogEntries / installLogCapture', () => {
    for (const fn of [
      'export function record',
      'export function getLogEntries',
      'export function clearLogEntries',
      'export function subscribeLogs',
      'export function formatLogEntries',
      'export function installLogCapture',
    ]) {
      expect(body).toContain(fn);
    }
  });
});
