// N-COOKIE-ERROR-CONTRACT — the customer sentence for each cookie error token.
//
// The customer used to be shown opaque harness prose, and the contract doc
// described tokens no code produced. This module is the CP half of the fix agreed
// with A3: the harness emits a closed token set in the result's `error` field, and
// the sentence is derived HERE so A3 can reword their side freely without changing
// what a customer reads. Same shape as agent-intent-result's copy derivation.
//
// ⛔ THE DISTINCTIONS ARE THE POINT, not the wording:
//
//   `unsupported` is a CAPABILITY condition — that box has no cookie-import
//   extension, so a retry can NEVER succeed. Telling the customer to try again is
//   the wrong instruction, which is why it does not share copy with `write_failed`.
//
//   `too_large` says REFUSED, not truncated. The harness estimates the jar before
//   encoding and declines to stream it, so nothing partial was written. A customer
//   who believes it was truncated goes hunting for partial state that does not
//   exist — a worse outcome than the error itself.

import type { CookieErrorToken } from '../schemas/harness-control-protocol.js';

const COPY: Readonly<Record<CookieErrorToken, string>> = {
  no_session: 'That session is no longer running. Start a new session and try again.',
  too_large:
    "This page's cookie jar is too large to transfer. It was refused rather than shortened, so nothing partial was read — narrow the page or clear some cookies first.",
  read_failed: 'The device could not read this session’s cookies. Try again in a moment.',
  unsupported:
    'This device cannot set cookies — the capability ships with a device update. Retrying will not help; use a session on an updated device.',
  write_failed: 'The device could not write these cookies. Try again in a moment.',
  unknown: 'The device reported a cookie error this version does not recognise.',
};

/** The customer-facing sentence for a token. Never returns harness text. */
export function cookieErrorCopy(token: CookieErrorToken): string {
  return COPY[token];
}
