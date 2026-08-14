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

import { readFileSync } from 'node:fs';
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
});
