// V-1216 — no markdown file the pre-commit hook formats is large enough to kill it.
//
// THE INCIDENT. `docs/verification-log.md` grew to 3.4 MB and Prettier started dying on it with
// `Ineffective mark-compacts near heap limit` under the 8 GB heap `lint-staged` gives it. Nothing
// warned first: the file simply crossed a line, and the next commit that touched it — any commit
// that touched it — failed inside a V8 stack trace rather than at anything resembling a rule. That
// blocked every commit carrying a log entry, which is every commit in this sweep.
//
// A 16 GB heap parses the file, and raising the limit was the obvious fix and the wrong one: this
// machine HAS 16 GB, so a hook process allowed to ask for all of it competes with the suite, the
// editor and the dev server. The file was split instead (V-1214/V-1215). This guard is the warning
// that did not exist.
//
// WHY MARKDOWN ONLY, AND WHY THIS BUDGET. Measured rather than assumed: at the hook's own 8 GB,
// `packages/sdk-python/openapi.json` (1.95 MB) checks in 0.38s and
// `docs/internal/A2-PRODUCTION-READINESS-ASSESSMENT.md` (440 KB) in 0.47s. JSON and TypeScript are
// cheap; it is markdown's parser that blows up, and it did so somewhere between 440 KB and 3.4 MB.
// The budget below sits well above every real file and far below the size that killed the hook, so
// it fires as a nudge to split with room to spare rather than as an emergency.
//
// It reads `.prettierignore` rather than carrying its own list, so an ignored file is exempt here
// for exactly the reason it is exempt there — the frozen log archive is not formatted, so its size
// cannot break anything.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/**
 * Comfortably above the largest real markdown in the repo and far below what killed the hook.
 * A file crossing this is not yet broken — it is close enough that someone should split it.
 */
const MARKDOWN_BUDGET_BYTES = 1_500_000;

/** Directory names never worth walking. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.astro', '.git', 'coverage', 'build']);

/** Path prefixes and filenames listed in `.prettierignore`, so this stays in sync with the hook. */
function prettierIgnored(): string[] {
  return readFileSync(resolve(REPO_ROOT, '.prettierignore'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

function isIgnored(rel: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p || rel.endsWith(p)));
}

function markdownFiles(): Array<{ rel: string; bytes: number }> {
  const out: Array<{ rel: string; bytes: number }> = [];
  const walk = (rel: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(resolve(REPO_ROOT, rel === '' ? '.' : rel));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const child = rel === '' ? entry : `${rel}/${entry}`;
      const full = resolve(REPO_ROOT, child);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(child);
      else if (entry.endsWith('.md')) out.push({ rel: child, bytes: st.size });
    }
  };
  walk('');
  return out;
}

describe('V-1216 no formatted markdown outgrows the format hook', () => {
  it('CRITICAL the walk found the markdown it claims to cover. An empty walk satisfies a size budget forever, which is the same shape as the failure this guard exists to prevent — a check that passes because it is looking at nothing.', () => {
    const files = markdownFiles();
    expect(files.length, 'no markdown files were found at all').toBeGreaterThan(50);
    expect(
      files.some((f) => f.rel === 'docs/verification-log.md'),
      'the live verification log was not among the files walked',
    ).toBe(true);
  });

  it('CRITICAL the ignore list is read from .prettierignore, not restated here. A private copy would keep passing after the real list changed, and this guard would be enforcing a rule the hook no longer follows.', () => {
    const patterns = prettierIgnored();
    expect(patterns.length, 'no patterns were parsed out of .prettierignore').toBeGreaterThan(5);
    // V-1708 — EVERY archive, not the first one. A second archive landed on 2026-08-26 and this
    // arm named only the first, which left a hole nothing else covered: an archive is under the
    // budget at the moment it is split off, so dropping its `.prettierignore` line fails no arm
    // here and Prettier silently starts reformatting a frozen file. The count guards the loop —
    // an empty match list would satisfy a `for` forever.
    const archives = markdownFiles().filter((f) =>
      /^docs\/verification-log-archive-through-v\d+\.md$/.test(f.rel),
    );
    expect(
      archives.length,
      'no frozen log archive was found, so the loop below would assert nothing',
    ).toBeGreaterThanOrEqual(2);
    for (const a of archives) {
      expect(
        isIgnored(a.rel, patterns),
        `${a.rel} is no longer ignored, so the hook would try to format ${(a.bytes / 1_000_000).toFixed(1)} MB`,
      ).toBe(true);
    }
    expect(
      isIgnored('docs/verification-log.md', patterns),
      'the LIVE log is ignored, which would silently drop it from the hook entirely',
    ).toBe(false);
  });

  it('CRITICAL every markdown file the hook formats is under the budget. Prettier does not fail these gracefully: it exits inside a V8 out-of-memory stack trace, so the first sign is every commit touching the file breaking at something that does not look like a rule.', () => {
    const patterns = prettierIgnored();
    const oversized = markdownFiles()
      .filter((f) => !isIgnored(f.rel, patterns))
      .filter((f) => f.bytes > MARKDOWN_BUDGET_BYTES)
      .map((f) => `${f.rel} — ${(f.bytes / 1_000_000).toFixed(2)} MB`);

    expect(
      oversized,
      'these are large enough to threaten the pre-commit hook. Split the file the way the ' +
        'verification log was split in V-1214 — move the frozen part to an archive and add that ' +
        "archive to .prettierignore — rather than raising the hook's heap, which on a 16 GB " +
        'machine hands one hook process the whole machine',
    ).toEqual([]);
  });
});
