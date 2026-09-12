import { describe, expect, it } from 'vitest';
import { humanizeError } from '../../src/lib/humanize-error';
import { DriftstackError } from '../../src/lib/client';

describe('humanizeError', () => {
  it('maps browser transport failures to actionable connection copy', () => {
    expect(humanizeError(new TypeError('Failed to fetch'))).toBe(
      'Check your connection and try again.',
    );
    expect(humanizeError(new TypeError('fetch failed'))).toBe(
      'Check your connection and try again.',
    );
    expect(humanizeError(new Error('offline'))).toBe('Check your connection and try again.');
  });

  it('maps timeouts, verification failures, and HTTP classes without raw internals', () => {
    expect(humanizeError(new DOMException('aborted', 'AbortError'))).toContain('took too long');
    expect(humanizeError(new Error('signature mismatch: key id 7'))).toBe(
      "This download couldn't be verified. Try again later.",
    );
    expect(humanizeError(new Error('HTTP 503 upstream host 10.0.0.4'))).toBe(
      'The service is temporarily unavailable. Try again shortly.',
    );
  });

  it("⛔ names the verification failures that do NOT contain the word 'signature'", () => {
    // ADDITIVE arm (owner's 2026-09-12 updater row). Both strings are real
    // `tauri-plugin-updater` 2.10.1 output — its verifier errors are
    // `#[error(transparent)]`, so the customer sees the underlying Display —
    // and both used to reach the caller's generic fallback, which on the
    // update banner read "Update couldn't be installed. Try again." about a
    // bundle that could not be VERIFIED. Those are different facts and only
    // one of them is worth retrying.
    //
    // MUTATION RUN 2026-09-12 (restore verified byte-identical by sha256):
    // reverting the class to /signature|checksum|integrity|verif(?:y|ied|ication)/
    // — i.e. making humanizeError swallow these again — reds this arm at its
    // FIRST assertion (received the fallback), while the six sibling arms in
    // this file stay green. It also reds the banner's "a minisign failure is
    // NEVER retried" arm, so the pair was 2 failed | 13 passed.
    expect(humanizeError(new Error('Invalid encoding in minisign data'), 'fallback')).toBe(
      "This download couldn't be verified. Try again later.",
    );
    expect(humanizeError('Invalid symbol 33, offset 5.', 'fallback')).toBe(
      "This download couldn't be verified. Try again later.",
    );
    // ⛔ THE OTHER TWO DECODER SHAPES, which the first pass of this widening
    // still let fall through — i.e. the exact defect this row says it closed,
    // for the exact class it targeted. base64 0.22.1's `DecodeError` has four
    // Displays (base64-0.22.1/src/decode.rs:32-45) and the widening only caught
    // one of them, because it leaned on the literal token `base64` — which,
    // MEASURED, appears in NONE of the four (the variant is
    // `#[error(transparent)]` through the plugin, so the customer sees the
    // decoder's own text).
    expect(humanizeError('Invalid last symbol 61, offset 42.', 'fallback')).toBe(
      "This download couldn't be verified. Try again later.",
    );
    expect(humanizeError(new Error('Invalid input length: 21'), 'fallback')).toBe(
      "This download couldn't be verified. Try again later.",
    );
    // ⚠️ The boundary, held on purpose: a bare "Invalid padding" is too generic
    // to justify telling a customer their download could not be verified, so it
    // still takes the caller's fallback. Widening the class to it is a
    // deliberate decision, not a free win — this arm is what makes that visible.
    expect(humanizeError(new Error('Invalid padding'), 'fallback')).toBe('fallback');
  });

  it('⛔ does NOT claim an unverifiable download for a caller that merely says "base64"', () => {
    // ⛔ THE REGRESSION ARM. The updater row first widened this class by the bare
    // token `base64`, and this is a SHARED classifier with ~50 call sites —
    // including `main.tsx`, which funnels every unhandled rejection through it.
    // MEASURED 2026-09-12: two real in-tree messages carry the word, and both
    // came back as *"This download couldn't be verified. Try again later."* for a
    // customer pasting a WireGuard config. "Additive" means additive in
    // BEHAVIOUR FOR OTHER CALLERS, and a new token in a shared classifier is not.
    //
    // MUTATION RUN: restoring the `base64|` alternative reds both assertions
    // below and leaves the arm above green, because the decoder shapes are
    // matched by their own pattern rather than by the token.
    expect(humanizeError('PrivateKey is not a 44-char base64 key', 'CALLER-FALLBACK')).toBe(
      'CALLER-FALLBACK',
    );
    expect(humanizeError(new Error('data_base64 is not valid base64.'), 'CALLER-FALLBACK')).toBe(
      'CALLER-FALLBACK',
    );
  });

  it("names reqwest's own failures, which are the ONLY network text a Tauri download can produce", () => {
    // ADDITIVE arm (owner's 2026-09-12 updater row). The bundle is fetched in
    // RUST, not the webview, so none of the browser-fetch vocabulary above can
    // ever match a failed download: `Error::Reqwest` is `#[error(transparent)]`
    // and reqwest's `Display` writes only the kind plus ` for url (…)`, never its
    // source (reqwest-0.13.3/src/error.rs:236-284). MEASURED: all three used to
    // reach the caller's fallback, which on the update banner read "Update
    // couldn't be installed. Try again." for a dropped connection.
    for (const reason of [
      'error sending request for url (https://objects.githubusercontent.com/x)',
      'error decoding response body for url (https://objects.githubusercontent.com/x)',
      'request or response body error for url (https://objects.githubusercontent.com/x)',
    ]) {
      expect(humanizeError(reason, 'fallback'), reason).toBe(
        'Check your connection and try again.',
      );
    }
    // The boundary: reqwest's `builder error` is a programming fault on our side,
    // not a connection problem, and must not be dressed up as one.
    expect(humanizeError('builder error', 'fallback')).toBe('fallback');
  });

  it('uses task-specific fallback copy for unknown exceptions', () => {
    expect(humanizeError(new Error('SQLSTATE 23505'), "Couldn't save. Try again.")).toBe(
      "Couldn't save. Try again.",
    );
  });

  it('classifies typed API problems without reflecting remote problem prose', () => {
    const internal = new DriftstackError({
      kind: 'internal',
      status: 500,
      type: 'https://errors.driftstack.dev/internal',
      title: 'upstream failure on node 10.0.0.4',
      detail: 'request req_secret reached postgres://operator:password@db.internal',
    });
    const copy = humanizeError(internal, 'fallback');

    expect(copy).toBe('The service is temporarily unavailable. Try again shortly.');
    expect(copy).not.toContain('10.0.0.4');
    expect(copy).not.toContain('req_secret');
    expect(copy).not.toContain('postgres');
  });

  it('maps SDK kind aliases and payment status to fixed actionable copy', () => {
    expect(
      humanizeError({
        kind: 'validation',
        status: 422,
        message: 'selector parse failed at internal offset 71',
      }),
    ).toBe('Some information was not accepted. Check your input and try again.');
    expect(
      humanizeError({ kind: 'payment_required', status: 402, message: 'raw billing row' }),
    ).toBe('This action requires an active plan. Review Billing and try again.');
  });

  it('keeps transport errors on the connection classifier instead of API status copy', () => {
    const transport = Object.assign(new TypeError('Failed to fetch upstream 10.0.0.8'), {
      kind: 'transport',
      status: 0,
    });
    expect(humanizeError(transport)).toBe('Check your connection and try again.');
  });
});
