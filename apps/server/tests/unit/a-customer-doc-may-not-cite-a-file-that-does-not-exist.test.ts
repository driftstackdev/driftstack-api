// V-1143 — a repo path printed in customer documentation has to resolve.
//
// `every-runbook-path-resolves` asserts this for `docs/runbooks/**`, on the reasoning
// that whoever follows a runbook is mid-incident. The same property was never asserted
// for `apps/docs/src/pages/**`, which is the documentation customers actually read, and
// four citations there pointed at files that do not exist:
//
//   api/profile-snapshots.md   packages/api-types/src/profile-snapshots.ts   — no such
//                              module; the ProfileSnapshot schemas live in profiles.ts
//   reference/pagination.md    apps/server/src/db/audit-log-repo.ts          — the repos
//                              are account-audit-repo.ts and admin-audit-repo.ts
//   webhooks/events.md         docs/api/webhooks.md                          — never
//                              existed under that name
//   api/byok-anthropic.md      docs/runbooks/mfa-encryption-key-rotation.md  — no such
//                              runbook, and an internal path besides
//
// A pointer a reader cannot open is worse than no pointer: it reads as precision. One of
// the four was actively held in place by a parity pin that froze the wrong path, so the
// page could not be corrected without a red.
//
// Scope is deliberately `apps/docs/src/pages` and not `docs/**`. The internal tree has
// 41 unresolved citations — design notes and dated session logs naming files that have
// since moved — and holding a historical note to the current tree is the wrong bar.
// Customer documentation is different: it describes what ships now.
//
// The extractor is V-1141's corrected one. `json` precedes `js` because alternation
// takes the first branch that matches, and the trailing boundary is what makes that
// ordering safe rather than lucky.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/docs/src/pages');

const REPO_PATH =
  /(?:^|[\s`(])((?:apps|packages|scripts|docs|operations)\/[A-Za-z0-9_./-]+\.(?:json|mjs|tsx|ts|js|sh|sql|md))(?![A-Za-z0-9])/g;

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(md|mdx|astro)$/.test(entry)) out.push(full);
  }
  return out;
}

function citations(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of walk(PAGES, [])) {
    for (const m of readFileSync(file, 'utf8').matchAll(REPO_PATH)) {
      const p = (m[1] ?? '').replace(/[.,;:]+$/, '');
      out.set(p, [...(out.get(p) ?? []), file.slice(PAGES.length + 1)]);
    }
  }
  return out;
}

describe('V-1143 a customer doc may not cite a file that does not exist', () => {
  it('CRITICAL the scan reads the customer pages and extracts real repo paths. An extractor that silently matched nothing would report every page honest, which is the failure this whole series keeps re-deriving — so this names a citation that must be found rather than counting how many were.', () => {
    const cited = citations();
    expect(
      [...cited.keys()],
      'no repo-path citations extracted — the pages or the pattern moved',
    ).toContain('apps/server/src/routes/profile-snapshots.ts');
  });

  it('CRITICAL every repo path a customer page prints resolves on disk. A customer following a pointer into a file that is not there cannot tell whether they misread it, whether it moved, or whether the feature exists at all — and the citation reads as precision either way.', () => {
    const broken = [...citations().entries()]
      .filter(([p]) => !existsSync(resolve(REPO_ROOT, p)))
      .map(([p, files]) => `${p} (cited by ${[...new Set(files)].sort().join(', ')})`);
    expect(broken.sort(), 'customer pages citing repo files that do not exist').toEqual([]);
  });
});
