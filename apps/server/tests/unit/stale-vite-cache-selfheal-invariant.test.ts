// The stale-vite-cache self-heal stays wired, and stays conservative.
//
// A vite cache entry can embed an absolute path under the OS temp root, which
// macOS reaps on a schedule and on reboot. When that happens vitest fails to
// COLLECT the affected files rather than failing a test, and the suite silently
// shrinks — A3 measured a drop from 26,400 tests to 645, reported as collection
// errors with no hint that a cache was the cause. It has cost time in at least
// two agents' runs, which is why it is now healed automatically rather than
// rediscovered.
//
// Two properties are pinned, and the second matters as much as the first:
//   1. `pretest` runs the healer, so nobody has to know the remedy.
//   2. The healer only removes a cache that REFERENCES A MISSING PATH. A
//      version that deleted unconditionally would look identical on a green
//      run while throwing away every warm start — slower for everyone, and
//      impossible to notice.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCRIPT_PATH = 'scripts/clear-stale-vite-cache.mjs';

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('stale vite cache is healed automatically, not rediscovered', () => {
  it('CRITICAL the healer exists and pretest runs it. Without the wiring the failure returns as a cryptic ENOENT and a suite that quietly shrinks to a fraction of its size.', () => {
    expect(existsSync(resolve(REPO_ROOT, SCRIPT_PATH)), `${SCRIPT_PATH} is missing`).toBe(true);
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.pretest, 'pretest must run the healer before the suite').toContain(
      'clear-stale-vite-cache',
    );
  });

  it('CRITICAL the healer is conditional — it removes a cache ONLY when a referenced temp path is missing. An unconditional delete would pass every test here while silently costing every warm start.', () => {
    const src = read(SCRIPT_PATH);
    // The existence check on a referenced path is the whole safety property.
    expect(src).toMatch(/referencedTempPaths\(f\)\.some\(\(p\) => !existsSync\(/);
    // And the removal must sit behind that check rather than running first.
    const staleIdx = src.indexOf('const stale =');
    const rmIdx = src.indexOf('rmSync(dir');
    expect(staleIdx).toBeGreaterThan(-1);
    expect(rmIdx).toBeGreaterThan(staleIdx);
    expect(src).toMatch(/if \(!stale\) continue;/);
  });

  it('CRITICAL the healer reports what it did. A silent self-heal fixes the run and teaches nobody why the suite was about to collapse, so the next person debugs it again.', () => {
    const src = read(SCRIPT_PATH);
    expect(src).toMatch(/console\.warn\(/);
    expect(src).toContain('ENOENT');
  });
});
