// `lib/store-write-lock.ts` serialises the read-modify-write each local Tauri
// store performs (loadX → mutate → set + save). Its header states the failure it
// prevents: without serialisation two concurrent callers interleave and "lose an
// update or resurrect a just-deleted entry".
//
// The primitive is correct. What nothing enforces is its correct USE, and the
// misuse is silent: `makeWriteLock()` called per operation returns a fresh lock
// each time, so every caller serialises against itself alone and the store is
// unprotected. No existing test fails in that state — the loss is a lost write
// under concurrency, not an exception — and the nine call sites were verified by
// hand once, which protects the callers that exist and not the tenth.
//
// So this pins the CONVENTION rather than the current call list: one call per
// store, at module scope. A file that adds a second lock, or moves its call
// inside a function, reds here rather than losing writes in the field.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { makeWriteLock } from '../../src/lib/store-write-lock';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..', 'src');
/** The definition site — it names the symbol without calling it. */
const DEFINITION = join('lib', 'store-write-lock.ts');

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) yield p;
  }
}

interface CallSite {
  file: string;
  line: number;
  text: string;
  moduleScoped: boolean;
}

function callSites(): CallSite[] {
  const out: CallSite[] = [];
  for (const p of walk(SRC)) {
    if (p.endsWith(DEFINITION)) continue;
    const rel = p.slice(SRC.length + 1);
    readFileSync(p, 'utf8')
      .split('\n')
      .forEach((text, i) => {
        if (!/\bmakeWriteLock\s*\(/.test(text)) return;
        // Module scope is column 0. A call nested in a function, hook, factory or
        // block is indented, and that is exactly the per-operation misuse: each
        // invocation would mint a lock that serialises against nothing.
        out.push({
          file: rel,
          line: i + 1,
          text,
          moduleScoped: /^(export )?(const|let|var)\s/.test(text),
        });
      });
  }
  return out;
}

describe('every store holds ONE module-scoped write lock', () => {
  const sites = callSites();

  it('non-vacuous: the walk read a real corpus and found the known stores, so an empty result is a finding rather than a clean bill', () => {
    // Without this, deleting the walk or breaking the regex would satisfy every
    // arm below by finding nothing to violate.
    expect(
      sites.length,
      'no makeWriteLock() call sites found — the sweep read nothing',
    ).toBeGreaterThanOrEqual(8);
    const files = new Set(sites.map((s) => s.file));
    for (const known of ['lib/settings.ts', 'lib/chat-history.ts', 'lib/proxy-probe-cache.ts']) {
      expect(files.has(known), `known store missing from the sweep: ${known}`).toBe(true);
    }
  });

  it('CRITICAL every makeWriteLock() call is at module scope — a lock minted per operation serialises against nothing and loses writes silently', () => {
    const nested = sites
      .filter((s) => !s.moduleScoped)
      .map((s) => `${s.file}:${s.line} ${s.text.trim()}`);
    expect(nested, 'makeWriteLock() must be called once at module scope, not per call').toEqual([]);
  });

  it('CRITICAL no file mints two locks for one store — two locks over one file is two queues, and the weaker one decides', () => {
    const perFile = new Map<string, number>();
    for (const s of sites) perFile.set(s.file, (perFile.get(s.file) ?? 0) + 1);
    const doubled = [...perFile.entries()]
      .filter(([, n]) => n > 1)
      .map(([f, n]) => `${f} (${n.toString()})`);
    expect(doubled, 'one lock per store file').toEqual([]);
  });
});

// ⛔ The arms above are a TEXT pin: they prove nine stores DECLARE a module-scoped
// lock, and nothing there proves the lock serialises anything. That distinction
// is the one that keeps costing us — a pin proves the property is written, only
// execution proves it holds. Until these arms existed, `makeWriteLock` was named
// by exactly one test file (this one) and imported by none.
describe('makeWriteLock actually serialises', () => {
  it('holds the second write until the first completes — the whole reason the lock exists', async () => {
    const lock = makeWriteLock();
    const order: string[] = [];
    let signalStarted!: () => void;
    const firstStarted = new Promise<void>((r) => {
      signalStarted = r;
    });
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const first = lock(async () => {
      order.push('first:start');
      signalStarted();
      await firstMayFinish;
      order.push('first:end');
      return 'A';
    });
    const second = lock(() => {
      order.push('second:start');
      return Promise.resolve('B');
    });

    await firstStarted;
    // The claim: the second write has NOT begun while the first is in flight.
    // Without serialisation both read-modify-writes interleave and one is lost.
    expect(order).toEqual(['first:start']);

    releaseFirst();
    expect(await first).toBe('A');
    expect(await second).toBe('B');
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  // A failed write must not wedge the queue: the next write to that store would
  // deadlock permanently, silently, with no error raised. That is the worst
  // failure this file can have, and it was asserted nowhere before these arms.
  //
  // ⚠️ The property is guarded TWICE, and the mutation matrix is worth having
  // because a single-mechanism edit leaves these arms GREEN:
  //     `const run = lock.then(fn, fn)` — runs fn on the prior op's reject path
  //     `lock = run.then(() => undefined, () => undefined)` — swallows the
  //      rejection so the NEXT `lock.then(...)` sees a resolved promise
  // Measured: removing either one alone -> 7/7 still pass; removing BOTH -> this
  // arm and the ordering arm below both red. So the source comment naming the
  // first mechanism as the reason is naming one of two. Anyone "simplifying"
  // either line will see a green suite and conclude it was safe — it is safe
  // only until someone simplifies the other one too.
  it('a REJECTED write does not wedge the queue — the next write still runs', async () => {
    const lock = makeWriteLock();
    await expect(lock(() => Promise.reject(new Error('disk full')))).rejects.toThrow('disk full');
    await expect(lock(() => Promise.resolve('still working'))).resolves.toBe('still working');
  });

  it('the rejection reaches the CALLER rather than being swallowed by the lock', async () => {
    const lock = makeWriteLock();
    await expect(lock(() => Promise.reject(new Error('surfaced')))).rejects.toThrow('surfaced');
  });

  it('a write queued behind a failing one still runs, in order', async () => {
    const lock = makeWriteLock();
    const order: string[] = [];
    const failing = lock(() => {
      order.push('failing');
      return Promise.reject(new Error('nope'));
    });
    const queued = lock(() => {
      order.push('queued');
      return Promise.resolve(1);
    });
    await expect(failing).rejects.toThrow('nope');
    expect(await queued).toBe(1);
    expect(order).toEqual(['failing', 'queued']);
  });
});
