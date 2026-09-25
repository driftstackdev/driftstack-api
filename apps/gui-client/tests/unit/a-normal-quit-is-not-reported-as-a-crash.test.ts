// Owner item 8, 2026-09-24: "previous run ended without shutting down" was in
// the developer log for the main window AND the simulator at every launch.
//
// ⛔ Why it said that every time: the clean-shutdown mark was written only by a
// React effect cleanup, and quitting the app tears the webview down without
// unmounting anything — so a normal quit never wrote it. Measured on the
// maintainer's Mac: all five records in `diagnostics.json`'s history were
// periodic snapshots (`onStall: false`), none a stall, `cleanShutdown: false`.
//
// The exit mark (main-thread-stall-detector.ts) rides the store plugin's own
// save-every-store on `RunEvent::Exit` instead. These arms model the plugin
// exactly as its source behaves: a store opened with autoSave off keeps
// `set()` in memory; `save()` and the exit hook write memory to disk; a crash
// loses memory.

import { describe, expect, it, vi } from 'vitest';
import {
  createExitMark,
  formatFlightRecord,
  reportPreviousRun,
  type FlightRecord,
  type FlightStore,
} from '../../src/lib/main-thread-stall-detector';

/** A plugin-store file: `disk` survives the process, `memory` does not. */
class PluginStoreFile {
  disk = new Map<string, unknown>();
  memory = new Map<string, unknown>();
  /** A new process opens the file: memory starts as what is on disk. */
  open(): FlightStore {
    this.memory = new Map(this.disk);
    return {
      get: <T>(k: string) => Promise.resolve(this.memory.get(k) as T | undefined),
      set: (k, v) => {
        this.memory.set(k, v);
        return Promise.resolve();
      },
      save: () => {
        this.disk = new Map(this.memory);
        return Promise.resolve();
      },
    };
  }
  /** tauri-plugin-store's `on_event(RunEvent::Exit)`: save every open store. */
  normalExit(): void {
    this.disk = new Map(this.memory);
  }
  /** A crash / kill / force-quit: whatever was only in memory is gone. */
  crash(): void {
    this.memory = new Map();
  }
}

const periodic: FlightRecord = {
  at: Date.UTC(2026, 8, 21, 19, 52, 2, 963),
  onStall: false,
  census: {
    blockedMs: 0,
    videoElements: 0,
    documentChildren: 320,
    tabCount: null,
    pendingReceipts: null,
    heapUsedMiB: null,
  },
};

/** One launch of the app: report the last run, then arm this one. */
async function launch(
  flight: PluginStoreFile,
  exit: PluginStoreFile,
): Promise<{ reported: string[] }> {
  const reported: string[] = [];
  const flightStore = flight.open();
  const mark = createExitMark(exit.open());
  // The recorder arms at start — possibly BEFORE the report reads (App.tsx
  // starts both at once); the mark must still report the previous run.
  void mark.arm();
  await reportPreviousRun(flightStore, (line) => reported.push(line), undefined, mark);
  await mark.arm();
  // The recorder's periodic snapshot of THIS run.
  await flightStore.set('lastRun', periodic);
  await flightStore.save();
  return { reported };
}

describe('a normal quit is not reported as a crash', () => {
  it('CRITICAL after a normal quit the next launch reports nothing', async () => {
    const flight = new PluginStoreFile();
    const exit = new PluginStoreFile();
    await launch(flight, exit); // first run
    exit.normalExit();
    flight.normalExit();
    const { reported } = await launch(flight, exit);
    expect(reported).toEqual([]);
  });

  it('CRITICAL after a crash (or kill, or force-quit) the next launch reports it — once', async () => {
    const flight = new PluginStoreFile();
    const exit = new PluginStoreFile();
    await launch(flight, exit);
    exit.crash();
    flight.crash();
    const { reported } = await launch(flight, exit);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('previous run ended without shutting down');
    // And the launch after THAT (a normal quit in between) is quiet again.
    exit.normalExit();
    flight.normalExit();
    expect((await launch(flight, exit)).reported).toEqual([]);
  });

  it('the first launch of this version is quiet: the old record is the old version quitting normally', async () => {
    const flight = new PluginStoreFile();
    const exit = new PluginStoreFile();
    // What 0.1.71 leaves behind after a normal quit: a periodic record and
    // cleanShutdown false (the mark it never managed to write).
    flight.disk.set('lastRun', periodic);
    flight.disk.set('cleanShutdown', false);
    const { reported } = await launch(flight, exit);
    expect(reported).toEqual([]);
  });

  it('CONTROL without an exit mark the legacy rule still reports an unclean record (the negative this fix removes)', async () => {
    const flight = new PluginStoreFile();
    flight.disk.set('lastRun', periodic);
    flight.disk.set('cleanShutdown', false);
    const onReport = vi.fn();
    await reportPreviousRun(flight.open(), onReport);
    expect(onReport).toHaveBeenCalledTimes(1);
  });

  it('arming never writes `true` to disk itself — only the exit save does', async () => {
    const exit = new PluginStoreFile();
    const mark = createExitMark(exit.open());
    await mark.arm();
    expect(exit.disk.get('exitedNormally')).toBe(false);
    expect(exit.memory.get('exitedNormally')).toBe(true);
  });

  it('the line says what it means, and a periodic snapshot is not printed as a 0 ms stall', () => {
    const line = formatFlightRecord({ ...periodic, window: 'simulator' });
    expect(line).toContain('[flight-recorder] [simulator]');
    expect(line).toContain('crashed, was force-quit, or froze');
    expect(line).not.toContain('blocked 0ms');
    expect(line).not.toContain('[stall]');
    const stalled = formatFlightRecord({
      ...periodic,
      onStall: true,
      census: { ...periodic.census, blockedMs: 8_200 },
    });
    expect(stalled).toContain('stopped responding, then closed');
    expect(stalled).toContain('main thread blocked 8200ms');
  });
});
