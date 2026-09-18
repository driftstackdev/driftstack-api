// ⛔ THE CLAUDE ADAPTER'S WIRE, BYTE FOR BYTE.
//
// The provider-neutral half of the planner — both prompts, both reply schemas,
// the envelope parsing and its limits, the AUP pre-filter, the budget
// pre-check, the transcript window and the turn assembly — lives in
// `agent-planner-contract.ts`, so that a second provider's adapter plans from
// the same words and is held to the same parser. It used to live inside the
// Claude adapter. A move like that is the refactor most likely to change what
// production sends without any test noticing, because nearly every other test
// asserts on a PART of a request: a changed newline inside the system prompt,
// a reordered JSON member, a cache marker on a different block — each of those
// silently re-writes the whole prompt cache for every session, or changes what
// the model is told, and every partial assertion stays green.
//
// So `_helpers/claude-wire-corpus.ts` drives the real adapter through a fixed
// set of calls — first plan, continue, re-plan, answer, with and without an
// observation, with credential names, over every registered model, through the
// schema and thinking fallbacks, and across the reply shapes the parser must
// handle — and records every request (URL, method, headers, redirect policy,
// body) and every result. That record was made against the adapter BEFORE the
// extraction (`recordedAgainst` below names the source hash it came from) and
// is compared here with the adapter as it is now.
//
// ⛔ RE-RECORDING IS A WIRE CHANGE, AND IS REVIEWED AS ONE. When a prompt or a
// request member changes ON PURPOSE, re-record with
//   CLAUDE_WIRE_GOLDEN_RECORD=1 <the usual vitest command> the-claude-wire-does-not-move
// and read the fixture diff: it is exactly what production will send
// differently. A diff you did not intend is the defect this file exists for.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runClaudeWireCorpus, type RecordedCall } from './_helpers/claude-wire-corpus.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = resolve(HERE, '../_fixtures/claude-wire-golden.json');
const ADAPTER = resolve(HERE, '../../src/services/agent-decomposer-claude.ts');

interface Golden {
  /** sha256 of agent-decomposer-claude.ts when the record was made. Provenance
   *  only: the comparison is on the recorded wire, never on this hash. */
  recordedAgainst: string;
  calls: RecordedCall[];
}

describe('the Claude wire does not move when the planner contract moves', () => {
  it('CRITICAL every request body, header set and result the Claude adapter produces is byte-identical to the recorded wire', async () => {
    const calls = await runClaudeWireCorpus();
    if (process.env.CLAUDE_WIRE_GOLDEN_RECORD === '1') {
      const golden: Golden = {
        recordedAgainst: createHash('sha256').update(readFileSync(ADAPTER)).digest('hex'),
        calls,
      };
      writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 1)}\n`, 'utf8');
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden;
    // Positive control: the corpus really exercised the wire. A corpus that
    // quietly made no requests would compare equal to a golden that made none.
    const requests = calls.reduce((n, c) => n + c.requests.length, 0);
    expect(requests, 'the corpus made no provider requests').toBeGreaterThan(40);
    expect(calls.map((c) => c.name)).toEqual(golden.calls.map((c) => c.name));
    for (const [i, call] of calls.entries()) {
      const want = golden.calls[i]!;
      expect(call.requests.length, `${call.name}: number of requests`).toBe(want.requests.length);
      for (const [j, request] of call.requests.entries()) {
        const expected = want.requests[j]!;
        // The body is compared as a STRING — member order and whitespace are
        // part of the cached prefix — and first, so a failure names the call.
        expect(request.body, `${call.name}: request ${String(j)} body`).toBe(expected.body);
        expect(request, `${call.name}: request ${String(j)}`).toEqual(expected);
      }
      expect(call.outcome, `${call.name}: outcome`).toEqual(want.outcome);
    }
  });
});
