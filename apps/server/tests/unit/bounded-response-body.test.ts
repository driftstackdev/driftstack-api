// `readBoundedResponseBody` guards the memory an upstream can make this process
// allocate. It is used by `stripe-api.ts`, `nowpayments-api.ts` and the OAuth
// client exchange — two payment providers and an identity provider, none of whom
// this process controls.
//
// Its two refusals ARE covered today, through those callers. What was not covered
// is the property the module's own doc comment leads with:
//
//   "The limit is measured in wire bytes, not UTF-16 string length, so
//    multi-byte input cannot evade the ceiling."
//
// Measured before writing this file. Rewriting the loop to count UTF-16 units
// after appending — identical behaviour for ASCII, which is all the existing
// fixtures use — passed all 46 tests across the three caller suites. So the
// stated defence could be removed and nothing would notice.
//
// It matters because the two counts diverge in the attacker's favour: a UTF-8
// character costs up to 4 wire bytes and as little as one UTF-16 unit, so a body
// counted in string length can carry several times the intended bytes. `é` is the
// cheapest demonstration at 2:1; a CJK or emoji payload widens it.
//
// This file also pins the parts a `throw`-site mutation cannot reach at all — the
// empty-body path and the streaming decoder — because neither refuses anything,
// so no refusal sweep will ever surface them.

import { describe, expect, it } from 'vitest';
import {
  ResponseBodyLimitError,
  readBoundedResponseBody,
} from '../../src/lib/bounded-response-body.js';

/** A response whose body arrives in chunks and carries no content-length. */
function streamed(chunks: Uint8Array[]): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      // Bind before enqueueing rather than asserting non-null: `noUncheckedIndexedAccess`
      // types `chunks[i]` as possibly undefined, and eslint --fix strips a `!` on
      // commit, so the assertion form type-checks locally and fails in CI.
      const chunk = chunks[i];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      i += 1;
    },
  });
  return new Response(stream, { status: 200 });
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('readBoundedResponseBody', () => {
  it('CRITICAL counts WIRE BYTES, not UTF-16 units, so multi-byte content cannot carry more bytes than the ceiling allows. 60 x "é" is 60 string units but 120 bytes; a length-based count would accept it under a 100-byte limit and allocate the extra.', async () => {
    const body = 'é'.repeat(60);
    // The premise, asserted rather than assumed: this payload is under the limit
    // by string length and over it by wire bytes. Without that gap the arm proves
    // nothing.
    expect(body.length).toBe(60);
    expect(new TextEncoder().encode(body).byteLength).toBe(120);

    await expect(readBoundedResponseBody(streamed([utf8(body)]), 100)).rejects.toBeInstanceOf(
      ResponseBodyLimitError,
    );
  });

  it('reads a body under the ceiling unchanged, so the guard is a ceiling and not a blanket refusal', async () => {
    const body = 'é'.repeat(20); // 40 wire bytes
    await expect(readBoundedResponseBody(streamed([utf8(body)]), 100)).resolves.toBe(body);
  });

  it('CRITICAL refuses on a declared content-length over the ceiling, before reading any of it', async () => {
    const response = new Response('{}', {
      status: 200,
      headers: { 'content-length': '999999' },
    });
    await expect(readBoundedResponseBody(response, 100)).rejects.toBeInstanceOf(
      ResponseBodyLimitError,
    );
  });

  it('CRITICAL reassembles a multi-byte character split across chunk boundaries, rather than decoding each chunk alone and yielding replacement characters. The streaming decoder is what makes byte-counting safe to combine with text output.', async () => {
    // U+20AC is three bytes; hand them over one at a time.
    const [a, b, c] = utf8('€');
    const text = await readBoundedResponseBody(
      streamed([new Uint8Array([a!]), new Uint8Array([b!]), new Uint8Array([c!])]),
      100,
    );
    expect(text).toBe('€');
    expect(text).not.toContain('�');
  });

  it('returns an empty string for a body-less response instead of throwing — a 204 or a HEAD is not a limit violation', async () => {
    const response = new Response(null, { status: 204 });
    expect(response.body).toBeNull();
    await expect(readBoundedResponseBody(response, 100)).resolves.toBe('');
  });

  it('carries the limit it enforced on the error, so a caller logging it can say which ceiling was hit', async () => {
    const error = await readBoundedResponseBody(streamed([utf8('x'.repeat(200))]), 100).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ResponseBodyLimitError);
    expect((error as ResponseBodyLimitError).maxBytes).toBe(100);
    expect((error as Error).message).toContain('100');
  });
});
