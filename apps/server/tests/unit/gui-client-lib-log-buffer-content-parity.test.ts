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

  it('Best-effort file mirror (the release-paint diagnostic): writes the buffer to the IN-SCOPE recordings/dev-log.txt under AppData (per-window default), debounced ≤1/s for non-errors but flushed immediately on an ERROR, wrapped so a missing fs scope / non-Tauri context can never break logging — pinned so the on-disk copy stays available when the WKWebView runs but does not composite (b) + the crash trail cannot be lost in the debounce window (#137)', () => {
    expect(body).toMatch(
      /import \{ BaseDirectory, mkdir, writeTextFile \} from '@tauri-apps\/plugin-fs';/,
    );
    // Path must stay inside the granted fs:scope ($APPDATA/recordings/**). The
    // default is dev-log.txt; installLogCapture(fileTag) can point a window (the
    // simulator) at its own file, so the binding is a `let` not a `const` (#137).
    expect(body).toMatch(/let logFile = 'recordings\/dev-log\.txt';/);
    expect(body).toMatch(/logFile = `recordings\/dev-log\$\{fileTag\}\.txt`;/);
    expect(body).toMatch(
      /await writeTextFile\(logFile, formatLogEntries\(\) \+ '\\n', \{ baseDir: BaseDirectory\.AppData \}\);/,
    );
    // Best-effort: persistNow must swallow all errors (no throw can escape).
    expect(body).toMatch(/async function persistNow\(\): Promise<void> \{\s*\n?\s*try \{/);
    // Debounced: at most one write per second.
    expect(body).toMatch(/if \(persistTimer !== null\) return;/);
    expect(body).toMatch(/\}, 1000\);/);
    // #137 — an ERROR flushes immediately (cancelling any pending debounce) so the
    // last log before a crash reaches disk; non-errors stay debounced. Pinned so
    // the crash trail can't silently regress to a debounced-only write.
    expect(body).toMatch(/if \(level === 'error'\) \{/);
    expect(body).toMatch(/void persistNow\(\);/);
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
