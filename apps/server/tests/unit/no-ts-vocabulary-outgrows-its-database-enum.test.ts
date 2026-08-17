// A TypeScript vocabulary must never carry a value its Postgres enum lacks.
//
// Sixteen `pgEnum`s back columns the server writes, and most have a TS twin —
// a `z.enum([...])` or a `type X = 'a' | 'b'` — maintained by hand alongside
// them. The two directions are not equally dangerous:
//
//   pgEnum has a value TS lacks  → harmless. Nothing writes it; at worst it is
//                                  an unreachable value (there is a separate
//                                  guard for that on admin_audit_action).
//   TS has a value the pgEnum lacks → the code COMPILES, the write path runs,
//                                  and Postgres rejects the INSERT with an
//                                  invalid-input-value-for-enum error. A 500 on
//                                  a customer's request, discovered in
//                                  production, because the migration was the
//                                  step that got forgotten.
//
// Adding an enum value without its migration is the ordinary way this goes
// wrong, and nothing checked for it. Measured when this landed: 19 pairings
// across 15 of the 16 pgEnums, zero TS-only values — so this protects the next
// enum change rather than fixing a present defect.
//
// ⚠️ The extractors carry ground-truth assertions because two earlier versions
// of them were quietly wrong. A `[^;]` union match stopped at a SEMICOLON
// INSIDE A COMMENT ("…stays in the vocabulary; the reachability guard…") and
// read AdminAuditAction as 18 of its 33 values, which would have reported 15
// phantom mismatches. A single-line `type TeamRole = 'member' | 'admin'` was
// missed entirely by a pattern that required a leading `|` on every member.
// Comments are stripped from the whole file BEFORE any matching, and the three
// assertions below pin the shapes those bugs broke.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * Comments first — a `;` or `]` inside one truncates every pattern below.
 *
 * LINE comments are removed BEFORE block comments, and the order is load-bearing.
 * schema.ts contains `// "every /v1/admin/* endpoint writes one row" invariant`,
 * whose `/*` is not a block-comment opener at all. Stripping blocks first made
 * that line swallow everything up to the next `*` + `/` three hundred lines
 * later, taking three pgEnum declarations with it — and the scan reported a
 * smaller, entirely clean set.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The bracketed list starting at `from`, respecting nesting. */
function bracketedList(source: string, from: number): string | null {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']' && --depth === 0) return source.slice(from, i + 1);
  }
  return null;
}

const literals = (text: string): Set<string> =>
  new Set([...text.matchAll(/'([^']+)'/g)].map((m) => m[1]!));

function databaseEnums(): Map<string, Set<string>> {
  const schema = withoutComments(
    readFileSync(resolve(REPO, 'apps/server/src/db/schema.ts'), 'utf-8'),
  );
  const enums = new Map<string, Set<string>>();
  for (const match of schema.matchAll(/pgEnum\('([a-z0-9_]+)',\s*/g)) {
    const list = bracketedList(schema, schema.indexOf('[', match.index + match[0].length - 1));
    if (list) enums.set(match[1]!, literals(list));
  }
  return enums;
}

interface Vocabulary {
  name: string;
  file: string;
  values: Set<string>;
}

function typescriptVocabularies(): Vocabulary[] {
  const files = execFileSync('git', ['ls-files', 'apps/server/src', 'packages'], {
    cwd: REPO,
    encoding: 'utf-8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.includes('/tests/') && !f.includes('/migrations/'));
  const found: Vocabulary[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const body = withoutComments(readFileSync(resolve(REPO, file), 'utf-8'));
    for (const match of body.matchAll(/export const ([A-Za-z0-9]+) = z\.enum\(\s*/g)) {
      const list = bracketedList(body, body.indexOf('[', match.index + match[0].length - 1));
      const values = list ? literals(list) : new Set<string>();
      if (values.size >= 2 && !seen.has(match[1]!)) {
        seen.add(match[1]!);
        found.push({ name: match[1]!, file, values });
      }
    }
    // Both union shapes: `= 'a' | 'b'` and a leading-pipe multi-line list.
    for (const match of body.matchAll(/export type ([A-Za-z0-9]+)\s*=([^;]{2,6000});/g)) {
      if (!match[2]!.includes('|')) continue;
      const values = literals(match[2]!);
      if (values.size >= 2 && !seen.has(match[1]!)) {
        seen.add(match[1]!);
        found.push({ name: match[1]!, file, values });
      }
    }
  }
  return found;
}

const key = (name: string): string =>
  name
    .toLowerCase()
    .replace(/_/g, '')
    .replace(/schema$/, '');

/** pgEnums with no same-named TS vocabulary. Named so coverage cannot shrink quietly. */
const UNPAIRED = ['account_avatar_source'];

describe('no TypeScript vocabulary outgrows its database enum', () => {
  const enums = databaseEnums();
  const vocabularies = typescriptVocabularies();

  it('CRITICAL the extractors survive the shapes that previously broke them', () => {
    expect(enums.size, 'no pgEnums parsed — the schema shape changed').toBeGreaterThanOrEqual(15);
    expect(vocabularies.length, 'no TS vocabularies parsed').toBeGreaterThanOrEqual(80);
    const byName = new Map(vocabularies.map((v) => [v.name, v.values]));
    // A single-line union with no leading pipe.
    expect(byName.get('TeamRole'), 'the single-line union shape is unreadable again').toEqual(
      new Set(['member', 'admin']),
    );
    // A union whose comments contain a semicolon.
    expect(
      byName.get('AdminAuditAction')?.size,
      'AdminAuditAction truncated again — a `;` inside a comment is ending the match',
    ).toBe(33);
    // A z.enum whose list contains comments.
    expect(byName.get('ApiKeyScopeSchema')?.size, 'ApiKeyScopeSchema list truncated').toBe(19);
  });

  it('CRITICAL every pgEnum is either paired or declared unpaired', () => {
    const paired = new Set(vocabularies.map((v) => key(v.name)));
    const orphans = [...enums.keys()].filter((e) => !paired.has(key(e))).sort();
    expect(
      orphans,
      'a pgEnum has no same-named TS vocabulary. That is allowed — add it to UNPAIRED — but it ' +
        'must be a decision, not an omission, or the subset check below silently stops covering it',
    ).toEqual([...UNPAIRED].sort());
  });

  it('CRITICAL no TS vocabulary carries a value its pgEnum would reject', () => {
    const byKey = new Map<string, Set<string>>();
    for (const [name, values] of enums) byKey.set(key(name), values);
    const outgrown: string[] = [];
    for (const { name, file, values } of vocabularies) {
      const dbValues = byKey.get(key(name));
      if (!dbValues) continue;
      for (const value of [...values].sort())
        if (!dbValues.has(value))
          outgrown.push(`${file}: ${name} allows '${value}', the matching pgEnum does not`);
    }
    expect(
      outgrown.sort(),
      'this compiles and then fails at the INSERT with invalid-input-value-for-enum. The migration ' +
        'that adds the value to the Postgres type is the missing step',
    ).toEqual([]);
  });
});
