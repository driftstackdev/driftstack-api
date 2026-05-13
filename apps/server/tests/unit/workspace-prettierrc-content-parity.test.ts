// W538.C — drift guard for /.prettierrc.json (workspace root).
// Prettier formatting config — applied by every workspace via root
// `prettier --write .` script + lint-staged hook. Drift here either
// changes the printWidth (would reformat every file in the next
// `prettier --write` run, creating a massive churn commit), the
// quote style (would diverge from the eslint-config single-quote
// rule), or the EOL (would flip every file's line endings).
//
//   • semi: true (semicolons required).
//   • singleQuote: true (matches @typescript-eslint/quotes posture).
//   • trailingComma: 'all' (matches strict-mode TS strictest preference).
//   • printWidth: 100 (V-NNN line-length budget — wider than 80 to
//     reduce wrapping in test descriptions).
//   • tabWidth: 2 + useTabs: false (2-space indentation).
//   • arrowParens: 'always' (always-parenthesise arrow args).
//   • endOfLine: 'lf' (Unix line endings — cross-OS safe).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, '.prettierrc.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W538.C /.prettierrc.json content parity', () => {
  const body = read(LIB);
  const json = JSON.parse(body) as {
    semi: boolean;
    singleQuote: boolean;
    trailingComma: string;
    printWidth: number;
    tabWidth: number;
    useTabs: boolean;
    arrowParens: string;
    endOfLine: string;
  };

  it("8-key formatting config framing pinned: 'semi: true' (semicolons required — drift would flip every statement-end) + 'singleQuote: true' (matches eslint-config single-quote-style — drift to false would clash with eslint's @typescript-eslint/quotes if it were enabled) + 'trailingComma: \"all\"' (TS strictest preference — drift to 'es5' or 'none' would force trailing-comma rewrites on tuple types + arrow-fn last-arg) + 'printWidth: 100' (wider than 80 to reduce wrapping in long test descriptions and 'pinned so the X commitment survives' explanatory strings) + 'tabWidth: 2' + 'useTabs: false' + 'arrowParens: \"always\"' (always-parens — drift to 'avoid' would let single-arg arrows skip parens, hurting refactor consistency) + 'endOfLine: \"lf\"' (Unix LF — cross-OS safe, drift to 'crlf' would break Linux CI on Windows-created branches) — pinned so the full 8-key formatting commitment survives (drift to printWidth would reformat 10,000+ files on next prettier-write)", () => {
    expect(json.semi).toBe(true);
    expect(json.singleQuote).toBe(true);
    expect(json.trailingComma).toBe('all');
    expect(json.printWidth).toBe(100);
    expect(json.tabWidth).toBe(2);
    expect(json.useTabs).toBe(false);
    expect(json.arrowParens).toBe('always');
    expect(json.endOfLine).toBe('lf');
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
