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
