import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdaterDeps } from '../../src/lib/updater';

/**
 * GUI audit #18 — the macOS update check fetched `latest.json` with no deadline
 * and read the whole body with `res.json()`. On a stalled connection Settings →
 * Check for updates sat on "Checking…" and the 6-hourly loop's in-flight flag
 * stayed set until WebKit's own timeout. Now the manifest fetch carries the
 * app's standard deadline and its body is read with the bounded reader.
 */

const { checkForUpdateVerbose } = await import('../../src/lib/updater');

function deps(): UpdaterDeps {
  return {
    // macOS: the updater plugin is not permitted, so the manifest path runs.
    check: () => Promise.reject(new Error('updater not permitted')),
    currentVersion: () => Promise.resolve('0.1.0'),
    canSelfInstall: () => false,
    relaunch: () => Promise.resolve(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the macOS update check', () => {
  it('CRITICAL answers "could not reach" instead of hanging on a stalled connection', async () => {
    // A server that accepts the connection and never answers — until aborted.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );
    let settled: { status: string } | null = null;
    void checkForUpdateVerbose(deps()).then((r) => {
      settled = r;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toEqual({ status: 'unreachable' });
  });

  it('CRITICAL refuses an oversized manifest rather than buffering it whole', async () => {
    const huge = JSON.stringify({ version: '9.9.9', notes: 'x'.repeat(2 * 1024 * 1024) });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(huge, { status: 200, headers: { 'content-type': 'application/json' } }),
        ),
      ),
    );
    const r = await checkForUpdateVerbose(deps());
    expect(r.status).toBe('unreachable');
  });

  it('CONTROL — a normal manifest still reports the newer version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ version: '0.2.0', notes: 'fixes' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );
    const r = await checkForUpdateVerbose(deps());
    expect(r.status).toBe('found');
    expect(r.update?.version).toBe('0.2.0');
  });
});
