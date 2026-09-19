// ⛔ EVERY DIRECT CHAT PROVIDER'S WIRE, BYTE FOR BYTE.
//
// The chat-completions adapter now speaks a second dialect for rows reached
// through OpenRouter: a routing object that pins the upstream, OpenRouter's
// unified reasoning control, and a cache marker for Anthropic-routed models.
// Each of those is a member added to a request body, and the same builder
// writes the bodies OpenAI, Google, Baseten, Fireworks, Cerebras, Mistral and
// Inception receive. A member that leaked into theirs would change what a
// measured arm sends — and every test that asserts on PART of a body would stay
// green.
//
// So `_helpers/chat-wire-corpus.ts` drives the real adapter, once per direct
// row, through a first plan, a sighted re-plan with credential names, a
// read-back, and both refused-control fallbacks, and records every request
// (URL, method, headers, redirect policy, body) and every result. That record
// was made against the adapter BEFORE the OpenRouter dialect existed
// (`recordedAgainst` names the source hash it came from) and is compared here.
//
// ⛔ RE-RECORDING IS A WIRE CHANGE, AND IS REVIEWED AS ONE:
//   CHAT_WIRE_GOLDEN_RECORD=1 <the usual vitest command> the-direct-chat-wire-does-not-move
// then read the fixture diff — it is exactly what those providers will receive
// differently.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  directChatRows,
  runChatWireCorpus,
  type RecordedChatCall,
} from './_helpers/chat-wire-corpus.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = resolve(HERE, '../_fixtures/chat-wire-golden.json');
const ADAPTER = resolve(HERE, '../../src/services/agent-decomposer-openai-compatible.ts');

interface Golden {
  /** sha256 of the adapter when the record was made. Provenance only. */
  recordedAgainst: string;
  calls: RecordedChatCall[];
}

describe('the direct chat wire does not move when OpenRouter is added', () => {
  it('CRITICAL every request body, header set and result the chat adapter produces for a DIRECT provider row is byte-identical to the recorded wire', async () => {
    const calls = await runChatWireCorpus();
    if (process.env.CHAT_WIRE_GOLDEN_RECORD === '1') {
      const golden: Golden = {
        recordedAgainst: createHash('sha256').update(readFileSync(ADAPTER)).digest('hex'),
        calls,
      };
      writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 1)}\n`, 'utf8');
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden;
    // Positive controls: the corpus covered every direct row, and really made
    // requests — an empty corpus would compare equal to an empty golden.
    expect(directChatRows().length).toBeGreaterThanOrEqual(8);
    const requests = calls.reduce((n, c) => n + c.requests.length, 0);
    expect(requests, 'the corpus made no provider requests').toBeGreaterThan(50);
    expect(calls.map((c) => c.name)).toEqual(golden.calls.map((c) => c.name));
    for (const [i, call] of calls.entries()) {
      const want = golden.calls[i]!;
      expect(call.requests.length, `${call.name}: number of requests`).toBe(want.requests.length);
      for (const [j, request] of call.requests.entries()) {
        const expected = want.requests[j]!;
        // Compared as a STRING first: member order and whitespace are part of
        // the cached prefix, and a failure should name the call.
        expect(request.body, `${call.name}: request ${String(j)} body`).toBe(expected.body);
        expect(request, `${call.name}: request ${String(j)}`).toEqual(expected);
      }
      expect(call.outcome, `${call.name}: outcome`).toEqual(want.outcome);
    }
  });
});
