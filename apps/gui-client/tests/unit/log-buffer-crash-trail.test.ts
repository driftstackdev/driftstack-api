// #137 — the on-disk log mirror is the ONLY crash trail when the simulator window
// self-closes (a native WKWebView crash can't be caught in JS). These guard the two
// properties that make that trail trustworthy: an ERROR is flushed to disk
// immediately (not lost in the 1s debounce if the window dies right after), and the
// simulator writes to its OWN file so it can't clobber / be clobbered by the main
// window's full-buffer overwrite.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Typed to the real signature so `mock.calls[n]` is a [path, body, opts?] tuple the
// arms can destructure without a cast from `[]` (four TS2352s under tsconfig.test).
const writeTextFile = vi.fn(
  (_path: string, _body: string, _opts?: unknown): Promise<void> => Promise.resolve(),
);
const mkdir = vi.fn((): Promise<void> => Promise.resolve());

vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppData: 'AppData' },
  mkdir: (...a: unknown[]): Promise<void> => mkdir(...(a as [])),
  writeTextFile: (path: string, body: string, opts?: unknown): Promise<void> =>
    writeTextFile(path, body, opts),
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

  it('P-25 CRITICAL an error STORM while a write is in flight issues ONE follow-up write, not one per error — N concurrent full-ring IPC writes is the loop saturation that presents as a freeze', async () => {
    // Hold the first write open so every error that follows lands while it is in flight.
    // Never null: TS cannot see the assignment inside the Promise executor, so a
    // nullable binding narrows to `null` at the call site (TS2349).
    let releaseFirst: () => void = () => {};
    writeTextFile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const mod = await import('../../src/lib/log-buffer');
    mod.record('error', ['first']);
    await flush();
    expect(writeTextFile).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 25; i += 1) mod.record('error', [`storm ${String(i)}`]);
    await flush();
    // Still exactly one: the storm marked the buffer dirty instead of fanning out.
    expect(writeTextFile).toHaveBeenCalledTimes(1);
    expect(mod.persistBacklogForTests()).toEqual({ inFlight: true, dirty: true });
    releaseFirst();
    await flush();
    await flush();
    // ONE follow-up carries everything the storm added — nothing dropped, 2 writes total.
    expect(writeTextFile).toHaveBeenCalledTimes(2);
    const [, body] = writeTextFile.mock.calls[1] as [string, string];
    expect(body).toContain('[ERROR] storm 24');
    expect(mod.persistBacklogForTests()).toEqual({ inFlight: false, dirty: false });
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

  // P-25 (2026-09-05) — a refused mirror must be VISIBLE. The fs:scope had allowed
  // `$APPDATA/recordings/**` but not the directory itself, so the mkdir was refused
  // and the crash trail had never reached disk on the owner's Mac — and nothing said
  // so. The first failure is recorded once into the in-memory buffer; it must not
  // throw, and must not loop (recording triggers another persist that fails again).
  it('CRITICAL a refused mirror is recorded ONCE as a warn entry, without throwing or looping', async () => {
    mkdir.mockImplementationOnce(() => Promise.reject(new Error('forbidden path: recordings')));
    const mod = await import('../../src/lib/log-buffer');
    mod.record('error', ['first']);
    await flush();
    await flush();
    const warns = mod
      .getLogEntries()
      .filter((e) => e.level === 'warn' && e.text.includes('on-disk mirror unavailable'));
    expect(warns).toHaveLength(1);
    expect(warns[0]?.text).toContain('forbidden path: recordings');
    // A later error does not add a second notice.
    mod.record('error', ['second']);
    await flush();
    expect(
      mod.getLogEntries().filter((e) => e.text.includes('on-disk mirror unavailable')),
    ).toHaveLength(1);
  });
});
