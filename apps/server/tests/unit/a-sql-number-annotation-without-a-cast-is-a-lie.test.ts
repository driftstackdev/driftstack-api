// V-1204 — every `sql<number>` template carries a numeric cast.
//
// THE LIE. `sql<number>` tells TypeScript the expression yields a number. It does not make it
// one. Postgres `count(*)` and `sum(...)` return bigint/numeric, and postgres-js hands those back
// as STRINGS to avoid silently truncating values past 2^53. So:
//
//     const [row] = await db.select({ n: sql<number>`count(*)` }) …
//     row.n            // typed number, actually "7"
//     total + row.n    // "07"          — concatenation, not addition
//     row.n > limit    // coerces, so this one accidentally works
//
// The cast is what makes the annotation true: `count(*)::int` returns a real number.
//
// WHY NOTHING ELSE CATCHES IT. TypeScript cannot — the generic is an assertion by the author, and
// `tsc` has no view into what the database returns. A `>` comparison coerces and behaves, so the
// bug hides until something ADDS, and then it produces a plausible-looking wrong number rather
// than an error. There is no exception to log and no throw to catch. This session already hit the
// same shape from the other direction, needing `Number(size_bytes)` on a raw bigint read.
//
// WHY REPO-WIDE. Several `*-content-parity` tests pin an individual `count(*)::int` inside the
// repo file they cover, which is real coverage for those lines and none at all for the fourteenth
// occurrence written next month. Same reasoning as V-1200: the failure is a CLASS, it is silent,
// and per-file pins cannot see a file that does not exist yet.
//
// All thirteen occurrences comply today, so this guard has no allowlist and should never need
// one — `::int` (or `::float8`, `::numeric`) is always available, and an uncast `sql<number>` is
// always a defect waiting on its first addition.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/** Postgres casts that actually produce a JS number through postgres-js. */
const NUMERIC_CAST =
  /::\s*(?:int|int2|int4|int8|integer|smallint|bigint|float|float4|float8|real|double\s+precision|numeric|decimal)/i;

/** Every `sql<number>` tagged template in a source file, as its raw body text. */
function sqlNumberTemplates(source: string): string[] {
  return [...source.matchAll(/sql<number>`([^`]*)`/g)].map((m) =>
    (m[1] ?? '').replace(/\s+/g, ' ').trim(),
  );
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function sourceFiles(): string[] {
  const roots = [resolve(REPO_ROOT, 'apps/server/src')];
  const pkgDir = resolve(REPO_ROOT, 'packages');
  try {
    for (const pkg of readdirSync(pkgDir)) {
      const src = resolve(pkgDir, pkg, 'src');
      try {
        if (statSync(src).isDirectory()) roots.push(src);
      } catch {
        /* package without src/ */
      }
    }
  } catch {
    /* no packages/ */
  }
  return roots.flatMap((r) => walk(r));
}

describe('V-1204 a sql<number> annotation without a cast is a lie', () => {
  it('CRITICAL the detector still detects. It must flag an uncast template and clear a cast one — a detector matching nothing reports full compliance, which is indistinguishable from a repo that has none of this problem.', () => {
    expect(
      sqlNumberTemplates('const q = sql<number>`count(*)`;').filter((b) => !NUMERIC_CAST.test(b)),
      'the detector missed an uncast sql<number>',
    ).toEqual(['count(*)']);
    expect(
      sqlNumberTemplates('const q = sql<number>`count(*)::int`;').filter(
        (b) => !NUMERIC_CAST.test(b),
      ),
      'the detector flags a template that IS cast, which would make the rule unusable',
    ).toEqual([]);
    expect(
      NUMERIC_CAST.test('coalesce(sum(x), 0)::numeric'),
      'numeric is a real cast and must be accepted alongside ::int',
    ).toBe(true);
  });

  it('CRITICAL the scan reached the source it claims to cover. An empty walk agrees with any rule at all.', () => {
    const files = sourceFiles();
    expect(files.length, 'the source walk found no TypeScript files').toBeGreaterThan(200);
    const total = files.reduce((n, f) => n + sqlNumberTemplates(readFileSync(f, 'utf8')).length, 0);
    expect(
      total,
      'no sql<number> templates were found anywhere, so the offender arm below is vacuous',
    ).toBeGreaterThan(10);
  });

  it('CRITICAL every sql<number> template casts. Without the cast postgres-js returns a STRING while TypeScript believes it is a number, so the first addition silently concatenates and produces a plausible wrong figure — no throw, no log, and tsc structurally cannot see it.', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const body of sqlNumberTemplates(readFileSync(file, 'utf8'))) {
        if (NUMERIC_CAST.test(body)) continue;
        offenders.push(`${file.slice(REPO_ROOT.length + 1)} — sql<number>\`${body}\``);
      }
    }
    expect(
      offenders,
      'these declare `number` and will hand back a string. Add `::int` (or `::float8` / ' +
        '`::numeric` where the value can exceed an int), because the annotation is an assertion ' +
        'by the author that nothing in the type system verifies',
    ).toEqual([]);
  });
});
