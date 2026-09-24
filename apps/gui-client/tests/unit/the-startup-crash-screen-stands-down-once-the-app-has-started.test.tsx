import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * GUI audit #1 (HIGH) — the startup crash screen stands down once the app has started.
 *
 * `index.html` carries an inline guard that paints the full-screen "Driftstack hit a
 * snag" overlay for ANY window error or unhandled rejection. It exists for the boot:
 * a module-load failure happens before `main.tsx` has run, so nothing else can report
 * it. But the guard never stood down. Its listeners run before `main.tsx`'s, so the
 * two things `main.tsx` promises after startup —
 *   • a benign LiveKit/WebRTC teardown error is ignored;
 *   • any other stray error becomes a small non-fatal notice —
 * were both overridden: the latched overlay covered a live session anyway.
 *
 * ⭐ The guard is run from the REAL `index.html` source, and the listeners from the
 * REAL `main.tsx` (only the React roots it mounts are stubbed), in the order the
 * webview runs them. A copy of either would pass while the shipped page did not.
 */

const INDEX_HTML = resolve(__dirname, '../../index.html');

/** The first inline, classic `<script>` in `<head>`: the fail-visible startup guard. */
function startupGuardSource(): string {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  const match = /<script>([\s\S]*?)<\/script>/.exec(head);
  if (match?.[1] === undefined) throw new Error('index.html has no inline startup guard');
  return match[1];
}

vi.mock('../../src/lib/log-buffer', () => ({ installLogCapture: () => undefined }));
vi.mock('../../src/App', () => ({ App: () => <div data-testid="app-stub">app</div> }));
vi.mock('../../src/components/ConfirmProvider', () => ({
  ConfirmProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../src/components/DevLogPanel', () => ({ DevLogPanel: () => null }));

type BootWindow = Window & { __dsBooted?: boolean; __dsFatalShown?: boolean };
const w = window as BootWindow;

function overlay(): Element | null {
  return document.querySelector('[data-fatal-error]');
}

function dispatchRejection(reason: unknown): Event {
  const ev = new Event('unhandledrejection', { cancelable: true });
  Object.defineProperty(ev, 'reason', { value: reason });
  window.dispatchEvent(ev);
  return ev;
}

function dispatchWindowError(error: Error): void {
  window.dispatchEvent(
    new ErrorEvent('error', { error, message: error.message, cancelable: true }),
  );
}

/** The window as the webview has it at a given moment: booted or not, no overlay yet. */
function resetTo(booted: boolean): void {
  document
    .querySelectorAll('[data-fatal-error],[data-transient-notice]')
    .forEach((n) => n.remove());
  w.__dsFatalShown = false;
  w.__dsBooted = booted;
}

let preMainWindowErrorOverlay: string | null = null;
let preMainRejectionOverlay: string | null = null;

beforeAll(async () => {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  // 1. The guard, exactly as the page runs it. Its mount poll is a 500 ms interval;
  //    registering it under fake timers keeps it from ever firing in this file
  //    (the setup file restores real timers after each test).
  vi.useFakeTimers();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- runs index.html's own inline guard script: that script IS the thing under test
  new Function(startupGuardSource())();
  vi.useRealTimers();
  expect(typeof (window as unknown as { __dsFatal?: unknown }).__dsFatal).toBe('function');
  // 2. BEFORE main.tsx has loaded, the guard is the only thing that can report a
  //    failure (a module that fails to load never installs main.tsx's listeners).
  //    Recorded here, asserted below, so the order holds under --sequence.shuffle.
  resetTo(false);
  dispatchWindowError(new Error('a module failed to load'));
  preMainWindowErrorOverlay = overlay()?.getAttribute('data-fatal-error') ?? null;
  resetTo(false);
  dispatchRejection(new Error('the bundle failed to evaluate'));
  preMainRejectionOverlay = overlay()?.getAttribute('data-fatal-error') ?? null;
  resetTo(false);
  // 3. main.tsx — its own listeners, then the React mount that sets __dsBooted.
  await import('../../src/main');
  await waitFor(() => expect(w.__dsBooted).toBe(true));
  expect(document.querySelector('[data-testid="app-stub"]')).not.toBeNull();
});

afterEach(() => {
  resetTo(true);
});

describe('the startup crash screen after the app has started', () => {
  it('CRITICAL a benign LiveKit teardown rejection after boot raises no crash screen', () => {
    resetTo(true);
    const ev = dispatchRejection(new Error('PC manager is closed'));
    expect(overlay()).toBeNull();
    // main.tsx owned it: swallowed, with no notice either.
    expect(ev.defaultPrevented).toBe(true);
    expect(document.querySelector('[data-transient-notice]')).toBeNull();
  });

  it('CRITICAL a benign LiveKit teardown window error after boot raises no crash screen', () => {
    resetTo(true);
    dispatchWindowError(new Error('client initiated disconnect'));
    expect(overlay()).toBeNull();
  });

  it('CRITICAL any other stray rejection after boot becomes a small notice, not the crash screen', () => {
    resetTo(true);
    dispatchRejection(new Error('a background refresh failed'));
    expect(overlay()).toBeNull();
    expect(document.querySelector('[data-transient-notice]')).not.toBeNull();
  });

  it('any other stray window error after boot becomes a small notice, not the crash screen', () => {
    resetTo(true);
    dispatchWindowError(new Error('a stray handler threw'));
    expect(overlay()).toBeNull();
    expect(document.querySelector('[data-transient-notice]')).not.toBeNull();
  });
});

describe('the startup crash screen before the app has started (it must still work)', () => {
  it('CRITICAL an error before main.tsx has even loaded shows the crash screen', () => {
    expect(preMainWindowErrorOverlay).toBe('WINDOW_ERROR');
    expect(preMainRejectionOverlay).toBe('UNHANDLED_REJECTION');
  });

  it('CRITICAL a real rejection before boot shows the crash screen', () => {
    resetTo(false);
    dispatchRejection(new Error('the settings store could not be opened'));
    expect(overlay()?.getAttribute('data-fatal-error')).toBe('UNHANDLED_REJECTION');
    expect(overlay()?.textContent).toContain('Driftstack hit a snag');
  });

  it('CRITICAL a real window error before boot shows the crash screen', () => {
    resetTo(false);
    dispatchWindowError(new Error('a module failed to load'));
    expect(overlay()?.getAttribute('data-fatal-error')).toBe('WINDOW_ERROR');
  });
});
