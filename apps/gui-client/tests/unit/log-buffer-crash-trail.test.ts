// #137 — the on-disk log mirror is the ONLY crash trail when the simulator window
// self-closes (a native WKWebView crash can't be caught in JS). These guard the two
// properties that make that trail trustworthy: an ERROR is flushed to disk
// immediately (not lost in the 1s debounce if the window dies right after), and the
// simulator writes to its OWN file so it can't clobber / be clobbered by the main
// window's full-buffer overwrite.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const writeTextFile = vi.fn((): Promise<void> => Promise.resolve());
const mkdir = vi.fn((): Promise<void> => Promise.resolve());

vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppData: 'AppData' },
  mkdir: (...a: unknown[]): Promise<void> => mkdir(...(a as [])),
  writeTextFile: (...a: unknown[]): Promise<void> => writeTextFile(...(a as [])),
}));

// Let all pending microtasks (the mkdir → writeTextFile await chain in persistNow)
// settle without leaning on the debounce timer.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('log-buffer crash trail (#137)', () => {
  beforeEach(() => {
    vi.resetModules();
    writeTextFile.mockClear();
    mkdir.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes an ERROR entry to disk immediately — not on the 1s debounce', async () => {
    const mod = await import('../../src/lib/log-buffer');
    mod.record('error', ['renderer exploded']);
    await flush();
    expect(writeTextFile).toHaveBeenCalledTimes(1);
    const [path, body] = writeTextFile.mock.calls[0] as [string, string];
    expect(path).toBe('recordings/dev-log.txt');
    expect(body).toContain('[ERROR] renderer exploded');
  });

  it('debounces a non-error entry (no synchronous write)', async () => {
    vi.useFakeTimers();
    const mod = await import('../../src/lib/log-buffer');
    mod.record('log', ['just chatter']);
    await Promise.resolve();
    expect(writeTextFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(writeTextFile).toHaveBeenCalledTimes(1);
  });

  it('a later ERROR cancels the pending debounced write (single flush, no double-write)', async () => {
    vi.useFakeTimers();
    const mod = await import('../../src/lib/log-buffer');
    mod.record('log', ['chatter']); // arms the 1s debounce
    mod.record('error', ['boom']); // must cancel it + flush now
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(writeTextFile).toHaveBeenCalledTimes(1);
    // Advancing past the original debounce window must NOT produce a 2nd write.
    await vi.advanceTimersByTimeAsync(1000);
    expect(writeTextFile).toHaveBeenCalledTimes(1);
  });

  it('the simulator window mirrors to its OWN dev-log-simulator.txt', async () => {
    const mod = await import('../../src/lib/log-buffer');
    mod.installLogCapture('-simulator');
    mod.record('error', ['sim crash']);
    await flush();
    expect(writeTextFile).toHaveBeenCalled();
    const [path] = writeTextFile.mock.calls[0] as [string, string];
    expect(path).toBe('recordings/dev-log-simulator.txt');
  });

  it('the main window keeps the untagged dev-log.txt', async () => {
    const mod = await import('../../src/lib/log-buffer');
    mod.installLogCapture(); // no tag
    mod.record('error', ['main crash']);
    await flush();
    const [path] = writeTextFile.mock.calls[0] as [string, string];
    expect(path).toBe('recordings/dev-log.txt');
  });
});
