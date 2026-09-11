// (l) SOCKS5/chat audit — finding #11 (L8).
//
// Customer-facing Test-all and row copy leaned on internal jargon — "fleet
// Mac", "endpoint resolver", "verdict", "vantage" — that a first-time customer
// has no way to decode. The internal names stay in CODE (identifiers,
// comments, the `?vantage=fleet` wire query); this guard scans the STRING
// LITERALS of the surfaces the audit named (the grid, the card, the Test-all
// summary, and the lib modules whose sentences they render) and fails on any
// that carries one of the terms.
//
// ⛔ Scanner discipline (memory: a static scanner must refuse prose fixtures
// and its own header; a crude scanner generates candidates well and
// conclusions badly): comments are stripped BEFORE the scan, only quoted
// literals are read, the scanner is checked against a positive control that
// must trip it, and the offending lines are printed so a red is a reading
// list, not a number.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../src');
const SURFACES = [
  'views/ProxiesView.tsx',
  'components/ProfilePhoneCard.tsx',
  'components/ProxyCapabilities.tsx',
  'lib/proxy-vantage.ts',
  'lib/proxy-server-test.ts',
  'lib/proxy-check-copy.ts',
  'lib/account-proxies.ts',
];
const JARGON = [/fleet Mac/i, /endpoint resolver/i, /\bverdict\b/i, /\bvantage\b/i];

/** Strip line comments, block comments and JSX comment blocks, so a comment
 *  that NAMES the jargon (they all do) is never a hit. Newlines are kept, so
 *  a reported line number is the FILE's line, not the stripped text's. */
function stripComments(src: string): string {
  const keepLines = (m: string): string => m.replace(/[^\n]/g, '');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, keepLines)
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (m, lead: string) => lead + keepLines(m.slice(lead.length)));
}

/** A template literal's `${…}` holes are code, not copy (`verdict.ok ? … : …`
 *  picks a class name); only the literal text between them is read. */
function literalText(text: string): string {
  return text.startsWith('`') ? text.replace(/\$\{[^}]*\}/g, '') : text;
}

/** Every quoted string literal (single, double, template) with its line. */
function stringLiterals(src: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const re = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  for (const m of src.matchAll(re)) {
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ line, text: m[0] });
  }
  return out;
}

/** Not copy: the internal wire query (`?vantage=fleet` names a URL parameter)
 *  and module paths in import specifiers (`'../lib/proxy-vantage'`). A customer
 *  sentence never starts with `./`, `../` or `@`. */
const ALLOWED = [/\?vantage=fleet/, /^['"`](\.{1,2}\/|@)[^'"`]*['"`]$/];

function jargonHits(src: string): Array<{ line: number; text: string }> {
  return stringLiterals(stripComments(src)).filter(
    ({ text }) =>
      JARGON.some((re) => re.test(literalText(text))) && !ALLOWED.some((re) => re.test(text)),
  );
}

describe('#11 — the proxy surfaces carry no internal jargon in customer-facing strings', () => {
  it('POSITIVE CONTROL — the scanner trips on each term, and ignores comments', () => {
    const fixture = [
      "const a = 'measured from a fleet Mac';",
      'const b = "the endpoint resolver failed";',
      'const c = `no verdict yet`;',
      "const d = 'the vantage';",
      "// a comment naming the fleet Mac is not copy: 'fleet Mac'",
      "/* nor is a block comment: 'verdict' */",
      "const e = 'clean sentence';",
      "import { vantageLabel } from '../lib/proxy-vantage';",
      "import type { OsFingerprint } from './os-fingerprint-verdict';",
      "const f = 'sent to ?vantage=fleet';",
      "const g = `chip ${verdict.ok ? 'on' : 'off'}`;",
      'const h = `measured by the ${who} vantage`;',
    ].join('\n');
    // …and the line numbers are the fixture's own (the comments above `h`
    // are stripped without moving it).
    expect(jargonHits(fixture).map((h) => h.line)).toEqual([1, 2, 3, 4, 12]);
  });

  for (const rel of SURFACES) {
    it(`CRITICAL ${rel} has no jargon in its string literals`, () => {
      const src = readFileSync(resolve(ROOT, rel), 'utf8');
      expect(src.length).toBeGreaterThan(0);
      const hits = jargonHits(src);
      expect(
        hits.map((h) => `${rel}:${String(h.line)}: ${h.text}`).join('\n'),
        'internal jargon in a customer-facing string',
      ).toBe('');
    });
  }

  it('the sentences the audit named now read in the customer’s words', async () => {
    const vantage = await import('../../src/lib/proxy-vantage');
    expect(vantage.vantageLabel({ measuredFrom: 'fleet' }).label).toBe('from the test Mac');
    expect(vantage.vantageLabel({ measuredFrom: 'control_plane' }).title).toContain(
      'No test Mac was free',
    );
    const pst = await import('../../src/lib/proxy-server-test');
    expect(pst.SERVER_DID_NOT_ANSWER_NOTICE).toBe(
      'The server did not answer, so the tunnel was not tested. The last result stands — try again.',
    );
    expect(pst.ENDPOINT_MOVED_NO_VERDICT_NOTICE).toBe(
      'The server did not answer, so the tunnel was not tested. Endpoint moved; no result yet — try again.',
    );
    expect(pst.NO_VERDICT_YET_NOTICE).toBe('The server did not answer; no result yet — try again.');
  });
});
