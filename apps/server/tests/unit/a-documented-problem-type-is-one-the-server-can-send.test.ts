// V-1116 — an error table names the type a customer branches on, so a slug that
// does not exist is a branch that never runs.
//
// Four customer API pages listed `validation` in the Type column of their error
// tables. The server emits `validation-failed`: `ValidationError` carries
// `PROBLEM_TYPES.ValidationFailed`, which is
// `https://errors.driftstack.dev/validation-failed`. Every other row on those
// same tables — `forbidden`, `not-found`, `conflict`, `profile-in-use`,
// `pair-mode-conflict`, `bundled-llm-budget-exhausted` — is the exact declared
// slug, so the convention was never in doubt; one row was simply wrong, and it
// was wrong on the most common 400 a client will ever handle.
//
// The failure is quiet in the worst way. A caller who writes
// `if (problem.type.endsWith('/validation'))` compiles, runs, and silently never
// takes that branch — the schema failure falls through to whatever generic
// handler exists, if any. Nothing 500s and nothing logs.
//
// This derives the legal set from PROBLEM_TYPES rather than listing it. Rows are
// read from the `| <status> | <slug> |` shape the API pages use for error
// tables; a page that stops using that shape drops out of the census rather than
// failing, which is why the population floor below is asserted.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const API_DOCS = resolve(REPO_ROOT, 'apps/docs/src/pages/api');

/** Slug of every problem type the server can actually send. */
function declaredSlugs(): Set<string> {
  return new Set(Object.values(PROBLEM_TYPES).map((url) => url.split('/').pop() as string));
}

interface Row {
  readonly slug: string;
  readonly status: string;
  readonly page: string;
}

/** `| 400 | validation-failed | … |` rows from every customer API page. */
function citedRows(): Row[] {
  const out: Row[] = [];
  for (const f of readdirSync(API_DOCS).filter((n) => n.endsWith('.md'))) {
    const body = readFileSync(resolve(API_DOCS, f), 'utf8');
    for (const m of body.matchAll(/\|\s*`?(\d{3})`?\s*\|\s*`?([a-z][a-z0-9-]{3,})`?\s*\|/g)) {
      out.push({ status: m[1] as string, slug: m[2] as string, page: f });
    }
  }
  return out;
}

describe('V-1116 a documented problem type is one the server can send', () => {
  it('CRITICAL the census found real error tables and real declared types. Both sides are compared as sets, and two empty sets agree — a page-shape change that stopped matching would report every documented type legal having read none of them.', () => {
    expect(declaredSlugs().size, 'problem types declared').toBeGreaterThanOrEqual(25);
    const rows = citedRows();
    expect(rows.length, 'error-table rows parsed from the API pages').toBeGreaterThanOrEqual(15);
    expect(new Set(rows.map((r) => r.page)).size, 'pages carrying an error table').toBeGreaterThan(
      2,
    );
  });

  it('CRITICAL every slug an error table names is a problem type the server declares. The table is the contract a client branches on: a slug that does not exist compiles, runs, and never matches, so the error falls through to a generic handler with nothing logged and nothing 500ing. Four pages named `validation` where the server sends `validation-failed`.', () => {
    const legal = declaredSlugs();
    const bogus = citedRows()
      .filter((r) => !legal.has(r.slug))
      .map((r) => `${r.page}: ${r.status} \`${r.slug}\` is not a declared problem type`)
      .sort();
    expect(
      [...new Set(bogus)],
      'these error tables name a type the server cannot send — a client branching on one never ' +
        'takes that branch:',
    ).toEqual([]);
  });
});
