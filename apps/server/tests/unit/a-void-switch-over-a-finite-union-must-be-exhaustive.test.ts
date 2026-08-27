// V-1917. A switch over a finite literal union, inside a function that returns
// nothing, has no compile-time protection of its own: there is no return
// obligation, so `noImplicitReturns` cannot see a missing case (V-1915), and
// without a `default` nothing else does either. A member added to the union
// then type-checks, reaches the dispatch, matches no case, and is dropped in
// silence — no throw, no log, no failing test.
//
// V-1916 measured that population and closed it. This keeps it closed: such a
// switch must carry a `default` that either asserts exhaustiveness against
// `never` or throws.
//
// Scope is deliberately narrow, and every exclusion is a shape the compiler
// already covers: a value-returning function is caught by `noImplicitReturns`,
// a `never`-returning one by TS2534, and a switch over a bare `string`
// legitimately needs a permissive default.
//
// Two performance notes, both load-bearing. The program is rooted at `src/`
// only (342 files, not the config's 2836) — the same 29 switches are visible
// either way, and it is three times cheaper. And each arm builds a program, so
// the arms are kept few and the timeout explicit: the first version of this
// file used the 10s default and passed alone while failing in the full suite,
// where CPU contention pushed four builds past it.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(HERE, '..', '..');
const SRC_DIR = resolve(SERVER_DIR, 'src');
const CONFIG = resolve(SERVER_DIR, 'tsconfig.test.json');
const SYNTHETIC = resolve(SRC_DIR, '__exhaustive_probe.ts');
const BUILD_TIMEOUT_MS = 60_000;
// Measured, not guessed: the walk saw 342 files and 25 finite-union switches on
// 2026-08-27. The floor sits well under the observed count so ordinary growth
// never moves it, while a collapse — a drifted SRC_DIR, an empty root list — is
// far below it and fails loudly.
const FLOOR_FILES = 270;

interface Offender {
  file: string;
  line: number;
  reason: string;
}

/**
 * Does this default clause actually refuse the unhandled member? Judged from AST
 * nodes, never from text: a clause whose only `throw` sits in a comment, or
 * inside a nested callback that this dispatch never invokes, does not refuse
 * anything and must not satisfy the guard.
 */
function refusesUnhandled(clause: ts.DefaultClause): boolean {
  let throws = false;
  let assertsNever = false;
  const walk = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    ) {
      return; // a nested function's throw belongs to that function, not to this clause
    }
    if (ts.isThrowStatement(node)) throws = true;
    if (
      ts.isVariableDeclaration(node) &&
      node.type !== undefined &&
      node.type.kind === ts.SyntaxKind.NeverKeyword
    ) {
      assertsNever = true;
    }
    ts.forEachChild(node, walk);
  };
  for (const statement of clause.statements) walk(statement);
  return throws || assertsNever;
}

/**
 * The offenders PLUS a census of what the walk actually looked at. The census
 * exists because `offenders: []` is the pass condition, and an empty walk
 * produces it just as readily as a clean tree: a drifted `SRC_DIR`, a program
 * rooted at nothing, or sources moved out of `src/` all yield zero offenders.
 * The synthetic arms cannot cover that — they analyse injected source text, so
 * they prove the MATCHER fires, never that discovery found a file.
 */
interface Scan {
  readonly offenders: Offender[];
  readonly filesScanned: number;
  readonly finiteUnionSwitches: number;
}

