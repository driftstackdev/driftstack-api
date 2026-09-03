// V-923 — several guards decide what a customer-facing page may claim by asking
// whether something is IMPLEMENTED, using a regex over the server source tree.
// A comment is not an implementation, so a gate whose pattern matches only
// comments is answering the wrong question — and always answers yes.
//
// Two instances existed and both are fixed. V-917: the egress gate matched any
// mention of SOCKS5, which `lib/webhook-target-guard.ts` satisfies while blocking
// proxy schemes as SSRF targets. V-921: the mTLS gate matched three files that
// contain no implementation at all — two comments and an OpenAPI description
// string about the operator fleet edge. Both had already retired silently, and
// in both cases the page happened to be correct, so nothing surfaced it.
//
// This guard recomputes the property rather than pinning today's patterns: for
// every source-scanning gate in the repo, at least one match of its pattern must
// be in executable code, OR no match may be in a comment.
//
// The `code === 0 && comment > 0` shape is the rule, and it was chosen by
// calibration rather than by taste. A stricter "matches ONLY comments" rule was
// tried first and would have MISSED V-921 — that gate scores 4 comment hits and
// 1 string hit (the OpenAPI description), so the single string exonerated it.
// Meanwhile route-registration gates legitimately match string literals only
// (`app.get('/v1/sessions'`) and score comment=0, so they pass. Strings and
// comments had to be separated: an earlier version lumped them together and
// reported three route-path gates as defects.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// A whole-tree walker: this reads every gate/source file in the repo, so its
// elapsed time tracks machine load, not the code under test. On the shared
// production box the gate now targets, baseline contention is irreducible, and
// the default 10s wall clock turns a scheduler-starved run into a false red —
// measured 1.6s alone, 35s under `nice` + peer load. The census assertions in
// this file (the discovery floor and the non-vacuity checks) are what detect a
// walk that stopped finding things; giving the clock room to absorb contention
// costs no coverage. Same rule as V-1975 / route-auth-coverage-invariant.
vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SELF = 'a-source-gate-may-not-be-satisfied-by-a-comment.test.ts';

/** Source roots a gate may scan, by the constant name the gate file uses. */
const KNOWN_ROOTS: Readonly<Record<string, string>> = {
  SERVER_SRC: 'apps/server/src',
};

const enum Kind {
  Code = 0,
  Str = 1,
  Comment = 2,
  Regex = 3,
}

/** Per-character lexical kind: code, string/template, comment, or regex body. */
function kindMask(src: string): number[] {
  const mask = new Array<number>(src.length).fill(Kind.Code);
  const n = src.length;
  let i = 0;
  let kind: number = Kind.Str;
  const mark = (): void => {
    mask[i] = kind;
    i += 1;
  };
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      kind = Kind.Comment;
      while (i < n && src[i] !== '\n') mark();
      kind = Kind.Str;
      continue;
    }
    if (c === '/' && next === '*') {
      kind = Kind.Comment;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) mark();
      mark();
      mark();
      kind = Kind.Str;
      continue;
    }
    if (c === "'" || c === '"') {
      mark();
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') mark();
        if (i < n) mark();
      }
      mark();
      continue;
    }
    if (c === '`') {
      mark();
      while (i < n) {
        if (src[i] === '\\') {
          mark();
          mark();
          continue;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          mark();
          mark();
          let depth = 1;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth += 1;
            else if (src[i] === '}') {
              depth -= 1;
              if (depth === 0) {
                mark();
                break;
              }
            }
            i += 1;
          }
          continue;
        }
        if (src[i] === '`') {
          mark();
          break;
        }
        mark();
      }
      continue;
    }
    if (c === '/') {
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j] as string)) j -= 1;
      const prev = j >= 0 ? (src[j] as string) : '';
      if (
        prev === '' ||
        '(,=:[!&|?{};+*%~^-'.includes(prev) ||
        /\b(?:return|typeof)$/.test(src.slice(Math.max(0, j - 7), j + 1))
      ) {
        kind = Kind.Regex;
        mark();
        let inClass = false;
        while (i < n) {
          if (src[i] === '\\') {
            mark();
            mark();
            continue;
          }
          if (src[i] === '[') inClass = true;
          else if (src[i] === ']') inClass = false;
          else if (src[i] === '/' && !inClass) {
            mark();
            break;
          } else if (src[i] === '\n') break;
          mark();
        }
        kind = Kind.Str;
        continue;
      }
    }
    i += 1;
  }
  return mask;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

