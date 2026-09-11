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
// literals and JSX text nodes are read, the scanner is checked against a
// positive control that must trip it (one arm per source of copy), and the
// offending lines are printed so a red is a reading list, not a number.
//
// (m) M2 — JSX TEXT is copy too. `<p>measured from a fleet Mac</p>` renders
// the sentence without a single quote mark, so a literal-only scan read the
// three .tsx surfaces as clean whatever their markup said. The text between a
// tag's `>` and the next `<` is scanned as well — as the TypeScript parser's
// own JsxText nodes, not a `>…<` regex: measured on ProxiesView, a regex
// admitted 200+ code runs (`} else {`, `): JSX.Element {`, a ternary between
// two JSX branches), several naming `verdict`/`vantage` as IDENTIFIERS, and
// no shape rule told those apart from a sentence. A `{…}` hole splits a text
// node as it splits the render. Its own positive control is below.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
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

/** (m) M2 — every JSX text node with its line, from the TypeScript parser:
 *  exactly the runs React renders as text (a `{…}` hole ends one and starts
 *  the next; a `{/* … *\/}` is an expression, never text; a comparison's `>`
 *  is an operator). The line is the one the TEXT starts on, not the tag's —
 *  a multi-line `<p>` reports where the sentence is. Reads the UNSTRIPPED
 *  source: the parser knows a comment from a text node better than a regex. */
function jsxTextNodes(src: string): Array<{ line: number; text: string }> {
  const sf = ts.createSourceFile(
    'surface.tsx',
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const out: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const raw = sf.text.slice(node.pos, node.end);
      const text = raw.trim();
      if (text.length > 0) {
        const lead = raw.length - raw.trimStart().length;
        out.push({ line: sf.getLineAndCharacterOfPosition(node.pos + lead).line + 1, text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Not copy: the internal wire query (`?vantage=fleet` names a URL parameter)
 *  and module paths in import specifiers (`'../lib/proxy-vantage'`). A customer
 *  sentence never starts with `./`, `../` or `@`. */
const ALLOWED = [/\?vantage=fleet/, /^['"`](\.{1,2}\/|@)[^'"`]*['"`]$/];

function jargonHits(src: string): Array<{ line: number; text: string }> {
  const literals = stringLiterals(stripComments(src)).filter(
    ({ text }) =>
      JARGON.some((re) => re.test(literalText(text))) && !ALLOWED.some((re) => re.test(text)),
  );
  const jsx = jsxTextNodes(src).filter(({ text }) => JARGON.some((re) => re.test(text)));
  return [...literals, ...jsx].sort((a, b) => a.line - b.line);
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

  // (m) M2 — the JSX-text arm of the control: the same terms with no quote
  // mark anywhere near them must trip the scanner; code that merely wears `>`
  // and `<` (an identifier named `verdict` in a ternary between two JSX
  // branches, a `data-latency-vantage=` attribute) must not, and a comment
  // inside JSX is still a comment.
  it('POSITIVE CONTROL — the scanner trips on jargon in JSX text nodes, split at {…} holes, and not on code between > and <', () => {
    const fixture = [
      'const a = <p>measured from a fleet Mac</p>;', // 1 — plain text node
      'const b = (', // 2
      '  <span>', // 3
      '    the {who} vantage', // 4 — the hole splits it; " vantage" is a node
      '  </span>', // 5
      ');', // 6
      'const c = x > verdict.count ? <b>fine</b> : <i>also {vantage.n}</i>;', // 7 — identifiers, not copy
      'const d = items.map((it) => <li key={it} data-latency-vantage={it}>{it}</li>);', // 8
      'const e = <p>{/* the fleet Mac is named in a JSX comment only */}clean</p>;', // 9
      'const f = <p>', // 10
      '  no verdict yet', // 11 — a multi-line node reports the line the TEXT starts on
      '</p>;', // 12
      "const g = <p title='the vantage'>ok</p>;", // 13 — a quoted attribute is the literal scan's
    ].join('\n');
    expect(jargonHits(fixture).map((h) => [h.line, h.text])).toEqual([
      [1, 'measured from a fleet Mac'],
      [4, 'vantage'],
      [11, 'no verdict yet'],
      [13, "'the vantage'"],
    ]);
  });

  for (const rel of SURFACES) {
    it(`CRITICAL ${rel} has no jargon in its string literals or JSX text`, () => {
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
