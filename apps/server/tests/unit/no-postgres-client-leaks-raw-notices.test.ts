// No Postgres client is left with the driver's default notice handler.
//
// postgres-js writes NOTICE messages with `console.log` by default, as a raw
// object dump: severity, code, message, plus `file`, `line` and `routine` from
// the Postgres source, ANSI-coloured, across several lines.
//
// SCOPE IS SERVER SOURCE, and the boundary is deliberate rather than an
// oversight I should be read as having covered. `apps/server/tests` opens ~150
// more connections; they are not in scope here because their output goes to a
// test runner, not to a log collector, and adding a handler to 150 files buys
// nothing. The two that DO matter there — the e2e harness — are covered by
// `the-e2e-harness-silences-the-cascades-it-provokes`, which found that its
// notice filter missed 75% of its own output. So test-side connections are
// excluded from this walk, not from scrutiny.
//
// Both places the SERVER SOURCE opens a connection are somewhere that output is
// wrong, for different reasons:
//
//   db/client.ts    the server runs Pino. An un-JSON object printed straight to
//                   stdout is not a log line any collector will parse, and it
//                   carries no request id, no level, nothing to filter on. It
//                   swallows them: real operational signal comes through Pino.
//   db/migrate.ts   every other line this script writes is one-line JSON, on
//                   purpose, so a deploy's log step is machine-readable. The
//                   default handler broke that contract in exactly the place it
//                   matters — `relation "__drizzle_migrations" already exists,
//                   skipping` landed as a multi-line blob between two clean JSON
//                   lines. It re-emits them as JSON rather than swallowing,
//                   because there is no Pino here and the notice is worth
//                   keeping: "already exists, skipping" is how an operator sees
//                   that a re-run was the no-op it should have been.
//
// The two answers differ, which is the point of asserting the DECISION rather
// than a particular handler. What is not acceptable is the third option — saying
// nothing and taking whatever the driver does.
//
// DERIVED from the `postgres(` call sites, so a third client is covered without
// editing this file. That is the case worth catching: the next connection gets
// opened for a one-off script or a new pool, nobody thinks about notices, and
// the default is silently back.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(HERE, '..', '..', 'src');

/** Source with comment lines removed, for assertions that span a distance. */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

interface ClientSite {
  file: string;
  line: number;
  options: string;
}

/** Every `postgres(...)` client construction, with its options object. */
function postgresClientSites(): ClientSite[] {
  const out: ClientSite[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== 'migrations') walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      const text = readFileSync(full, 'utf8');
      // `= postgres(` only: a bare `postgres(` also matches prose in comments,
      // and two of the three matches in this repo are exactly that.
      for (const m of text.matchAll(/=\s*postgres\(/g)) {
        const lineStart = text.lastIndexOf('\n', m.index) + 1;
        const prefix = text.slice(lineStart, m.index).trimStart();
        if (prefix.startsWith('//') || prefix.startsWith('*')) continue;

        // Brace-match the options object so a nested `connection: {...}` does
        // not truncate it.
        const brace = text.indexOf('{', m.index);
        let options = '';
        if (brace !== -1 && brace - m.index < 200) {
          let depth = 0;
          for (let i = brace; i < Math.min(brace + 4000, text.length); i += 1) {
            if (text[i] === '{') depth += 1;
            else if (text[i] === '}') {
              depth -= 1;
              if (depth === 0) {
                options = text.slice(brace, i + 1);
                break;
              }
            }
          }
        }
        out.push({
          file: full.slice(SERVER_SRC.length + 1),
          line: text.slice(0, m.index).split('\n').length,
          options,
        });
      }
    }
  };
  walk(SERVER_SRC);
  return out;
}

describe('no Postgres client leaks raw notices', () => {
  it('CRITICAL the scan found the clients and captured their options. The assertion below is "none of these is missing onnotice", and a scan that matched nothing has none missing — it would report every connection configured having read no connection at all.', () => {
    const sites = postgresClientSites();
    // MEASURED: 2 — db/client.ts (the app pool) and db/migrate.ts (max: 1).
    expect(sites.length, 'postgres() client constructions found').toBeGreaterThanOrEqual(2);
    expect(
      sites.every((s) => s.options.length > 10),
      'and each options object was brace-matched, not an empty slice',
    ).toBe(true);
    expect(sites.map((s) => s.file).sort(), 'the two known connections').toEqual([
      'db/client.ts',
      'db/migrate.ts',
    ]);
  });

  it('CRITICAL every client decides what to do with notices. Left unset, postgres-js console.logs a raw multi-line object — unparseable in a Pino service, and in the migration script it lands between two clean JSON lines, breaking the one property that made that output machine-readable.', () => {
    const undecided = postgresClientSites()
      .filter((s) => !s.options.includes('onnotice'))
      .map((s) => `${s.file}:${String(s.line)}`)
      .sort();
    expect(undecided, 'postgres client(s) using the driver default notice handler:').toEqual([]);
  });

  it('CRITICAL the migration script re-emits notices as JSON rather than swallowing them. Its whole output contract is one-line JSON per event, and a notice is the one operational signal it has: "already exists, skipping" is how a re-run is seen to be the no-op it should be. Swallowing would satisfy the arm above while throwing that away.', () => {
    // Comments stripped before matching. This assertion spans a distance —
    // `onnotice:` to `JSON.stringify(` — and the first version measured that
    // distance in raw characters, so writing a paragraph of explanation between
    // the two broke it. A guard that fails when someone documents the code is
    // training people not to document the code.
    const migrate = withoutComments(readFileSync(resolve(SERVER_SRC, 'db', 'migrate.ts'), 'utf8'));
    expect(migrate, 'notices are re-emitted, not discarded').toMatch(
      /onnotice:[\s\S]{0,400}JSON\.stringify\(/,
    );
    expect(migrate, 'as a labelled event').toMatch(/msg: 'postgres notice during migration'/);
  });

  it("CRITICAL the migration log carries a notice's DETAIL, not just its summary. When a statement cascades, Postgres puts a count in the message and the objects in `detail` — logging the message alone reports a migration's blast radius as the number 69. Learned from the e2e harness, whose filter missed 1,988 lines by reading only the message.", () => {
    const migrate = withoutComments(readFileSync(resolve(SERVER_SRC, 'db', 'migrate.ts'), 'utf8'));
    expect(migrate, "the notice's detail field is read").toMatch(/notice\.detail/);
    expect(migrate, 'and emitted under its own key rather than overwriting it').toMatch(
      /detail: notice\.detail/,
    );
  });
});
