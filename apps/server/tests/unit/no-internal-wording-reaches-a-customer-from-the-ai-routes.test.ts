// No internal wording reaches a customer from the AI routes.
//
// A customer reads three kinds of sentence from the AI routes: the `detail` of a
// typed problem, the `refuse_reason` of a turn that was declined, and the
// `notice` / `answer_unavailable` of a turn that ended short. Each must say what
// happened in the customer's terms and never name how the product is built.
//
// The sentence that prompted this: when the model provider was briefly
// unavailable, a turn came back as a `refuse` whose reason read 'agent layer
// temporarily unavailable; please retry'. "Agent layer" is a name for a part of
// the server.
//
// This sweeps every such sentence the message route and the turn runtime can
// produce. The sentences are FOUND, not listed: problem details are read out of
// every `new <Something>Error(` in the route (a bare `new Error(` never reaches a
// customer: it is answered as a generic 500), and the runtime's copy is imported
// from where it is defined. Each scan first proves it found sentences known to
// exist, because a scan that finds nothing passes every check below.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AI_BRIEFLY_UNAVAILABLE_REFUSE_REASON,
  TURN_LOOP_STOP_SENTENCES,
  stoppedTurnNotice,
} from '../../src/services/agent-runtime.js';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');
const ROUTE = codeOnly(readFileSync(resolve(SRC, 'routes/agent-sessions.ts'), 'utf8'));
const RUNTIME = codeOnly(readFileSync(resolve(SRC, 'services/agent-runtime.ts'), 'utf8'));

/**
 * Words for how the product is built. `node` is matched as infrastructure only:
 * "Node.js" is a runtime a customer uses. Ticket ids are a letter and digits
 * (V-123, W456); a port is a colon and four or five digits.
 */
const INTERNAL_WORDING: ReadonlyArray<[string, RegExp]> = [
  ['agent layer', /agent layer/i],
  ['fleet', /\bfleet\b/i],
  ['node', /\bnodes?\b(?!\.js)/i],
  ['harness', /\bharness\b/i],
  ['control plane', /control[- ]plane/i],
  ['observer', /\bobserver\b/i],
  ['vantage', /\bvantage\b/i],
  ['decomposer', /\bdecomposer\b/i],
  ['executor', /\bexecutor\b/i],
  ['planner', /\bplanner\b/i],
  ['runtime', /\bruntime\b/i],
  ['founder', /\bfounder\b/i],
  ['ticket id', /\b[VW]-?\d{2,}\b/],
  ['port number', /:\d{4,5}\b/],
];

function internalWordingIn(sentence: string): string[] {
  return INTERNAL_WORDING.filter(([, pattern]) => pattern.test(sentence)).map(([name]) => name);
}

/** The text of every string and template literal in a span of code, joined. */
function literalText(span: string): string {
  const parts: string[] = [];
  for (const m of span.matchAll(/'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    parts.push(m[1] ?? m[2] ?? '');
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** The sentence(s) passed to every `new <Name>Error(` — typed problems only. */
function problemSentences(code: string): Array<{ errorClass: string; sentence: string }> {
  const out: Array<{ errorClass: string; sentence: string }> = [];
  for (const m of code.matchAll(/new (\w+Error)\(/g)) {
    const open = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let end = open;
    while (end < code.length && depth > 0) {
      if (code[end] === '(') depth += 1;
      else if (code[end] === ')') depth -= 1;
      end += 1;
    }
    const sentence = literalText(code.slice(open, end - 1));
    if (sentence.length > 0) out.push({ errorClass: m[1] ?? '', sentence });
  }
  return out;
}

/** Every sentence the runtime assigns to the explanation of an unanswered question. */
function readbackUnavailableSentences(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(
    /readbackUnavailable(?:: string \| undefined)? =\s*([\s\S]*?);\n/g,
  )) {
    for (const lit of (m[1] ?? '').matchAll(
      /'((?:[^'\\\n]|\\.){20,})'|"((?:[^"\\\n]|\\.){20,})"/g,
    )) {
      out.push(lit[1] ?? lit[2] ?? '');
    }
  }
  return out;
}

