// An UPDATE may not move a row between accounts.
//
// V-1649: `withOrderLock` re-assigned `accountId` inside its own `.set({…})`.
// The WHERE clause was correct — the row was located by its id under a row lock
// — so every cross-account guard in this suite stayed green. The defect lived in
// the SET, and reverting the fix makes the lock-exclusivity integration test
// fail with the victim's account id sitting where a null belongs.
//
// `db-repo-account-ownership-boundary` pins the other half and cannot pin this
// one: its thirteen arms are all WHERE-predicate enforcement — a row owned by
// one account must not be read, revoked, rotated or deleted by another. A SET
// clause is invisible to all of them, because the account issuing the UPDATE is
// the legitimate owner. Ownership moves under a correct predicate.
//
// The column list is DERIVED from schema.ts. The first version of this scan
// carried a hand-written list and it was wrong in six of seven names — it
// guessed `ownerId`, `teamId`, `createdBy`, where the schema says
// `ownerAccountId`, `memberAccountId`, `createdByAccountId`. It reported a clean
// zero while checking one column of eleven. A list maintained by hand stops
// covering new columns silently, and the silence looks exactly like a pass.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SRC = resolve(REPO_ROOT, 'apps/server/src');

/**
 * Comments are not code; a column named in prose is not a column assigned.
 *
 * Blanked rather than deleted, preserving every newline and offset. Deleting them
 * shifted the reported line by 17 in the mutation that proved this file — it named
 * 247 for a payload that opens at 264 — and a guard that names the wrong line sends
 * the reader somewhere the defect is not. The line reported is the payload's own,
 * which is the UPDATE at fault; the offending column is named in the message.
 * Trailing comments go too — `// accountId: legacy` inside a payload would read as
 * a key — with `:` excluded before the slashes so a `https://` URL survives.
 */
const stripComments = (s: string): string =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(?<![:\w])\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

/** Every uuid column in the schema that is a foreign key to `accounts.id`. */
function ownershipColumns(): string[] {
  const schema = stripComments(readFileSync(resolve(SRC, 'db/schema.ts'), 'utf8'));
  const found = new Set<string>();
  for (const m of schema.matchAll(
    /([A-Za-z_$][\w$]*)\s*:\s*uuid\((?:[^()]|\([^()]*\))*\)((?:[^,;]|\([^()]*\))*)/g,
  )) {
    if ((m[2] ?? '').includes('accounts.id')) found.add(m[1] as string);
  }
  return [...found].sort();
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? d.name === 'node_modules'
        ? []
        : sourceFiles(resolve(dir, d.name))
      : d.name.endsWith('.ts')
        ? [resolve(dir, d.name)]
        : [],
  );
}

/** Keys written at the top level of an object literal — nested objects are not columns. */
function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i] as string;
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    else if (depth === 1) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(i));
      if (m && !/[\w$.]/.test(body[i - 1] ?? '')) {
        keys.push(m[1] as string);
        i += m[0].length - 1;
      }
    }
  }
  return keys;
}

/** `.set({ … })` payloads, brace-balanced so a nested object cannot truncate one. */
function setLiterals(src: string): { line: number; keys: string[] }[] {
  const out: { line: number; keys: string[] }[] = [];
  for (const m of src.matchAll(/\.set\(\s*\{/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let k = open; k < src.length; k += 1) {
      if (src[k] === '{') depth += 1;
      else if (src[k] === '}') {
        depth -= 1;
        if (depth === 0) {
          close = k;
          break;
        }
      }
    }
    if (close < 0) continue;
    out.push({
      line: src.slice(0, open).split('\n').length,
      keys: topLevelKeys(src.slice(open, close + 1)),
    });
  }
  return out;
}

describe('an UPDATE may not move a row between accounts', () => {
  const columns = ownershipColumns();
  const files = sourceFiles(SRC);

  it('CRITICAL the ownership columns are derived from the schema and there are many. A hand-written list checked one column of eleven and reported the same clean zero this file would print if the derivation silently returned nothing.', () => {
    expect(
      columns.length,
      'schema.ts no longer yields uuid columns referencing accounts.id',
    ).toBeGreaterThan(5);
    expect(columns, 'the tenant key itself must be among them').toContain('accountId');
  });

  it('CRITICAL the scan reaches real `.set({…})` payloads, so a zero below means absence rather than a scan that matched nothing.', () => {
    const total = files.reduce(
      (n, f) => n + setLiterals(stripComments(readFileSync(f, 'utf8'))).length,
      0,
    );
    expect(total, 'no `.set({…})` payloads found in apps/server/src').toBeGreaterThan(100);
  });

  it('CRITICAL the detector flags a payload that assigns an ownership column, proving the negative below is a finding and not a broken regex. Shaped like the V-1649 defect: the column sits beside ordinary fields and a nested object carries an innocent key of its own.', () => {
    const positive = `.set({ status: 'paid', ${columns[0] as string}: row.account_id, meta: { accountId: x } })`;
    const [only] = setLiterals(positive);
    expect(only?.keys ?? [], 'the top-level ownership key must be seen').toContain(columns[0]);
    expect(only?.keys ?? [], 'a nested key is not a column being set').not.toContain(
      'meta.accountId',
    );
  });

  it('no UPDATE payload in apps/server/src assigns an ownership column. The exemption list is empty and should stay empty: a legitimate owner change is a delete and an insert, not a column write, because the row carries history that does not transfer.', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'));
      for (const { line, keys } of setLiterals(src)) {
        const hit = keys.filter((k) => columns.includes(k));
        if (hit.length > 0)
          offenders.push(`${f.slice(REPO_ROOT.length + 1)}:${line} sets ${hit.join(', ')}`);
      }
    }
    expect(
      offenders.sort(),
      'an UPDATE assigns an ownership column — ownership must not move under a correct predicate',
    ).toEqual([]);
  });

  it('nor does a payload built up as a variable, which the literal scan above cannot see. Six repos build one this way, and the V-1649 shape is a single `set.accountId = …` line away in any of them.', () => {
    const pattern = new RegExp(String.raw`\b(?:set|sets)\.(${columns.join('|')})\s*=`, 'g');
    const offenders: string[] = [];
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'));
      for (const m of src.matchAll(pattern)) {
        offenders.push(
          `${f.slice(REPO_ROOT.length + 1)}:${src.slice(0, m.index ?? 0).split('\n').length} sets ${m[1] as string}`,
        );
      }
    }
    expect(offenders.sort(), 'a variable UPDATE payload assigns an ownership column').toEqual([]);
  });
});
