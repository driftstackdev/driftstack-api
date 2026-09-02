// "We need to ensure profile is really properly auto closed when running manual
// mode, and closing the simulator window, or when exiting." (owner item N-1.)
//
// The ONLY manual-session end trigger was the per-window onCloseRequested
// handler. App quit never reached it: the main GUI's Tauri .run() takes no
// event callback, there is no RunEvent::ExitRequested, and nothing in the
// webview listened for unload. So ⌘Q with a manual session open sent nothing,
// and the profile was saved back only when the harness idle-reaped the session
// up to 30 minutes later.
//
// The unload path fires the same DELETE with `keepalive: true`, which lets the
// request outlive the document. These arms pin the two properties that matter:
// the request is a keepalive DELETE, and the gate is IDENTICAL to the close
// handler's — a window that could not confirm the mode must not end what might
// be a live agent session.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const calls: Array<{ url: string; init: RequestInit }> = [];
let reject = false;

vi.mock('../../src/lib/fetch-with-deadline', () => ({
  DEFAULT_REQUEST_TIMEOUT_MS: 15_000,
  fetchWithDeadline: (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (reject) return Promise.reject(new Error('network gone'));
    return Promise.resolve(new Response(null, { status: 204 }));
  },
}));
vi.mock('../../src/lib/settings', () => ({
  loadSettings: () => Promise.resolve({ apiKey: 'ds_x', baseUrl: 'https://api.example' }),
  loadBaseUrl: () => Promise.resolve('https://api.example'),
}));

const { endAgentSessionOnUnload, shouldEndOnPageHide } =
  await import('../../src/lib/agent-session-unload');

beforeEach(() => {
  calls.length = 0;
  reject = false;
});
afterEach(() => vi.clearAllMocks());

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('the unload path sends a DELETE that can outlive the page', () => {
  it('sends DELETE with keepalive', async () => {
    endAgentSessionOnUnload('agt_1', {
      controlKey: 'gck_' + 'a'.repeat(32),
      baseUrl: 'https://api.example',
    });
    // The transport is reached through a dynamic import (see the module header:
    // a static import would take seventeen simulator-window suites red), so
    // the call lands a tick or two later than a single setTimeout(0). Poll the
    // assertion rather than guess the tick count.
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const c = calls[0];
    if (c === undefined) throw new Error('no call');
    expect(c.url).toBe('https://api.example/v1/agent-sessions/agt_1');
    expect(c.init.method).toBe('DELETE');
    // THE property: without keepalive the browser cancels the request the
    // moment the document unloads, and the session is never ended.
    expect(c.init.keepalive).toBe(true);
  });

  it('never throws during unload, even when the network is already gone', async () => {
    reject = true;
    expect(() => endAgentSessionOnUnload('agt_1', null)).not.toThrow();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await flush();
    // A rejection during pagehide has nowhere to go but the unhandledrejection
    // handler, which in the simulator paints the fatal overlay. It is swallowed.
  });
});

describe('the gate is identical to the close handler', () => {
  it('ends only a CONFIRMED manual session', () => {
    expect(shouldEndOnPageHide('manual', true, 'agt_1')).toBe(true);
  });

  it('refuses an unconfirmed or non-manual session, or no session', () => {
    // An ai/pair session keeps running in the background on close; it must on
    // quit too. An unconfirmed mode must not end what might be live.
    expect(shouldEndOnPageHide('manual', false, 'agt_1')).toBe(false);
    expect(shouldEndOnPageHide('ai', true, 'agt_1')).toBe(false);
    expect(shouldEndOnPageHide('pair', true, 'agt_1')).toBe(false);
    expect(shouldEndOnPageHide(null, true, 'agt_1')).toBe(false);
    expect(shouldEndOnPageHide('manual', true, '')).toBe(false);
  });
});
