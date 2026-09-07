// T-14 BUG 2 — the "never auto-install while a session runs" veto must fire on
// macOS.
//
// `isSessionRunning` is the load-bearing guard: with auto-update defaulting ON
// and macOS now able to self-install, it is the only thing standing between the
// 6-hour recheck and a relaunch() of the MAIN app mid-session — which aborts
// in-flight main-app work (a ProfilesView bulk-launch loop) and destroys live
// browser state the customer cannot get back.
//
// The bug: the veto detected a session ONLY by an in-process webview window
// labelled `simulator-*`. On macOS the simulator is a SEPARATE application whose
// windows are invisible to this window, and a bulk-launch loop holds only
// server-side agent sessions with NO window at all — so the probe reported "no
// session" on macOS even mid-run, and the guard the design calls load-bearing
// never fired there. The fix adds a second, cross-platform signal: the account's
// active-session count from the server, injected so it stays testable.
//
// Mutation record: restore the window-ONLY check (drop the injected
// `activeSessionCount` signal so the body is just
// `all.some((w) => w.label.startsWith('simulator-'))`) → the "macOS session, no
// window" arm reds (it returns false, so the install would proceed), while the
// vacuity arm (no window, server says zero → false) and the in-process-window
// arm stay green.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// getAllWebviewWindows is controlled per-case. The default is the MAIN window
// alone (no `simulator-*` label) — exactly what macOS looks like mid-session,
// where the simulator is a separate app this window cannot enumerate.
const webviewWindows = vi.hoisted(() => ({
  value: [{ label: 'main' }] as Array<{ label: string }>,
  throws: false,
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getAllWebviewWindows: (): Promise<Array<{ label: string }>> =>
    webviewWindows.throws
      ? Promise.reject(new Error('not a tauri context'))
      : Promise.resolve(webviewWindows.value),
}));

const { isSessionRunning } = await import('../../src/lib/updater');

beforeEach(() => {
  webviewWindows.value = [{ label: 'main' }];
  webviewWindows.throws = false;
});

describe('the session veto sees a macOS session (T-14 bug 2)', () => {
  it('CRITICAL macOS session, no in-process window: the account has an active session → veto returns true (do not auto-install)', async () => {
    // No `simulator-*` window (the macOS reality), but the server reports a live
    // agent session — the bulk-launch loop the relaunch would have aborted.
    const activeSessionCount = vi.fn(() => Promise.resolve(1));
    expect(await isSessionRunning({ activeSessionCount })).toBe(true);
    // The server signal was actually consulted — the window probe alone could
    // never have produced this true on macOS.
    expect(activeSessionCount).toHaveBeenCalled();
  });

  it('VACUITY CONTROL macOS, no window and the server says zero → veto returns false (auto-install proceeds)', async () => {
    const activeSessionCount = vi.fn(() => Promise.resolve(0));
    expect(await isSessionRunning({ activeSessionCount })).toBe(false);
    expect(activeSessionCount).toHaveBeenCalled();
  });

  it('FAIL-SAFE an inconclusive server count (null: no client / route down / slow) reads as "a session may be running" → true', async () => {
    // A relaunch mid-session is unrecoverable, so an unknown answer must defer to
    // the banner rather than gamble on auto-installing.
    expect(await isSessionRunning({ activeSessionCount: () => Promise.resolve(null) })).toBe(true);
    // A thrown count is the same as null-unknown, not a crash and not a "no".
    expect(
      await isSessionRunning({ activeSessionCount: () => Promise.reject(new Error('503')) }),
    ).toBe(true);
  });

  it('Windows/Linux signal kept: an in-process `simulator-*` window is a session on its own, without needing the server', async () => {
    webviewWindows.value = [{ label: 'main' }, { label: 'simulator-agt_42' }];
    // A count fn that would say "no session" must NOT flip this to false — the
    // window is a definite yes and short-circuits before the server is asked.
    const activeSessionCount = vi.fn(() => Promise.resolve(0));
    expect(await isSessionRunning({ activeSessionCount })).toBe(true);
    expect(
      activeSessionCount,
      'the window short-circuits before the server call',
    ).not.toHaveBeenCalled();
  });

  it('no server signal wired (default deps): the window probe alone decides — a found window is a session', async () => {
    webviewWindows.value = [{ label: 'simulator-agt_1' }];
    expect(await isSessionRunning()).toBe(true);
  });

  it('CONTROL no server signal, no window: a successful probe that finds nothing is a confident "no session"', async () => {
    webviewWindows.value = [{ label: 'main' }];
    expect(await isSessionRunning()).toBe(false);
  });

  it('CONTROL no server signal, window probe throws (no Tauri context): unknown reads as running, never as "safe to relaunch"', async () => {
    webviewWindows.throws = true;
    expect(await isSessionRunning()).toBe(true);
  });

  it('a thrown window probe still defers to the server signal when one is wired', async () => {
    // The probe being unavailable does not force "running" when a more reliable
    // source can answer: the server says zero, so the install may proceed.
    webviewWindows.throws = true;
    expect(await isSessionRunning({ activeSessionCount: () => Promise.resolve(0) })).toBe(false);
    // …and when the server also cannot answer, it is unknown → running.
    webviewWindows.throws = true;
    expect(await isSessionRunning({ activeSessionCount: () => Promise.resolve(null) })).toBe(true);
  });
});
