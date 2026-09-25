/* eslint-disable @typescript-eslint/require-await */
// Owner item 8, 2026-09-24: the flight recorder's "previous run ended without
// shutting down" was logged TWICE for each window — as ERROR and again as WARN.
// Cause (App.tsx on HEAD): the durable sink wrote the line with
// `record('error', …)` and the report callback wrote it again with
// `console.warn(line)`, which the log capture also records. One record, two
// entries, two levels.
//
// Contract: one entry per record, at WARN (a crash of the PREVIOUS run is a
// warning about that run, not an error in this one), through the real shell.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

/** One map per store FILE, as the plugin keeps them. */
const files = new Map<string, Map<string, unknown>>();
function file(name: string): Map<string, unknown> {
  let f = files.get(name);
  if (f === undefined) {
    f = new Map();
    files.set(name, f);
  }
  return f;
}

const keychain = new Map<string, string>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: { key: string; value?: string }) => {
    if (cmd === 'secret_load') return keychain.get(args.key) ?? null;
    if (cmd === 'secret_save') keychain.set(args.key, args.value ?? '');
    if (cmd === 'secret_delete') keychain.delete(args.key);
    return undefined;
  }),
}));
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    private readonly name: string;
    constructor(name: string) {
      this.name = name;
    }
    async get<T>(k: string): Promise<T | undefined> {
      return file(this.name).get(k) as T | undefined;
    }
    async set(k: string, v: unknown): Promise<void> {
      file(this.name).set(k, v);
    }
    async save(): Promise<void> {}
  },
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppData: 0 },
  mkdir: vi.fn(async () => undefined),
  writeTextFile: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn(async () => null) }));
vi.mock('@sentry/browser', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
  withScope: vi.fn(),
  Replay: class {},
  BrowserTracing: class {},
}));

const record = (window: string | undefined, onStall: boolean) => ({
  at: Date.UTC(2026, 8, 24, 11, 50, 0),
  onStall,
  ...(window === undefined ? {} : { window }),
  census: {
    blockedMs: onStall ? 6_000 : 0,
    videoElements: 1,
    documentChildren: 900,
    tabCount: null,
    pendingReceipts: null,
    heapUsedMiB: null,
  },
});

beforeEach(() => {
  vi.resetModules();
  files.clear();
  keychain.clear();
  file('settings.json').set('driftstack', {
    baseUrl: 'https://api.driftstack.dev',
    telemetryOptIn: null,
  });
  keychain.set('api_key:api.driftstack.dev', 'ds_live_test_existing_key');
  window.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
});

afterEach(() => {
  cleanup();
});

describe('the previous run is logged once, at WARN', () => {
  it('CRITICAL a crashed main window AND a crashed simulator give exactly one WARN entry each — no ERROR copy', async () => {
    // Both windows died without their exit save (the mark says so).
    file('diagnostics.json').set('lastRun', record(undefined, false));
    file('diagnostics.json').set('cleanShutdown', false);
    file('diagnostics-exit.json').set('exitedNormally', false);
    file('diagnostics-simulator.json').set('lastRun', record('simulator', true));
    file('diagnostics-simulator.json').set('cleanShutdown', false);
    file('diagnostics-simulator-exit.json').set('exitedNormally', false);

    // The log capture main.tsx installs, so console.* lands in the buffer too
    // (that is how the duplicate got there).
    const logs = await import('../../src/lib/log-buffer');
    logs.installLogCapture();
    const { App } = await import('../../src/App');
    render(<App />);

    // The customer-facing half still happens: one toast per window.
    expect(await screen.findByText('The app closed unexpectedly last time')).toBeInTheDocument();
    expect(
      await screen.findByText('The browser window stopped responding last time'),
    ).toBeInTheDocument();

    await waitFor(() => {
      const lines = logs.getLogEntries().filter((e) => e.text.includes('[flight-recorder]'));
      expect(lines.length).toBeGreaterThanOrEqual(2);
    });
    const lines = logs.getLogEntries().filter((e) => e.text.includes('[flight-recorder]'));
    expect(
      lines.map((l) => l.level),
      lines.map((l) => `${l.level}: ${l.text}`).join('\n'),
    ).toEqual(['warn', 'warn']);
    expect(lines.filter((l) => l.text.includes('[simulator]'))).toHaveLength(1);
    expect(lines.filter((l) => !l.text.includes('[simulator]'))).toHaveLength(1);
  });

  it('CRITICAL a run that exited normally is not reported at all', async () => {
    file('diagnostics.json').set('lastRun', record(undefined, false));
    file('diagnostics.json').set('cleanShutdown', false);
    // The plugin's exit save wrote the in-memory `true`.
    file('diagnostics-exit.json').set('exitedNormally', true);

    const logs = await import('../../src/lib/log-buffer');
    logs.installLogCapture();
    const { App } = await import('../../src/App');
    render(<App />);
    await screen.findByRole('button', { name: /Sign out/ }, { timeout: 5000 });
    // Give the async report a moment to have happened if it were going to.
    await new Promise((r) => setTimeout(r, 200));
    expect(logs.getLogEntries().filter((e) => e.text.includes('[flight-recorder]'))).toEqual([]);
    expect(screen.queryByText('The app closed unexpectedly last time')).not.toBeInTheDocument();
  });
});
