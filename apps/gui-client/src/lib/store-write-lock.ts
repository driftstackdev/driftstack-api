// Shared write-lock for the local Tauri stores (chat-history, profiles-meta,
// proxy-probe-cache). Each of those does a read-modify-write (loadX → mutate →
// set + save); without serialization, two concurrent callers can interleave and
// lose an update or resurrect a just-deleted entry. makeWriteLock() returns a
// per-store serializer that runs each mutation to completion before the next
// starts. One lock per store file (cross-store ordering isn't needed — they own
// separate files).

export type WriteLock = <T>(fn: () => Promise<T>) => Promise<T>;

export function makeWriteLock(): WriteLock {
  let lock: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    // Chain on the prior op regardless of its outcome (fn runs on both resolve
    // + reject paths) so one failed write can't wedge the queue.
    const run = lock.then(fn, fn);
    lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
