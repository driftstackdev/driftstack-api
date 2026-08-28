// A retention finding stops being open when code closes it, in the document too.
//
// `docs/internal/2026-06-10-data-retention-audit.md` is the register of which
// tables carry customer data with no retention mechanism. It is read to decide
// what to build, and it is the artefact someone reaches for when asked whether a
// disclosed §9 promise is actually implemented.
//
// It went stale in the direction that costs work. Its 2026-08-07 re-audit found
// three unimplemented promises — revoked API keys never deleted, session metadata
// never deleted, and the FK coupling explaining why the first was never built —
// and closed with a section saying a deletion sweeper was deliberately NOT
// written. Two days before this test, V-759 landed
// `retention-scrub-sweeper.ts`, which covers all three. The document said the
// work was outstanding while the work existed.
//
// Both readings of a stale register are expensive. Believing it means
// re-implementing a sweeper that runs today, or reporting a live compliance gap
// that is closed. Disbelieving it means the register stops being consulted, which
// is worse, because the parts of it that ARE current are the ones that matter.
//
// This is not a content pin on prose. The tables the sweeper covers are read from
// the REPO — the sweep steps name them — and the assertion is that the audit
// mentions the sweeper somewhere alongside them. When the next retention
// mechanism lands, the same failure fires: the document has to say so.
//
// WHAT IT DOES NOT CHECK, stated rather than implied. It cannot tell whether the
// document's prose is ACCURATE, only whether it acknowledges the mechanism at
// all. Prose accuracy is not mechanically checkable and pretending otherwise
// would be a worse guard than none. What it catches is the specific, recurring
// failure: code closes a documented gap and nobody edits the document.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(HERE, '..', '..', 'src');
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const AUDIT = resolve(REPO_ROOT, 'docs', 'internal', '2026-06-10-data-retention-audit.md');
const SCRUB_REPO = resolve(SERVER_SRC, 'db', 'retention-scrub-repo.ts');
const SCRUB_SWEEPER = resolve(SERVER_SRC, 'services', 'retention-scrub-sweeper.ts');

/**
 * Tables the retention scrub actually writes to.
 *
 * Read from the raw `UPDATE <table>` and `DELETE FROM <table>` statements rather
 * than Drizzle's builder: this
 * repo issues hand-written SQL so the scrub can take `FOR UPDATE SKIP LOCKED` on
 * the candidate rows. The first version of this reader matched `.update(x)` and
 * found NOTHING — the anti-vacuity floor below is what caught it, which is the
 * whole reason that floor exists.
 */
function scrubbedTables(): string[] {
  const text = readFileSync(SCRUB_REPO, 'utf8');
  const found = new Set<string>();
  // Both verbs matter: the sweep ANONYMISES sessions and api_keys but DELETES
  // session_operations, and a reader that saw only one verb would miss a third
  // of the coverage while reporting the register current.
  for (const m of text.matchAll(/\b(?:UPDATE|DELETE FROM)\s+([a-z_][a-z0-9_]*)/g)) {
    found.add(m[1]!);
  }
  return [...found].sort();
}

/**
 * Artifacts the repo actually contains: source file stems, and declared symbols.
 *
 * This is the resolver for the reverse direction. Every arm above walks repo ->
 * doc; this one walks doc -> repo, and the two catch opposite failures. A
 * mechanism cell is required to name something that EXISTS, which is a weaker
 * property than "the mechanism works" and a much stronger one than prose.
 */
function repoArtifacts(): { stems: Set<string>; decls: Set<string> } {
  const stems = new Set<string>();
  const decls = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts')) {
        stems.add(e.name.slice(0, -3));
        const text = readFileSync(full, 'utf8');
        for (const m of text.matchAll(
          /\b(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_]\w*)/g,
        )) {
          decls.add(m[1]!);
        }
        for (const m of text.matchAll(
          /^\s{2,}(?:(?:public|private|protected|static|async|readonly)\s+)*([a-z]\w*)\s*\(/gm,
        )) {
          decls.add(m[1]!);
        }
      }
    }
  };
  walk(SERVER_SRC);
  return { stems, decls };
}

/** The rows of the "Covered (have a prune or archive)" table, as [table, mechanism]. */
function coveredRows(): { table: string; mechanism: string }[] {
  const audit = readFileSync(AUDIT, 'utf8');
  const section = audit.split(/^## Covered[^\n]*$/m)[1]?.split(/^## /m)[0] ?? '';
  const rows: { table: string; mechanism: string }[] = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    if (/^-+$/.test(cells[0]!.replace(/[\s-]/g, '-'))) continue; // separator
    if (cells[0] === 'Table') continue; // header
    rows.push({ table: cells[0]!, mechanism: cells[1]! });
  }
  return rows;
}

