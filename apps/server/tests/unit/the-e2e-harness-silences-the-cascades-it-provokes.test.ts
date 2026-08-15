// The e2e harness does not bury its own failures in its own chatter.
//
// The harness is destructive on purpose — `DROP SCHEMA … CASCADE` twice at
// startup for hermeticity, `TRUNCATE … CASCADE` before every test — and
// postgres-js prints every resulting NOTICE as a raw ANSI object dump.
//
// MEASURED on a full green run before the fix: 1,988 of 2,645 lines, 75% of the
// log, were those dumps. The harness had a filter for exactly this and the
// filter under-covered its own output: it read `notice.message` and matched
// `truncate`, while DROP SCHEMA summarises ("drop cascades to 69 other objects")
// and puts its 69 lines in `detail`. Both halves missed.
//
// That is the shape of the bug worth guarding. Not "someone forgot to filter" —
// someone DID filter, against the statement they were thinking about, and a
// second destructive statement three lines away reported differently. The next
// one lands the same way: a third CASCADE statement gets added, the filter is
// not revisited, and a red CI run is unreadable again.
//
// So the coverage arm is DERIVED from the statements the harness actually
// issues, rather than restating a list here. Add a CASCADE statement with a verb
// nothing silences and this fails, without anyone remembering to edit it.
//
// The other two properties are what keep the filter honest. It must NOT be a
// blanket swallow — a notice carrying real signal still prints — and what does
// print must be ONE line, because a 40-line ANSI object is unreadable in a CI
// artifact whether or not it deserved to be there.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { NoticeLike } from '../e2e/helpers/postgres-notices.js';
import { isExpectedCascadeChatter, formatNotice } from '../e2e/helpers/postgres-notices.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(HERE, '..', 'e2e', 'helpers', 'server.ts');

/**
 * The SQL verbs the harness issues with CASCADE.
 *
 * Comment lines are stripped first. This file's own prose, and the harness's,
 * both discuss "`TRUNCATE … CASCADE`" in comments — counting those would let a
 * guard pass on the strength of someone having WRITTEN ABOUT a statement.
 */
function cascadeVerbsIssuedByHarness(): string[] {
  const source = readFileSync(HARNESS, 'utf8');
  const code = source
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

  const verbs: string[] = [];
  for (const match of code.matchAll(/\bCASCADE\b/g)) {
    // The verb can be many lines back: TRUNCATE_SQL is a template literal whose
    // CASCADE sits on the closing line, well after the TRUNCATE.
    const before = code.slice(0, match.index);
    const captured = [...before.matchAll(/\b(TRUNCATE|DROP)\b/g)].pop()?.[1];
    if (captured !== undefined) verbs.push(captured.toLowerCase());
  }
  return [...new Set(verbs)].sort();
}

/**
 * A notice in the shape Postgres actually sends for each statement, captured
 * from a real run rather than imagined.
 *
 * The DROP entry is the one that regressed: the list is in `detail`, and the
 * summary counts objects instead of naming one.
 */
const REAL_NOTICES = {
  truncate: { message: 'truncate cascades to table "session_events"' },
  drop: {
    message: 'drop cascades to 69 other objects',
    detail: [
      'drop cascades to type account_status',
      'drop cascades to table accounts',
      'drop cascades to table api_keys',
      'drop cascades to table webhook_endpoints',
    ].join('\n'),
  },
} satisfies Record<string, NoticeLike & { message: string }>;

/** The same fixtures, reached by a verb discovered at runtime. */
const NOTICE_BY_VERB: Record<string, (NoticeLike & { message: string }) | undefined> = REAL_NOTICES;

