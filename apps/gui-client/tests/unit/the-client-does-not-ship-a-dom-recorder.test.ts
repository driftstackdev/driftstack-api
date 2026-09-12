// gui-v0.1.52 shipped a 362,020-byte lazily-loaded chunk holding Sentry Session
// Replay, User Feedback and rrweb. Nothing registered them, nothing recorded and
// no widget rendered — `telemetry.ts` drops 'Replay' from the defaults besides —
// but a privacy-facing product had a DOM recorder in its binary on every
// platform, and every customer paid the bytes. Measured on the published
// bundles: 1,862,293 B of embedded frontend in 0.1.51, 2,266,219 in 0.1.52, of
// which only 32,030 was the app growing for that release's actual work.
//
// ⛔ THE CAUSE WAS ONE CHARACTER OF IMPORT STYLE. A dynamic NAMESPACE import —
// `import('@sentry/browser')` — cannot be tree-shaken: the namespace object has
// to exist at runtime, so every export in the package is retained in that chunk.
// The same package imported by NAME, statically, shakes fine, which is why
// `telemetry.ts` had done exactly that for months without shipping any of it.
//
// This guard is a source scan, deliberately. The defect is invisible in every
// behavioural test (the integrations were inert), invisible to tsc, invisible to
// the render gates, and only shows in bytes nobody was counting. What it pins is
// the IMPORT STYLE, at the place the style decision is made.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/** Source with comments removed.
 *  ⛔ Written because this file's FIRST run reported three violations, all of
 *  them in the header of `lib/sentry-capture.ts` — the block that documents the
 *  trap by quoting `import('@sentry/browser')`, `export *` and
 *  `replayIntegration` verbatim. A prose mention of an import is not an import,
 *  and a scanner that cannot tell them apart forces the next person to describe
 *  the defect in euphemisms so the guard stays green. Strings are not excluded:
 *  no source here puts an import expression in a string literal, and treating
 *  one as real would fail SAFE. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe('the desktop client does not ship a DOM recorder', () => {
  const files = sourceFiles(SRC);

  it('has sources to scan at all', () => {
    // The vacuity control. A scan that walks nothing reports no violations with
    // perfect confidence, and this one walks a path built from import.meta.url.
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith('lib/updater.ts'))).toBe(true);
  });

  it('never dynamic-imports the Sentry namespace — the one style that cannot be shaken', () => {
    const offenders = files
      .map((f) => ({ f, s: codeOf(readFileSync(f, 'utf8')) }))
      .filter(({ s }) => /import\(\s*['"]@sentry\/[^'"]+['"]\s*\)/.test(s))
      .map(({ f }) => f.slice(SRC.length + 1));
    expect(
      offenders,
      'a dynamic namespace import of the Sentry SDK retains every export in that chunk, ' +
        'including replayIntegration, feedbackIntegration and rrweb — import the names you ' +
        'need statically from lib/sentry-capture.ts and dynamic-import THAT instead',
    ).toEqual([]);
  });

  it('the narrow door stays narrow: sentry-capture re-exports names, never a star', () => {
    const door = codeOf(readFileSync(join(SRC, 'lib', 'sentry-capture.ts'), 'utf8'));
    // A named re-export is shakeable; `export *` is not, and would restore the
    // defect in a line that reads like tidying.
    expect(door).toMatch(/export\s*\{[^}]+\}\s*from\s*['"]@sentry\/browser['"]/);
    expect(door).not.toMatch(/export\s*\*\s*from\s*['"]@sentry/);
    expect(door).not.toMatch(/import\s*\*\s*as\s+\w+\s*from\s*['"]@sentry/);
  });

  it('no source names a replay or feedback integration', () => {
    const named = files
      .map((f) => ({ f, s: codeOf(readFileSync(f, 'utf8')) }))
      .filter(({ s }) =>
        /\b(replayIntegration|feedbackIntegration|replayCanvasIntegration)\b/.test(s),
      )
      .map(({ f }) => f.slice(SRC.length + 1));
    expect(
      named,
      'registering either one would make the recorder live, not merely present',
    ).toEqual([]);
  });
});