/** Tokens in a mechanism cell that name a real artifact. */
function namedArtifacts(
  mechanism: string,
  repo: { stems: Set<string>; decls: Set<string> },
): string[] {
  const hits: string[] = [];
  for (const raw of mechanism.match(/[A-Za-z][\w.-]{5,}/g) ?? []) {
    const tok = raw.endsWith('.ts') ? raw.slice(0, -3) : raw;
    // Require structure — camelCase, UPPER_SNAKE or kebab. A bare English word
    // like "sweeper" or "prune" must not count as naming anything, or the arm
    // grades prose and passes on exactly the row that motivated it.
    if (!/[A-Z]|-/.test(tok)) continue;
    if (repo.stems.has(tok) || repo.decls.has(tok)) hits.push(tok);
  }
  return hits;
}

describe('the retention audit does not outlive its findings', () => {
  it('CRITICAL the scrub repo was read and it writes to real tables. The assertion below is "the audit mentions these", and an empty table list is mentioned by every document — a reader that matched nothing would report the register current having learned nothing about what the sweeper touches.', () => {
    const tables = scrubbedTables();
    // MEASURED: the sweep runs three steps — session_operations, sessions,
    // api_keys — in that fixed order.
    expect(tables.length, 'tables the retention scrub updates').toBeGreaterThanOrEqual(3);
    expect(tables, 'including the sessions table').toContain('sessions');
    expect(readFileSync(SCRUB_SWEEPER, 'utf8').length, 'the sweeper file is real').toBeGreaterThan(
      500,
    );
  });

  it('CRITICAL the audit acknowledges the retention scrub exists. It described revoked keys and session metadata as never deleted, and closed by saying a sweeper was deliberately not written — while the sweeper was running. A register believed in that state causes duplicated work; a register disbelieved stops being read at all, which is worse, because its current entries are the ones that matter.', () => {
    const audit = readFileSync(AUDIT, 'utf8');
    expect(audit, 'names the sweeper that closed its findings').toMatch(
      /retention-scrub-sweeper|retention-anonymisation-design/,
    );
  });

  it('CRITICAL every table the scrub touches is named in the audit. A mechanism that covers a table the register still lists as unprotected is exactly the drift this exists to catch, and it is per-table rather than per-document so covering one more table forces one more sentence.', () => {
    const audit = readFileSync(AUDIT, 'utf8');
    const unmentioned = scrubbedTables()
      .filter((table) => !audit.includes(table))
      .sort();
    expect(unmentioned, 'scrubbed table(s) the retention audit never names:').toEqual([]);
  });

  it('CRITICAL the audit still carries its scope caveat. It is a point-in-time document whose "the rest are covered" line was written in June, and the note saying so is what stops a later reader treating the whole register as current — the same failure this file guards, one level up.', () => {
    const audit = readFileSync(AUDIT, 'utf8');
    // The HEADING, not the phrase. The V-759 resolution note above it also
    // contains the words "Stale-audit note" as a reference, so matching the bare
    // phrase made this arm satisfiable by the very edit it was meant to outlive —
    // renaming the section left it green.
    expect(audit, 'keeps the stale-audit caveat as a section').toMatch(/^### Stale-audit note$/m);
    expect(audit, 'and scopes the covered claim to its own date').toMatch(
      /scoped to 2026-06-10|Treat the "the rest are covered" line/,
    );
  });

  it('CRITICAL the resolver sees the repo, and the covered table parses. Both halves are floors: a resolver that matched nothing would report every mechanism unnamed, and a parser that matched no rows would report every mechanism fine — the two failures look like opposite verdicts and are the same bug.', () => {
    const repo = repoArtifacts();
    expect(repo.stems.size, 'source file stems under src').toBeGreaterThan(200);
    expect(repo.decls.size, 'declared symbols under src').toBeGreaterThan(2000);
    // Known positives: if these stop resolving the resolver is broken, not the doc.
    expect(repo.decls, 'a known exported symbol').toContain('pruneOlderThan');
    expect(repo.stems, 'a known sweeper file').toContain('auth-flows-sweeper');
    expect(coveredRows().length, 'rows in the Covered table').toBeGreaterThanOrEqual(4);
  });

  it('CRITICAL every row of the covered table names an artifact that exists. This is the reverse of the arms above: they check that code closing a gap reaches the document, this checks that a document claiming coverage reaches the code. web_sessions sat in this table for 78 days across three dated passes as "expires_at + sweeper" — a column and a noun, naming nothing — while no code path deleted a row (V-2059). The gaps list is re-read and annotated; the safe-list is not, so its rows need a machine to keep them honest.', () => {
    const repo = repoArtifacts();
    const unnamed = coveredRows()
      .filter((r) => namedArtifacts(r.mechanism, repo).length === 0)
      .map((r) => `${r.table} -> "${r.mechanism}"`);
    expect(
      unnamed,
      'covered row(s) whose mechanism names no file or symbol in the repo. Name the sweeper, the prune method, or the constant that implements it — if nothing can be named, the row does not belong in this table:',
    ).toEqual([]);
  });
});