describe('no internal wording reaches a customer from the AI routes', () => {
  it('CRITICAL the sentence for "the AI was briefly unavailable" says that, tells the customer to send the message again, and does not say "agent layer"', () => {
    expect(AI_BRIEFLY_UNAVAILABLE_REFUSE_REASON).toBe(
      'The AI is briefly unavailable, so nothing was done with this message. Send it again in a moment.',
    );
    expect(internalWordingIn(AI_BRIEFLY_UNAVAILABLE_REFUSE_REASON)).toEqual([]);
    // And it is the ONLY thing the runtime says for that case: no inline literal
    // beside it that could drift back.
    const inline = [...RUNTIME.matchAll(/refuseReason:\s*'([^']*)'/g)].map((m) => m[1]);
    expect(inline).toEqual(['']);
  });

  it('the scan finds the problem sentences it is there to read — an empty scan would pass everything below', () => {
    const found = problemSentences(ROUTE).map((p) => p.sentence);
    expect(found.length).toBeGreaterThan(80);
    for (const known of [
      'We could not confirm the stop just now. Try again in a moment.',
      'This agent session is still working on a previous request. Wait for it to finish, then try again.',
      'No Anthropic API key configured for this account.',
    ]) {
      expect(
        found.some((sentence) => sentence.includes(known)),
        `a sentence known to be in the route must survive the scan: ${known}`,
      ).toBe(true);
    }
    // The scanner can SEE internal wording when it is there, in each spelling.
    expect(internalWordingIn('agent layer temporarily unavailable; please retry')).toEqual([
      'agent layer',
    ]);
    expect(internalWordingIn('the fleet node behind the control-plane harness')).toEqual([
      'fleet',
      'node',
      'harness',
      'control plane',
    ]);
    expect(internalWordingIn('see W3216 on 10.0.0.4:8443')).toEqual(['ticket id', 'port number']);
    expect(internalWordingIn('Works from Node.js 20 and later.')).toEqual([]);
  });

  it('CRITICAL no typed problem the AI routes can answer names how the product is built', () => {
    const offenders = problemSentences(ROUTE)
      // A bare Error is answered as a generic 500 with fixed copy; its message is
      // for the log, never the customer.
      .filter((p) => p.errorClass !== 'Error')
      .map((p) => ({ ...p, words: internalWordingIn(p.sentence) }))
      .filter((p) => p.words.length > 0)
      .map((p) => `${p.errorClass}: [${p.words.join(', ')}] ${p.sentence.slice(0, 120)}`);
    expect(offenders).toEqual([]);
  });

  it('no sentence that ends a turn short names how the product is built: the loop’s stop sentences, the stopped-turn notices, and every reason a question went unanswered', () => {
    const stopSentences = Object.values(TURN_LOOP_STOP_SENTENCES);
    expect(stopSentences.length).toBeGreaterThanOrEqual(6);

    const intent = { kind: 'navigate', url: 'https://example.com/' } as const;
    const stoppedNotices = [
      stoppedTurnNotice({ stoppedDuring: 'answering', results: [], stepsPlanned: 0 }),
      stoppedTurnNotice({ stoppedDuring: 'planning', results: [], stepsPlanned: 0 }),
      stoppedTurnNotice({
        stoppedDuring: 'executing',
        results: [{ kind: 'success', intent, summary: 'ok' }],
        stepsPlanned: 3,
      }),
    ];

    const unanswered = readbackUnavailableSentences(RUNTIME);
    expect(
      unanswered.length,
      'the reasons a question went unanswered were found in the runtime',
    ).toBeGreaterThanOrEqual(6);
    expect(unanswered.some((s) => s.includes('could not read the page back'))).toBe(true);

    const offenders = [...stopSentences, ...stoppedNotices, ...unanswered]
      .map((sentence) => ({ sentence, words: internalWordingIn(sentence) }))
      .filter((s) => s.words.length > 0)
      .map((s) => `[${s.words.join(', ')}] ${s.sentence.slice(0, 120)}`);
    expect(offenders).toEqual([]);
  });
});
