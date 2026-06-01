// Cross-source invariant — the bundled-LLM `record_type` literal must be
// IDENTICAL between the WRITER and the cap-query READER.
//
// The bundled-LLM monthly soft-cap (Arc 1 sub-slice 6.5) works like this:
//   • WRITER — agent-decomposer-usage-recorder.ts tags every bundled-LLM turn's
//     usage_records row with record_type = 'agent_decomposer_bundled'.
//   • READER — bundled-llm-repo.ts `sumMonthlySpendCents()` SUMs cost over rows
//     WHERE record_type = 'agent_decomposer_bundled' for the current UTC month,
//     and agent-sessions refuses the turn once that sum reaches the cap.
//
// These are two INDEPENDENT string literals in two files (no shared constant).
// Each is pinned independently today (the recorder + repo content-parity tests),
// but nothing asserts the two are EQUAL. If the writer's literal is renamed —
// even with its own content-parity test updated in the same commit, as the
// drift-guard rule requires — the reader keeps filtering the OLD literal, the
// SUM silently returns 0, and the monthly cap is SILENTLY DISABLED. That is a
// direct money leak: the platform eats uncapped upstream Anthropic spend for
// every bundled-LLM customer, with no error and no failing test. This invariant
// fails the moment the writer and reader literals diverge.
//
// Second coupling pinned here: usage-repo's INTERNAL_RECORD_TYPES must INCLUDE
// the bundled literal, so bundled rows stay EXCLUDED from the customer-facing
// usage aggregation (otherwise the internal $0.10/turn bundled rows would leak
// into customers' own usage/billing views).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', '..', '..', 'apps/server/src');

function read(rel: string): string {
  return readFileSync(resolve(SRC, rel), 'utf8');
}

// WRITER: `const recordType = isBundled ? '<literal>' : 'agent_decomposer';`
// (`record_type` values are lowercase snake_case, optionally with digits — so a
// rename still EXTRACTS and trips the equality assertion cleanly, rather than
// throwing on a failed match.)
const WRITER_RE = /const recordType = isBundled \? '([a-z0-9_]+)' : 'agent_decomposer';/;
// READER (cap-query filter): `eq(usageRecords.recordType, '<literal>')`
const READER_RE = /eq\(usageRecords\.recordType, '([a-z0-9_]+)'\)/;
// usage-repo internal-types array body.
const INTERNAL_RE = /const INTERNAL_RECORD_TYPES = \[([^\]]*)\] as const;/;

function capture(src: string, re: RegExp, label: string): string {
  const m = src.match(re);
  if (m === null || m[1] === undefined) throw new Error(`could not extract ${label}`);
  return m[1];
}

describe('bundled-LLM record_type cross-source invariant (writer ↔ cap-query reader)', () => {
  const writerLiteral = capture(
    read('db/agent-decomposer-usage-recorder.ts'),
    WRITER_RE,
    'writer record_type',
  );
  const readerLiteral = capture(read('db/bundled-llm-repo.ts'), READER_RE, 'cap-query record_type');

  it('sanity — the writer tags bundled turns with the expected non-trivial literal', () => {
    expect(writerLiteral).toBe('agent_decomposer_bundled');
  });

  it('the bundled record_type the WRITER stamps is BYTE-IDENTICAL to the literal the cap-query READER filters on — a drift would silently disable the monthly soft-cap (cap-query SUMs 0) and leak uncapped Anthropic spend', () => {
    expect(readerLiteral).toBe(writerLiteral);
  });

  it("usage-repo's INTERNAL_RECORD_TYPES INCLUDES the bundled literal — keeps the internal bundled rows out of customers' own usage/billing aggregation", () => {
    const internalBody = capture(read('db/usage-repo.ts'), INTERNAL_RE, 'INTERNAL_RECORD_TYPES');
    expect(internalBody).toContain(`'${writerLiteral}'`);
  });
});