describe('the e2e harness silences the cascades it provokes', () => {
  it('CRITICAL the scan reads the harness and finds its destructive statements. The coverage arm below asks "is every verb silenced", and a scan that found no verbs has none unsilenced — it would report full coverage having read nothing. Comment lines are stripped, so this also fails if the only matches were prose about CASCADE rather than a statement issuing it.', () => {
    const verbs = cascadeVerbsIssuedByHarness();
    // MEASURED: TRUNCATE (resetState) and DROP (two DROP SCHEMA at startup).
    expect(verbs, 'CASCADE verbs issued by the harness').toEqual(['drop', 'truncate']);
    expect(
      Object.keys(REAL_NOTICES).sort(),
      'and a real captured notice exists for each verb found',
    ).toEqual(verbs);
  });

  it('CRITICAL every CASCADE statement the harness issues is silenced. This is the arm that fails when a third destructive statement is added and the filter is not revisited — which is precisely how the DROP notices went unfiltered while a TRUNCATE filter sat four lines above them.', () => {
    // A verb with no fixture counts as UNSILENCED rather than being skipped: a
    // new CASCADE statement whose notice nobody captured is exactly the case
    // this arm exists to catch, and silently passing over it would make the
    // guard weakest precisely when something new arrived.
    const unsilenced = cascadeVerbsIssuedByHarness().filter((verb) => {
      const notice = NOTICE_BY_VERB[verb];
      return notice === undefined || !isExpectedCascadeChatter(notice);
    });
    expect(unsilenced, 'CASCADE verb(s) whose notices still print:').toEqual([]);
  });

  it('CRITICAL the DROP SCHEMA notice is silenced through its detail, not just its summary. This is the exact 1,988-line regression: `message` says "drop cascades to 69 other objects" and the 69 lines are in `detail`, a field the previous filter never read.', () => {
    const drop = REAL_NOTICES.drop;
    expect(drop.detail, 'the fixture carries the detail that regressed').toContain('\n');
    expect(isExpectedCascadeChatter(drop), 'the real DROP SCHEMA notice is silenced').toBe(true);
  });

  it('CRITICAL a notice that means something still prints. The filter exists so a red run is readable, not so the harness goes quiet — a swallow would satisfy every arm above while discarding the migration warnings this is meant to preserve.', () => {
    expect(
      isExpectedCascadeChatter({
        message: 'relation "__drizzle_migrations" already exists, skipping',
      }),
      'a migration notice is not cascade chatter',
    ).toBe(false);
    expect(isExpectedCascadeChatter({ message: '' }), 'and neither is an empty notice').toBe(false);
  });

  it('CRITICAL a cascade summary carrying something else in its detail still prints. Matching the summary alone would silence the whole notice on the strength of its first line — the detail is where the 69 objects live, and it is where anything riding along with them would live too.', () => {
    expect(
      isExpectedCascadeChatter({
        message: 'drop cascades to 3 other objects',
        detail: 'drop cascades to table accounts\nconstraint accounts_pkey will be dropped',
      }),
      'a non-cascade detail line keeps the notice visible',
    ).toBe(false);
  });

  it('CRITICAL a notice that survives the filter prints as ONE line. The raw postgres-js object is ~40 ANSI-coloured lines and cannot be grepped out of a CI artifact, so an unfiltered notice was expensive even when it deserved to print.', () => {
    const rendered = formatNotice({
      severity: 'WARNING',
      code: '01000',
      message: 'something worth reading',
    });
    expect(rendered.includes('\n'), 'rendered on a single line').toBe(false);
    expect(JSON.parse(rendered), 'as parseable JSON').toMatchObject({
      msg: 'postgres notice in e2e harness',
      severity: 'WARNING',
      detail: 'something worth reading',
    });
  });

  it('CRITICAL the harness actually uses this predicate. Every arm above tests a module; this one tests that the module is wired to the connection, because a correct filter nothing calls is the same log as no filter at all.', () => {
    const source = readFileSync(HARNESS, 'utf8');
    expect(source, 'onnotice delegates to the predicate').toMatch(
      /onnotice:[\s\S]{0,200}isExpectedCascadeChatter\(/,
    );
    expect(source, 'and survivors go through the one-line formatter').toMatch(
      /console\.warn\(formatNotice\(/,
    );
    expect(source, 'the raw object is not passed to console').not.toMatch(
      /console\.(warn|log)\(notice\)/,
    );
  });
});
