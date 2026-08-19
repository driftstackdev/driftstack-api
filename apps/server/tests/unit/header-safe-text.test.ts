// V-950 — the sanitiser that lets caller-controlled text be a header value.
//
// `bounded-text.ts` already carried a note about this class: a bound landing
// between the halves of an astral character leaves a lone surrogate, and "into a
// RESPONSE HEADER it throws … A field name carrying an emoji across that bound
// took the response down". Slicing without splitting fixed that one case.
//
// The bound was never the cause. Node accepts U+0000–U+00FF in a header value and
// rejects every code point above it, so an emoji or a CJK field name **well under**
// the bound throws just the same, and so do CR, LF and NUL. The integration test
// beside this one proves the resulting 500 through a real route; these arms pin the
// properties of the rendering itself, which is where the guarantee has to live.
//
// The interesting arm is the last one. `encodeURIComponent` throws `URIError` on an
// unpaired surrogate, and `JSON.parse('{"a\\ud800b":1}')` produces exactly that —
// so the naive fix fails on the same input as the bug, and the replacement step is
// not decoration.

import { describe, expect, it } from 'vitest';
import { headerSafeText, sliceWithoutSplittingSurrogate } from '../../src/lib/bounded-text.js';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const NUL = String.fromCharCode(0);
const HIGH = String.fromCharCode(0xd800);
const LOW = String.fromCharCode(0xdc00);

/**
 * Printable ASCII. Node accepts a wider range in a header value — measured,
 * U+0000-U+00FF minus CR/LF/NUL — but percent-encoding emits only
 * `A-Za-z0-9-_.!~*'()` and `%XX`, so the tighter set is the one to assert: it
 * fails if the encoding ever lets something new through, rather than only when
 * Node would already have refused it.
 */
const SENDABLE = /^[\x20-\x7E]*$/;

describe('V-950 headerSafeText', () => {
  it('CRITICAL an ASCII field name is returned unchanged. This is the whole point of encoding rather than stripping: the header a developer reads has to be the name they actually mistyped, or the report tells them nothing.', () => {
    for (const name of ['archetyp', 'nam', 'time_zone', 'a.b-c_d', 'x1']) {
      expect(headerSafeText(name), `${name} passes through`).toBe(name);
    }
  });

  it('CRITICAL every input Node refuses in a header value comes back inside the sendable set. Asserted as a property over the whole output rather than case by case — a blocklist of known-bad characters is how the previous fix came to cover only lone surrogates.', () => {
    const hostile = [
      `a${CR}${LF}x-injected: yes`,
      `a${LF}b`,
      `a${CR}b`,
      `a${NUL}b`,
      String.fromCodePoint(0x1f642),
      String.fromCodePoint(0x4e0d, 0x660e),
      String.fromCharCode(0x100),
      `a${HIGH}b`,
      `a${LOW}b`,
      HIGH,
      LOW,
      `${HIGH}${LOW}`,
      'a,b',
      '%',
      '',
    ];
    for (const input of hostile) {
      const out = headerSafeText(input);
      expect(SENDABLE.test(out), `output for ${JSON.stringify(input)} is sendable: ${out}`).toBe(
        true,
      );
      expect(out, 'no CR').not.toContain(CR);
      expect(out, 'no LF').not.toContain(LF);
      expect(out, 'no NUL').not.toContain(NUL);
    }
  });

  it('CRITICAL a comma inside a field name cannot pass for the separator between two reported keys. The header joins names with commas, so an un-encoded comma in one name reads as two names — a caller could make the report describe fields nobody sent.', () => {
    expect(headerSafeText('a,b')).toBe('a%2Cb');
    expect(headerSafeText('a,b'), 'no bare comma survives').not.toContain(',');
  });

  it('CRITICAL an unpaired surrogate does not throw. encodeURIComponent raises URIError on one, and JSON.parse yields one from "\\ud800" without complaint, so the naive form of this fix breaks on the same input as the defect. Each is asserted individually because a single try/catch would make all of them look handled.', () => {
    for (const [label, input] of [
      ['lone high', `a${HIGH}b`],
      ['lone low', `a${LOW}b`],
      ['high at end', `ab${HIGH}`],
      ['low at start', `${LOW}ab`],
      ['two highs', `${HIGH}${HIGH}`],
    ] as const) {
      expect(() => headerSafeText(input), `${label} must not throw`).not.toThrow();
    }
    // A VALID pair is not mangled — the replacement targets unpaired halves only.
    expect(headerSafeText(`${HIGH}${LOW}`)).toBe(encodeURIComponent(`${HIGH}${LOW}`));
  });

  it('CRITICAL truncation happens before encoding, and the two compose without producing a lone surrogate. This is the case the module note was written about; it still has to hold, and it is the one place the two helpers depend on each other.', () => {
    const emoji = String.fromCodePoint(0x1f642);
    // A bound landing mid-character: 63 ASCII chars then an emoji, cut at 64.
    const value = `${'a'.repeat(63)}${emoji}`;
    const sliced = sliceWithoutSplittingSurrogate(value, 64);
    expect(sliced.length, 'the orphaned half was dropped').toBe(63);
    expect(() => headerSafeText(sliced)).not.toThrow();
    expect(SENDABLE.test(headerSafeText(sliced))).toBe(true);
  });
});