function findOffenders(extraFile?: { text: string }): Scan {
  const cfg = ts.parseConfigFileTextToJson(CONFIG, readFileSync(CONFIG, 'utf8'));
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, SERVER_DIR);
  const roots = parsed.fileNames.filter((f) => f.startsWith(`${SRC_DIR}/`));

  const host = ts.createCompilerHost(parsed.options);
  if (extraFile !== undefined) {
    const text = extraFile.text;
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
      name === SYNTHETIC
        ? ts.createSourceFile(name, text, languageVersion, true, ts.ScriptKind.TS)
        : original(name, languageVersion, onError, shouldCreate);
    const fileExists = host.fileExists.bind(host);
    host.fileExists = (name) => name === SYNTHETIC || fileExists(name);
    const readFileFn = host.readFile.bind(host);
    host.readFile = (name) => (name === SYNTHETIC ? text : readFileFn(name));
  }

  // A self-testing arm roots the program at its injected file ALONE: it judges
  // only that file, so pulling in src/ would cost ~5x (235ms vs ~1.1s measured)
  // and would let a real offender leak into a self-test's result.
  const program = ts.createProgram(
    extraFile === undefined ? roots : [SYNTHETIC],
    parsed.options,
    host,
  );
  const checker = program.getTypeChecker();
  const offenders: Offender[] = [];
  let filesScanned = 0;
  let finiteUnionSwitches = 0;

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (!sourceFile.fileName.startsWith(`${SRC_DIR}/`)) continue;
    filesScanned += 1;

    const visit = (node: ts.Node): void => {
      if (ts.isSwitchStatement(node)) {
        const subject = checker.getTypeAtLocation(node.expression);
        const parts = subject.isUnion() ? subject.types : [subject];
        const finiteUnion =
          parts.length > 1 && parts.every((p) => p.isStringLiteral() || p.isNumberLiteral());

        if (finiteUnion) {
          finiteUnionSwitches += 1;
          let fn: ts.Node | undefined = node.parent;
          while (
            fn !== undefined &&
            !ts.isFunctionDeclaration(fn) &&
            !ts.isFunctionExpression(fn) &&
            !ts.isArrowFunction(fn) &&
            !ts.isMethodDeclaration(fn)
          ) {
            fn = fn.parent;
          }
          let voidish = false;
          if (fn !== undefined) {
            const signature = checker.getSignatureFromDeclaration(fn);
            if (signature !== undefined) {
              const returned = checker.typeToString(checker.getReturnTypeOfSignature(signature));
              const bare = returned.replace(/^Promise<(.*)>$/, '$1');
              voidish = bare === 'void' || bare === 'undefined';
            }
          }

          if (voidish) {
            const clause = node.caseBlock.clauses.find(ts.isDefaultClause);
            if (clause === undefined || !refusesUnhandled(clause)) {
              const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              offenders.push({
                file: sourceFile.fileName.split(`${SERVER_DIR}/`)[1] ?? sourceFile.fileName,
                line: line + 1,
                reason:
                  clause === undefined ? 'no default clause' : 'default does not refuse the member',
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return { offenders, filesScanned, finiteUnionSwitches };
}

describe('a void switch over a finite union must be exhaustive', () => {
  it(
    'CRITICAL the walk actually enumerated the server sources',
    () => {
      const { filesScanned, finiteUnionSwitches } = findOffenders();
      expect(filesScanned).toBeGreaterThan(FLOOR_FILES);
      // The load-bearing half: this one proves the shape matcher engaged the
      // REAL tree. `filesScanned` alone still passes if the checker silently
      // stops resolving unions, which would make every switch look non-finite.
      expect(finiteUnionSwitches).toBeGreaterThan(0);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    'finds no unguarded dispatch in apps/server/src',
    () => {
      expect(findOffenders().offenders).toEqual([]);
    },
    BUILD_TIMEOUT_MS,
  );

  // The two arms below prove the MATCHER fires on every unguarded shape and on
  // none of the guarded ones. They do NOT prove the arm above looked at
  // anything: they root the program at an injected file, so discovery is out of
  // their reach entirely. The census arm is what covers that half.
  it(
    'accuses every shape that does not actually refuse, including comment-only exhaustiveness',
    () => {
      const found = findOffenders({
        text: `type K = 'a' | 'b';
export function noDefault(k: K): void { switch (k) { case 'a': break; case 'b': break; } }
export function silent(k: K): void { switch (k) { case 'a': break; default: break; } }
export function throwOnlyInAComment(k: K): void { switch (k) { case 'a': break; default: { /* we should throw here */ break; } } }
export function neverOnlyInAComment(k: K): void { switch (k) { case 'a': break; default: { /* const _e: never = k */ break; } } }
export function throwInsideANestedFn(k: K): void { switch (k) { case 'a': break; default: { const f = (): void => { throw new Error('x'); }; void f; break; } } }
`,
      });
      expect(found.offenders.map((o) => o.reason)).toEqual([
        'no default clause',
        'default does not refuse the member',
        'default does not refuse the member',
        'default does not refuse the member',
        'default does not refuse the member',
      ]);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    'accepts a never assertion, a throw, a value-returning function, and an open subject',
    () => {
      const found = findOffenders({
        text: `type K = 'a' | 'b';
export function marked(k: K): void { switch (k) { case 'a': break; default: { const _e: never = k; void _e; break; } } }
export function loud(k: K): void { switch (k) { case 'a': break; default: throw new Error('unhandled'); } }
export function returnsValue(k: K): string { switch (k) { case 'a': return 'x'; case 'b': return 'y'; } }
export function openSubject(s: string): void { switch (s) { case 'a': break; default: break; } }
`,
      });
      expect(found.offenders).toEqual([]);
    },
    BUILD_TIMEOUT_MS,
  );
});
