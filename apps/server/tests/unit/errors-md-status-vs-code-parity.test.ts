// Drift-guard: the docs/reference/errors.md "Status" column must match the
// HTTP status each ApiError subclass actually sets.
//
// The pre-existing reference-errors parity tests pinned the problem-type
// SLUGS (and cross-checked PROBLEM_TYPES), but NOT the status column — which
// let a legal-acceptance-required 403-vs-409 doc drift survive undetected
// (errors.ts sets 409; the doc said 403). This guard pins the status column
// so any future divergence between the doc and the error classes fails CI.
//
// Mechanism: line-scan errors.ts to pair each `type: PROBLEM_TYPES.<Member>`
// with the next `status: <N>` (type always precedes status within a
// `super({ ... })` block), resolve the member to its URI via the imported
// PROBLEM_TYPES, then assert the errors.md row for that URI carries the same
// status. Error classes whose type is not documented in errors.md are
// out of scope (skipped).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const ERRORS_TS = resolve(REPO, 'apps/server/src/lib/errors.ts');
const ERRORS_MD = resolve(REPO, 'apps/docs/src/pages/reference/errors.md');

/** Map problem-type URI → HTTP status, derived from the ApiError subclasses. */
function codeStatusByUri(): Map<string, number> {
  const out = new Map<string, number>();
  const types = PROBLEM_TYPES as Record<string, string>;
  let member: string | null = null;
  for (const line of readFileSync(ERRORS_TS, 'utf8').split('\n')) {
    const tm = line.match(/type: PROBLEM_TYPES\.(\w+)/);
    if (tm?.[1] !== undefined) {
      member = tm[1];
      continue;
    }
    const sm = line.match(/status: (\d{3})/);
    if (sm?.[1] !== undefined && member !== null) {
      const uri = types[member];
      if (typeof uri === 'string') out.set(uri, Number(sm[1]));
      member = null;
    }
  }
  return out;
}

describe('errors.md status column ↔ ApiError subclass status parity', () => {
  const md = readFileSync(ERRORS_MD, 'utf8');
  const codeStatus = codeStatusByUri();

  it('derives a status for a healthy number of problem types (sanity)', () => {
    expect(codeStatus.size).toBeGreaterThanOrEqual(20);
  });

  it('every documented errors.md row status matches the ApiError subclass status', () => {
    const mismatches: string[] = [];
    for (const [uri, status] of codeStatus) {
      const slug = uri.replace(/^https?:\/\//, '');
      // Row shape: | `errors.driftstack.dev/<slug>` | <status> | ...
      // Backtick after the slug anchors against prefix collisions.
      const re = new RegExp(`${slug.replace(/\./g, '\\.')}\`\\s*\\|\\s*(\\d{3})\\s*\\|`);
      const m = md.match(re);
      if (m?.[1] === undefined) continue; // not documented — out of scope
      const docStatus = Number(m[1]);
      if (docStatus !== status) mismatches.push(`${slug}: code=${status} doc=${docStatus}`);
    }
    expect(mismatches, mismatches.join('; ')).toEqual([]);
  });
});
