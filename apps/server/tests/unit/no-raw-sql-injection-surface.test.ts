// Security drift-guard — the codebase must keep its parameterized-only SQL
// posture. Every database query goes through Drizzle: either the typed query
// builder, or the `sql`...`` template tag whose `${...}` interpolations are
// bound as parameters ($1, $2, ...) rather than spliced into the SQL text.
// That makes value interpolation injection-safe by construction.
//
// The two escape hatches that BYPASS parameterization are:
//   • `sql.raw(x)`        — splices `x` verbatim into the SQL string (NO
//                           binding) → SQLi if `x` is ever user-influenced.
//   • `sql.identifier(x)` — dynamic identifier (column/table) from a value;
//                           even quoted, a user-controlled identifier is a
//                           structure-injection / info-disclosure surface.
//
// A 2026-06-01 audit confirmed ZERO of either across the monorepo: every
// `sql`...`` query (durable-webhook-delivery claim, scheduled-jobs claimDue,
// atlas-priority metrics, legal-acceptances read, usage date_trunc, auth-flow
// token filters) interpolates only parameterized VALUES (server-derived
// timestamps, internal config numbers, auth-context account ids) or Drizzle
// column objects — never user-controlled SQL structure; ORDER BY / LIMIT /
// status literals are all static or value-bound.
//
// This guard pins that: the moment a `sql.raw(` or `sql.identifier(` appears
// in any non-test source file, CI fails and the change gets a security
// review. If a genuinely-safe use is ever needed (e.g. a static fragment),
// add its `repo.ts:line` to ALLOWLIST below WITH a rationale comment — an
// empty allowlist is the strongest expression of "parameterized queries only".

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

// Source roots that may contain DB query code. apps/server/src holds 100% of
// the current SQL surface; packages are included so a future package that
// adds a DB layer is covered without re-touching this guard.
const SOURCE_ROOTS = ['apps/server/src', 'packages'];

// Parameterization-bypass / dynamic-identifier escape hatches. Empty
// allowlist today (audited 2026-06-01). To allow a vetted use, add
// `relativePath:lineNumber` here with a one-line security rationale.
const BYPASS_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'sql.raw(', re: /\bsql\.raw\(/ },
  { label: 'sql.identifier(', re: /\bsql\.identifier\(/ },
];
const ALLOWLIST = new Set<string>();

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  if (!statSync(dir, { throwIfNoEntry: false })) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function rel(p: string): string {
  return relative(REPO_ROOT, p).split('\\').join('/');
}

describe('security: SQL is parameterized-only (no raw/dynamic injection surface)', () => {
  const files = SOURCE_ROOTS.flatMap((r) => listSourceFiles(resolve(REPO_ROOT, r)));

  it('CRITICAL no sql.raw( / sql.identifier( anywhere in non-test source — these bypass Drizzle parameter binding and are an SQLi / structure-injection surface (empty allowlist = parameterized queries only)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const lines = read(f).split('\n');
      lines.forEach((line, i) => {
        for (const { label, re } of BYPASS_PATTERNS) {
          if (re.test(line)) {
            const key = `${rel(f)}:${(i + 1).toString()}`;
            if (!ALLOWLIST.has(key)) offenders.push(`${key}  (${label})`);
          }
        }
      });
    }
    expect(offenders, `unparameterized SQL escape hatches found:\n${offenders.join('\n')}`).toEqual(
      [],
    );
  });

  it('non-vacuous: the scan covered real DB source (found files AND the safe sql`` template tag is in use)', () => {
    expect(files.length).toBeGreaterThan(100);
    const usesSqlTag = files.some((f) => /\bsql`/.test(read(f)));
    expect(usesSqlTag, 'expected the safe sql`` template tag somewhere in scanned source').toBe(
      true,
    );
  });
});
