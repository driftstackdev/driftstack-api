// The hand-written header scanner, on input a compromised node controls.
//
// `readLargeDownloadResultHeader` exists so an ~85 MiB inbound frame can be
// correlated to a pending download WITHOUT `JSON.parse`. Its own header says why:
// keep the transport cap for real downloads "while preventing an
// authenticated-but-compromised node from repeatedly forcing near-cap
// Buffer→string→JSON.parse→Zod allocation on unsolicited frames". So the scanner
// is a lexer walking attacker-supplied bytes, and its instruction when anything
// is off is stated inline — "fail closed here rather than let a malformed
// oversized header reach the allocating parser".
//
// The existing gate tests cover what it ACCEPTS (field order, bounded escapes,
// whitespace, the decoded-id length bound) and the coarse rejections
// (nested-only, duplicate, wrong-type, trailing). What none of them reach is the
// lexer's own malformed-input edges — v8 shows ~28 uncovered branches, nearly all
// inside `jsonStringEnd` and `jsonValueEnd`. Those are exactly the branches a
// hostile sender controls, and each one is a distinct way to walk the cursor
// somewhere it should not go:
//
//   unterminated string      the scan runs to the end of the buffer looking for a
//                            closing quote that never comes.
//   raw control byte         a literal newline or NUL inside a JSON string is
//                            invalid; accepting it means the lexer and the real
//                            parser disagree about where the string ended.
//   truncated escape         a trailing backslash steps the cursor past the last
//                            byte.
//   bad \u escape            fewer than four hex digits, or non-hex ones.
//   nesting depth            an explicit `stack.length >= 64` cap — the guard
//                            against a deeply nested payload turning the "cheap"
//                            pre-parse scan into the expensive thing it exists to
//                            avoid.
//   mismatched closer        `[` closed by `}`; a lexer that shrugs at this
//                            resynchronises at the wrong offset and can read a
//                            correlation id out of an attacker-chosen position.
//
// Every arm below asserts `null`. A file of nothing but null assertions would
// pass against a function that always failed, so the first and last arms are
// positive controls: a well-formed header still correlates, and nesting just
// UNDER the cap is still accepted. Without those two, this file would be
// satisfied by `return null`.

import { describe, expect, it } from 'vitest';
import { readLargeDownloadResultHeader } from '../../src/services/fleet-inbound-frame-gate.js';

/** A well-formed correlated download header, as the happy path produces it. */
const VALID = '{"type":"downloadData","requestId":"rq_1","sessionId":"agt_1","dataB64":"AAAA"}';

const scan = (raw: string): { requestId: string; sessionId: string } | null =>
  readLargeDownloadResultHeader(Buffer.from(raw));

describe('fleet inbound header scanner fails closed', () => {
  it('CRITICAL a well-formed header still correlates (the control for every arm below)', () => {
    expect(
      scan(VALID),
      'the positive control failed, so the rejection arms below would pass against a scanner that ' +
        'rejects everything',
    ).toEqual({ requestId: 'rq_1', sessionId: 'agt_1' });
  });

  it('CRITICAL an unterminated string is rejected rather than scanned to the end', () => {
    expect(scan('{"type":"downloadData","requestId":"rq_1'), 'unterminated value').toBeNull();
    expect(scan('{"type":"downloadData","requestId'), 'unterminated key').toBeNull();
  });

  it('CRITICAL a raw control byte inside a SKIPPED string is rejected', () => {
    // Deliberately in a decoy field rather than in requestId. A control byte in
    // the id itself is rejected later by the id validator, so an arm placed there
    // proves nothing about THIS lexer — mutation showed exactly that: deleting the
    // `byte < 0x20` guard left such an arm green. In a SKIPPED value the guard is
    // the only thing that can reject, and without it the header correlates.
    expect(
      scan('{"type":"downloadData","decoy":"a\n b","requestId":"rq_1","sessionId":"agt_1"}'),
      'a raw control byte inside a skipped string was tolerated — the lexer and the real parser ' +
        'then disagree about where that string ended',
    ).toBeNull();
  });

  it('CRITICAL a backslash at the very end of the buffer is rejected', () => {
    // The escape branch steps the cursor forward; without the bounds check that
    // step lands past the last byte.
    expect(scan('{"type":"downloadData","requestId":"rq_1\\')).toBeNull();
  });

  it('CRITICAL a malformed \\u escape in a SKIPPED string is rejected', () => {
    // Same reasoning as the control-byte arm: in `requestId` a later validator
    // rejects it regardless, and mutation confirmed such an arm stays green when
    // the hex check is deleted. In a decoy the four-hex-digit rule is the only
    // thing standing between this and a successful correlation.
    expect(
      scan('{"type":"downloadData","decoy":"\\u00zz","requestId":"rq_1","sessionId":"agt_1"}'),
      'non-hex digits in a skipped \\u escape were accepted',
    ).toBeNull();
    expect(
      scan('{"type":"downloadData","decoy":"\\u001","requestId":"rq_1","sessionId":"agt_1"}'),
      'a three-digit \\u escape was accepted',
    ).toBeNull();
    expect(scan('{"type":"downloadData","decoy":"\\u00'), 'truncated at buffer end').toBeNull();
  });

  it('CRITICAL an unknown single-character escape is rejected', () => {
    // \" \\ \/ \b \f \n \r \t are the whole legal set.
    expect(scan('{"type":"downloadData","requestId":"rq\\x1","sessionId":"agt_1"}')).toBeNull();
  });

  it('CRITICAL nesting past the depth cap is rejected', () => {
    // 64 is the documented cap. The payload stays small — depth, not size, is
    // what this guard is about, and depth is the cheap way to make a linear scan
    // expensive.
    const deep = `{"type":"downloadData","decoy":${'['.repeat(70)}${']'.repeat(70)},"requestId":"rq_1","sessionId":"agt_1"}`;
    expect(
      scan(deep),
      'a payload nested past the cap was scanned anyway — the depth limit is what keeps this ' +
        'pre-parse scan cheap enough to be worth doing',
    ).toBeNull();
  });

  it('CRITICAL nesting just under the cap is still accepted', () => {
    // The other side of the same guard: 63 deep must still correlate, or the cap
    // is simply rejecting valid traffic.
    const deep = `{"type":"downloadData","decoy":${'['.repeat(60)}${']'.repeat(60)},"requestId":"rq_1","sessionId":"agt_1"}`;
    expect(scan(deep)).toEqual({ requestId: 'rq_1', sessionId: 'agt_1' });
  });

  it('CRITICAL a container closed by the wrong bracket is rejected', () => {
    expect(
      scan('{"type":"downloadData","decoy":[1,2},"requestId":"rq_1","sessionId":"agt_1"}'),
      'a lexer that shrugs at a mismatched closer resynchronises at the wrong offset and can read ' +
        'a correlation id from an attacker-chosen position',
    ).toBeNull();
    expect(scan('{"type":"downloadData","decoy":{"a":1],"requestId":"rq_1"}')).toBeNull();
  });

  it('CRITICAL an unterminated container is rejected', () => {
    expect(scan('{"type":"downloadData","decoy":[1,2,3')).toBeNull();
    expect(scan('{"type":"downloadData","decoy":{"a":')).toBeNull();
  });

  it('CRITICAL an empty bare value is rejected', () => {
    // `"decoy":,` — the value scan starts and immediately hits a delimiter.
    expect(
      scan('{"type":"downloadData","decoy":,"requestId":"rq_1","sessionId":"agt_1"}'),
    ).toBeNull();
  });
});
