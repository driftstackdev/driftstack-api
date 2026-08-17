// Consumers import `@driftstack/api-types` by NAME, which resolves to the
// package's gitignored `dist/` — not to `src/`. So the values the suite
// actually executes are the BUILT ones, and nothing checked that the build
// still agrees with its source.
//
// Observed 2026-08-16, first-hand: a mutation run compiled
// MAX_SESSION_MINUTES_PER_TIER.free = 30 into dist. Restoring the source left
// dist holding 30, and the next run measured 30 while `packages/api-types/src/
// common.ts` plainly read 20. `git diff` said clean and `git status` said
// clean, because dist is gitignored — the residue check was structurally blind
// to the residue. The rebuild that should have fixed it exited 0 and changed
// nothing, because the restore had put back the source's older mtime and the
// incremental compiler saw no work to do.
//
// Two things make this hard to notice without a guard:
//
//   • It is silent in the direction that matters. A stale dist does not throw;
//     every affected test simply asserts against a number the source no longer
//     declares, and passes.
//   • `dist-reading-suites-have-fresh-artifacts` cannot see it. That guard
//     matches `apps/<name>/dist` by PATH, and a package reached by name never
//     appears as a path.
//
// mtime is the wrong instrument here — in the incident above dist was NEWER
// than src and still wrong. This compares VALUES.
//
// Coverage is stated rather than assumed: the constants below are the flat
// per-tier records. TIER_FEATURES is a Record of nested objects and is listed
// explicitly as out of scope, so adding a new flat record picks it up
// automatically and nesting one becomes a deliberate decision here.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as builtApiTypes from '@driftstack/api-types';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SOURCE = resolve(REPO, 'packages', 'api-types', 'src', 'common.ts');

/** Records whose values are nested objects, deliberately not compared here. */
const OUT_OF_SCOPE = ['TIER_FEATURES', 'TIER_RATE_LIMIT_DEFAULTS'] as const;

const UNPARSEABLE = Symbol('unparseable');

/** Values tsc emits verbatim: literals, and the `N * B ** E` byte-cap shape. */
function evalLiteral(text: string): unknown {
  const t = text.trim();
  if (t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  const str = /^'([^']*)'$/.exec(t);
  if (str) return str[1];
  const int = /^(\d[\d_]*)$/.exec(t);
  if (int) return Number(int[1]!.replace(/_/g, ''));
  const pow = /^(\d[\d_]*)\s*\*\s*(\d+)\s*\*\*\s*(\d+)$/.exec(t);
  if (pow) return Number(pow[1]!.replace(/_/g, '')) * Math.pow(Number(pow[2]), Number(pow[3]));
  return UNPARSEABLE;
}

/**
 * The object literal initialising `export const NAME`, brace-matched so nesting
 * cannot truncate it. Returns null when the initialiser is not an object
 * literal at all.
 *
 * ⚠️ The first version searched forward for the next `{` from the declaration.
 * For `ARCHETYPE_DISPLAY_LABEL = Object.fromEntries(…)` and the
 * `ARCHETYPE_REGISTRY = […]` array that walked past the declaration entirely
 * and returned a brace belonging to some later statement. The coverage arm
 * below caught it on the first run. The block must begin immediately after the
 * `=`, or this is not an object constant and belongs in neither the compared
 * set nor the skipped one.
 */
function blockFor(source: string, name: string): string | null {
  const head = new RegExp(`export const ${name}\\b[^=]*=\\s*`).exec(source);
  if (!head) return null;
  const open = head.index + head[0].length;
  if (source[open] !== '{') return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  return null;
}

/** Exported constants whose initialiser is an object literal. */
function declaredConstants(source: string): string[] {
  return [...source.matchAll(/export const ([A-Z][A-Z0-9_]{3,})\s*:/g)]
    .map((match) => match[1]!)
    .filter((name) => blockFor(source, name) !== null);
}

/** Top-level `key: value,` pairs, skipping any whose value opens a nested object. */
function flatEntries(block: string): { key: string; value: unknown }[] {
  const inner = block.slice(1, -1);
  const out: { key: string; value: unknown }[] = [];
  for (const match of inner.matchAll(/^\s{2}([A-Za-z_][\w]*)\s*:\s*([^,\n]+),/gm)) {
    const key = match[1]!;
    const raw = match[2]!;
    if (raw.includes('{')) continue;
    out.push({ key, value: evalLiteral(raw) });
  }
  return out;
}

describe('the built api-types agrees with its source', () => {
  const source = readFileSync(SOURCE, 'utf-8');
  const flatNames = declaredConstants(source).filter(
    (n) =>
      !(OUT_OF_SCOPE as readonly string[]).includes(n) &&
      flatEntries(blockFor(source, n)!).length > 0,
  );

  it('CRITICAL the literal reader is correct, so a comparison means something', () => {
    expect(evalLiteral('20')).toBe(20);
    expect(evalLiteral('1_499')).toBe(1499);
    expect(evalLiteral('1 * 2 ** 30')).toBe(1073741824);
    expect(evalLiteral('250 * 2 ** 30')).toBe(268435456000);
    expect(evalLiteral('null')).toBeNull();
    expect(evalLiteral("'custom'")).toBe('custom');
    expect(evalLiteral('someIdentifier')).toBe(UNPARSEABLE);
    // Brace matching must survive a nested object, or the parser silently
    // truncates a block and compares a fraction of it.
    expect(blockFor(source, 'TIER_FEATURES')).toMatch(/\}\s*,?\s*\}$/);
  });

  it('CRITICAL the comparison covers the flat per-tier records, and says what it skips', () => {
    expect(
      flatNames.length,
      'no flat per-tier record parsed — the source shape changed',
    ).toBeGreaterThanOrEqual(5);
    const pairs = flatNames.reduce((n, name) => n + flatEntries(blockFor(source, name)!).length, 0);
    expect(pairs, 'too few entries compared for this to be meaningful').toBeGreaterThanOrEqual(40);
    // Anything declared but not compared is named, so coverage cannot quietly shrink.
    const declared = declaredConstants(source);
    const uncovered = declared.filter((n) => !flatNames.includes(n)).sort();
    expect(
      uncovered,
      'a constant stopped being compared without being declared out of scope',
    ).toEqual([...OUT_OF_SCOPE].sort());
  });

  it('CRITICAL every built value equals the value its source declares', () => {
    const runtime = builtApiTypes as unknown as Record<string, Record<string, unknown>>;
    const mismatches: string[] = [];
    for (const name of flatNames) {
      const built = runtime[name];
      if (!built) {
        mismatches.push(`${name}: declared in source but absent from the built package`);
        continue;
      }
      for (const { key, value } of flatEntries(blockFor(source, name)!)) {
        if (value === UNPARSEABLE) continue;
        if (!Object.is(built[key], value))
          mismatches.push(
            `${name}.${key}: source declares ${String(value)}, the built package exports ${String(built[key])}`,
          );
      }
    }
    expect(
      mismatches.sort(),
      'the suite is executing values the source no longer declares — rebuild the package ' +
        '(touch the source first; an mtime-preserving restore makes the incremental build a no-op)',
    ).toEqual([]);
  });
});
