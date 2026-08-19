// Length-bounding customer text without cutting a character in half.
//
// `s.slice(0, n)` counts UTF-16 code units. A bound landing between the two
// halves of an astral character — any emoji, and much of the CJK extension and
// historic-script range — keeps the high surrogate and drops its pair. The
// result is not a valid string, and what happens next depends on where it goes:
//
//   - Into stored/returned text it encodes to U+FFFD, so the customer's own
//     content comes back with a replacement character in it (measured on
//     `sanitizeTranscriptText`: 511 ASCII + an emoji produced a trailing lone
//     `\ud83d` that did not survive `Buffer.from(out, 'utf8')`).
//   - Into a RESPONSE HEADER it throws. Node's `setHeader` rejects it with
//     "Invalid character in header content", which is a 500 on a request the
//     customer controls: `reportUnknownRequestFields` echoes unknown field
//     names, truncated to 64 chars, into `X-Driftstack-Unknown-Fields`. A field
//     name carrying an emoji across that bound took the response down.
//
// This lives in `lib/` rather than beside its first caller because both a lib
// module and two services need it, and `lib/` may not import from `services/`.

/**
 * Slice `value` to at most `max` UTF-16 code units, never leaving a lone
 * surrogate at the end.
 *
 * Drops the orphaned half rather than keeping it: one character shorter is
 * correct where half a character is not. Text at or under the bound, and text
 * whose bound lands on a whole character, is returned unchanged.
 */
export function sliceWithoutSplittingSurrogate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** An unpaired surrogate — a high one with no low after, or a low with no high before. */
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Render caller-controlled text so it can be sent as a header value at all.
 *
 * V-950 — the note above describes the lone-surrogate case, and slicing safely
 * fixed only that. The bound was never the cause. Node accepts U+0000–U+00FF in a
 * header value and rejects **every** code point above it, so a whole emoji, or a
 * field name in any non-Latin script, throws `ERR_INVALID_CHAR` with no truncation
 * involved at all — as do CR, LF and NUL, which is the header-injection attempt
 * the same throw happens to block. Measured, not assumed: U+00FF is accepted and
 * U+0100 is not.
 *
 * A 500 on a mistyped field is worse than the silence the reporting replaced, and
 * `unknown-request-fields.ts` promises the opposite in as many words — "the request
 * still succeeds exactly as before … no existing integration can break on it".
 *
 * Percent-encoding rather than stripping, for three reasons. The output alphabet is
 * `A-Za-z0-9-_.!~*'()` plus `%XX`, all inside the accepted range, so it is safe by
 * construction rather than by a blocklist that has to stay complete. An ASCII field
 * name — every real one in this API — passes through unchanged, so the header a
 * developer reads is the name they mistyped. And a comma inside a field name becomes
 * `%2C`, which the previous rendering would have let masquerade as the separator
 * between two reported keys.
 *
 * Unpaired surrogates are replaced first: `encodeURIComponent` throws `URIError` on
 * one, which would make this sanitiser fail exactly the way it exists to prevent.
 */
export function headerSafeText(value: string): string {
  return encodeURIComponent(value.replace(UNPAIRED_SURROGATE, '�'));
}