/**
 * Per-root source + lexical mask, read and computed ONCE.
 *
 * `classify` is called once per gate pattern — 16 times on the current roster —
 * and every call used to re-walk the root, re-read all 342 files and re-run
 * `kindMask` (a per-character state machine) over 4.4 MB. That is 5,472 reads and
 * ~70 MB of lexing per run to answer 16 questions about the same unchanged bytes.
 *
 * The pair depends only on the file, never on the pattern, so it is computed on
 * the first call and reused. V-1933/V-1934 recorded this test as the suite's
 * heaviest reader and its repeat timeout victim under machine saturation; this is
 * that cost, removed rather than accommodated with a larger timeout.
 */
const maskedRoots = new Map<string, ReadonlyArray<{ src: string; mask: number[] }>>();

function maskedFiles(rootAbs: string): ReadonlyArray<{ src: string; mask: number[] }> {
  const cached = maskedRoots.get(rootAbs);
  if (cached !== undefined) return cached;
  const built = tsFiles(rootAbs).map((f) => {
    const src = readFileSync(f, 'utf8');
    return { src, mask: kindMask(src) };
  });
  maskedRoots.set(rootAbs, built);
  return built;
}

/** Where a pattern's matches live across a source tree. */
function classify(root: string, source: string, flags: string): { code: number; comment: number } {
  let code = 0;
  let comment = 0;
  for (const { src, mask } of maskedFiles(resolve(REPO_ROOT, root))) {
    const re = new RegExp(source, flags.includes('g') ? flags : `${flags}g`);
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      const kinds = new Set<number>();
      for (let k = m.index; k < m.index + m[0].length; k += 1) kinds.add(mask[k] as number);
      if (kinds.has(Kind.Code)) code += 1;
      else if (kinds.has(Kind.Comment)) comment += 1;
    }
  }
  return { code, comment };
}

/** Test files defining a `(re: RegExp) => boolean` source scanner. */
function gateFiles(): string[] {
  const out: string[] = [];
  for (const app of ['apps', 'packages']) {
    for (const f of tsFiles(resolve(REPO_ROOT, app))) {
      if (!f.endsWith('.test.ts') || f.endsWith(SELF)) continue;
      const body = readFileSync(f, 'utf8');
      if (!/function\s+\w+\(re: RegExp\)\s*:\s*boolean/.test(body)) continue;
      if (!/re\.test\(readFileSync/.test(body)) continue;
      out.push(f);
    }
  }
  return out;
}

describe('V-923 a source gate may not be satisfied by a comment', () => {
  it('CRITICAL every source-scanning gate in the repo is discovered AND its root resolves. A gate whose root this cannot resolve would be skipped silently, so it fails here instead — that is the difference between a guard that covers the class and one that covers the files it happened to know about.', () => {
    const files = gateFiles();
    expect(files.length, 'test files defining a source-tree regex scanner').toBeGreaterThanOrEqual(
      8,
    );
    const unresolved = files.filter((f) => {
      const body = readFileSync(f, 'utf8');
      return !Object.keys(KNOWN_ROOTS).some((name) => body.includes(name));
    });
    expect(
      unresolved.map((f) => f.slice(REPO_ROOT.length + 1)),
      'these define a source scanner over a root this guard cannot resolve — add it to KNOWN_ROOTS:',
    ).toEqual([]);
  });

  it('CRITICAL no gate pattern is answered only by a comment. These gates decide what a marketing or trust page may claim about a shipped capability; a comment mentioning the feature is not the feature. Route-registration gates legitimately match string literals only and are unaffected, which is why strings and comments are counted separately.', () => {
    const offenders: string[] = [];
    for (const file of gateFiles()) {
      const body = readFileSync(file, 'utf8');
      const rootName = Object.keys(KNOWN_ROOTS).find((name) => body.includes(name));
      if (rootName === undefined) continue; // reported by the arm above
      const root = KNOWN_ROOTS[rootName] as string;
      const helper = /function\s+(\w+)\(re: RegExp\)/.exec(body)?.[1];
      if (helper === undefined) continue;
      const calls = new RegExp(`${helper}\\(\\s*/((?:[^/\\\\\\n]|\\\\.)+)/([gimsuy]*)`, 'g');
      for (const m of body.matchAll(calls)) {
        const { code, comment } = classify(root, m[1] as string, m[2] ?? '');
        if (code === 0 && comment > 0) {
          offenders.push(
            `${file.slice(REPO_ROOT.length + 1)} :: /${m[1] ?? ''}/ (code=${String(code)}, comment=${String(comment)})`,
          );
        }
      }
    }
    expect(
      offenders,
      'these gates are satisfied by prose rather than by an implementation:',
    ).toEqual([]);
  });
});
