// Every usage row a metered turn writes names its credits task.
//
// The shadow report's whole claim — "the shadow charge is twice the list price
// of the same turn" — is a JOIN, and the join key is one field the usage
// recorder writes into the row's metadata. Two things have to stay true for it,
// and neither is true by construction:
//
//   · EVERY usage-row write site carries the key. `AgentRuntime` writes usage
//     rows from seven places (plan, replan, read-back, the settled-error twin,
//     and the stop/abort endings), and each one spreads
//     `this.creditReservationOf(args)` by hand. A site added without it writes a
//     row the report cannot join — so those calls' real cost silently leaves the
//     denominator and the ratio drifts ABOVE 2.0, which reads as an overcharge
//     in the one number §8 will not let an account move without. Nothing fails:
//     the row is valid, the turn is fine, and the report is quietly wrong.
//
//   · The WRITER and the READER spell the field the same way. The recorder
//     writes `credit_reservation_id` into the row metadata; the report's SQL
//     asks `metadata->>'credit_reservation_id'`. Each side is pinned to the
//     literal by its own tests, and neither is pinned to the OTHER — so the
//     coherent edit (rename the field, update the recorder's tests) leaves the
//     report joining nothing, with every test green and a report full of
//     zero-cost turns.
//
// ⛔ THE SCAN IS OVER CODE, NEVER PROSE (`codeOnly`). Both source files explain
// this join at length in their comments, and a guard that counted the word in a
// comment would be satisfied by the explanation of the thing it is checking.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CREDIT_RESERVATION_ID_FIELD,
  LIST_PRICE_COST_FIELD,
} from '../../src/db/agent-decomposer-usage-recorder.js';
import { codeOnly } from './_helpers/code-only.js';

const SRC = resolve(import.meta.dirname, '..', '..', 'src');

function code(rel: string): string {
  return codeOnly(readFileSync(resolve(SRC, rel), 'utf8'));
}

const WRITE_SITE = 'this.recordUsageRowWithRetry(';
const CARRIES_THE_KEY = 'this.creditReservationOf(';

/** Where each usage-row write begins, in the order they appear. */
function writeSites(src: string): number[] {
  const at: number[] = [];
  for (let i = src.indexOf(WRITE_SITE); i !== -1; i = src.indexOf(WRITE_SITE, i + 1)) at.push(i);
  return at;
}

function countOf(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) n++;
  return n;
}

describe('every usage row a metered turn writes', () => {
  it('CRITICAL names the AI-credits task it was measured against — at EVERY write site, not at the six somebody remembered. A site that drops the spread writes a row the shadow report cannot join, so that call’s real cost leaves the denominator and the ratio reads above 2.0: an overcharge that is not one, on the number §8 reads as an exit criterion.', () => {
    const src = code('services/agent-runtime.ts');
    const sites = writeSites(src);

    // The scan reaches the sites at all. A guard that found none would pass the
    // arm below vacuously, which is the shape this whole file is about.
    expect(sites.length, 'no usage-row write sites were found in agent-runtime.ts').toBeGreaterThan(
      5,
    );

    const missing: number[] = [];
    for (const [i, start] of sites.entries()) {
      // This site's own arguments: up to the next write site, so a neighbour's
      // spread can never stand in for a missing one.
      const end = sites[i + 1] ?? src.length;
      if (countOf(src.slice(start, end), CARRIES_THE_KEY) !== 1) missing.push(start);
    }

    expect(
      // `codeOnly` blanks comments in place rather than deleting their lines, so
      // this number is the line in the file an editor will open.
      missing.map((start) => `line ${src.slice(0, start).split('\n').length.toString()}`),
      'every recordUsageRowWithRetry call must spread this.creditReservationOf(...) exactly once',
    ).toEqual([]);
  });

  it('CRITICAL is read back under the same name the recorder wrote. The report joins on a string literal in SQL and the recorder writes a constant; each is pinned to its own spelling by its own tests and neither is pinned to the other, so renaming the field and its recorder tests together leaves a report that joins nothing and reads every measured turn as having cost zero.', () => {
    const recorder = code('db/agent-decomposer-usage-recorder.ts');
    const report = code('db/ai-credits-report-repo.ts');

    // The recorder writes both fields under the exported names…
    expect(CREDIT_RESERVATION_ID_FIELD).toBe('credit_reservation_id');
    expect(recorder).toContain('[CREDIT_RESERVATION_ID_FIELD]:');
    expect(recorder).toContain('[LIST_PRICE_COST_FIELD]:');

    // …and the report's SQL asks for exactly those, as jsonb keys.
    expect(report, `the shadow report no longer joins on ${CREDIT_RESERVATION_ID_FIELD}`).toContain(
      `->>'${CREDIT_RESERVATION_ID_FIELD}'`,
    );
    expect(report, `the shadow report no longer prices from ${LIST_PRICE_COST_FIELD}`).toContain(
      `->>'${LIST_PRICE_COST_FIELD}'`,
    );
  });
});
