// In-app dev log buffer (GUI W232 item d — "dev friendly, showing logs").
//
// A bounded in-memory ring buffer that captures console.* output + uncaught
// window errors / promise rejections, so a self-hosted operator can see what
// the app is doing without attaching a remote devtools session (the release
// build ships with devtools off). Pure JS — no Rust, no Tauri dependency — so
// it works in dev + release identically and can't fail the bootstrap.
//
// install() is idempotent + delegates to the original console methods (so the
// real dev console still prints). Anything that subscribes (the DevLogPanel)
// re-renders on each new entry.

import { BaseDirectory, mkdir, writeTextFile } from '@tauri-apps/plugin-fs';

export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  /** Monotonic id — stable React key + lets the panel detect new entries. */
  id: number;
  /** epoch ms (Date.now at capture). */
  ts: number;
  level: LogLevel;
  /** Pre-formatted single-line message (args joined + stringified). */
  text: string;
}

const MAX_ENTRIES = 500;

// Mirror the buffer to a file under $APPDATA/recordings/ (the only fs:scope the
// app grants — reused here, no capabilities change). This is the diagnostic for
// the release-paint case: when the WKWebView runs but doesn't composite, the
// in-app panel can't be seen, but the operator can still read this file. The
// path is the proven recordings fs pattern. Best-effort throughout.
const LOG_DIR = 'recordings';
const LOG_FILE = 'recordings/dev-log.txt';

const entries: LogEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
let installed = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let dirEnsured = false;

async function persistNow(): Promise<void> {
  try {
    if (!dirEnsured) {
      await mkdir(LOG_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
      dirEnsured = true;
    }
    await writeTextFile(LOG_FILE, formatLogEntries() + '\n', { baseDir: BaseDirectory.AppData });
  } catch {
    // Best-effort: a missing fs permission / scope, or a non-Tauri context,
    // must NEVER break logging or the app. The in-memory buffer + panel still
    // work; only the on-disk copy is skipped.
  }
}

// Debounced: coalesce bursts into at most one write per second.
function schedulePersist(): void {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow();
  }, 1000);
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    // Circular / non-serialisable.
    return String(arg);
  }
}

/** Append an entry to the ring buffer (evicting the oldest past the cap) and
 *  notify subscribers. Exported so the bootstrap error handlers can feed it. */
export function record(level: LogLevel, args: readonly unknown[]): void {
  const text = args.map(formatArg).join(' ');
  entries.push({ id: nextId++, ts: Date.now(), level, text });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  for (const fn of listeners) fn();
  schedulePersist();
}

/** Snapshot of the current entries (oldest → newest). */
export function getLogEntries(): readonly LogEntry[] {
  return entries;
}

export function clearLogEntries(): void {
  entries.length = 0;
  for (const fn of listeners) fn();
  schedulePersist();
}

/** Subscribe to buffer changes; returns an unsubscribe fn. */
export function subscribeLogs(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Plain-text dump for the Copy button. */
export function formatLogEntries(): string {
  return entries
    .map((e) => `${new Date(e.ts).toISOString()} [${e.level.toUpperCase()}] ${e.text}`)
    .join('\n');
}

/** Patch console.* + window error listeners to mirror into the buffer.
 *  Idempotent; the original console behaviour is preserved. Call once, early. */
export function installLogCapture(): void {
  if (installed) return;
  installed = true;

  const levels: LogLevel[] = ['log', 'info', 'warn', 'error', 'debug'];
  for (const level of levels) {
    /* eslint-disable no-console -- this IS the console-capture installer: it deliberately
       reads + wraps console[level] (incl. log/info/debug) to mirror output into the buffer,
       preserving the original console behaviour. The no-console policy targets stray logging,
       not this opt-in capture utility. */
    const original = console[level].bind(console) as (...a: unknown[]) => void;
    console[level] = (...args: unknown[]): void => {
      record(level, args);
      original(...args);
    };
    /* eslint-enable no-console */
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('error', (e) => {
      record('error', [e.error instanceof Error ? e.error : (e.message ?? 'window error')]);
    });
    window.addEventListener('unhandledrejection', (e) => {
      record('error', ['Unhandled rejection:', e.reason]);
    });
  }
}
