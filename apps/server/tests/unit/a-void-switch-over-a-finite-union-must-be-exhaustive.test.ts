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
// Scope is deliberately narrow. A value-returning function is already covered
// by noImplicitReturns; a switch over an open type (a bare `string`) legitimately
// needs a permissive default; and a function returning `never` is protected by
// TS2534. Only the void-ish + finite-union combination is unguarded, so only it
// is required here.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(HERE, '..', '..');
const CONFIG = resolve(SERVER_DIR, 'tsconfig.test.json');

interface Offender {
  file: string;
  line: number;
  reason: string;
}

/** Analyse a program and return every void-ish switch over a finite union whose
 *  default does not assert exhaustiveness. `extraFile` lets the self-tests below
 *  inject a synthetic source without touching the repo. */
function findOffenders(extraFile?: { name: string; text: string }): Offender[] {
  // When a synthetic file is injected the caller is self-testing the detector, so
  // only that file is judged: a real offender in src/ must not red a self-test arm
  // and disguise itself as a detector failure.
  const cfg = ts.parseConfigFileTextToJson(CONFIG, readFileSync(CONFIG, 'utf8'));
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, SERVER_DIR);

  const host = ts.createCompilerHost(parsed.options);
  if (extraFile !== undefined) {
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
      name === extraFile.name
        ? ts.createSourceFile(name, extraFile.text, languageVersion, true, ts.ScriptKind.TS)
        : original(name, languageVersion, onError, shouldCreate);
    const fileExists = host.fileExists.bind(host);
    host.fileExists = (name) => name === extraFile.name || fileExists(name);
    const readFile = host.readFile.bind(host);
    host.readFile = (name) => (name === extraFile.name ? extraFile.text : readFile(name));
  }

  const roots = extraFile === undefined ? parsed.fileNames : [...parsed.fileNames, extraFile.name];
  const program = ts.createProgram(roots, parsed.options, host);
  const checker = program.getTypeChecker();
  const offenders: Offender[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const isSynthetic = extraFile !== undefined && sourceFile.fileName === extraFile.name;
    if (!isSynthetic && !sourceFile.fileName.includes(`${resolve(SERVER_DIR, 'src')}/`)) continue;

    const visit = (node: ts.Node): void => {
      if (ts.isSwitchStatement(node)) {
        const subject = checker.getTypeAtLocation(node.expression);
        const parts = subject.isUnion() ? subject.types : [subject];
        const finiteUnion =
          parts.length > 1 && parts.every((p) => p.isStringLiteral() || p.isNumberLiteral());

        if (finiteUnion) {
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
            const body = clause?.getText().replace(/\s+/g, ' ') ?? '';
            const exhaustive = /:\s*never\s*=/.test(body) || /\bthrow\b/.test(body);
            if (!exhaustive) {
              const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              offenders.push({
                file: sourceFile.fileName.split(`${SERVER_DIR}/`)[1] ?? sourceFile.fileName,
                line: line + 1,
                reason:
                  clause === undefined ? 'no default clause' : 'default does not assert never',
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return extraFile === undefined
    ? offenders
    : offenders.filter((o) => o.file.endsWith('__exhaustive_probe.ts'));
}

const SYNTHETIC = resolve(SERVER_DIR, 'src', '__exhaustive_probe.ts');

describe('a void switch over a finite union must be exhaustive', () => {
  it('finds no unguarded dispatch in apps/server/src', () => {
    expect(findOffenders()).toEqual([]);
  });

  // The arms below prove the detector fires on a known positive and stays quiet
  // on each shape it must not accuse. Without them an empty result above would
  // be indistinguishable from a detector that inspects nothing.
  it('accuses a void switch whose union member has no case', () => {
    const found = findOffenders({
      name: SYNTHETIC,
      text: `type K = 'a' | 'b';
export function drop(k: K): void { switch (k) { case 'a': break; default: break; } }
`,
    });
    expect(found.map((o) => o.reason)).toEqual(['default does not assert never']);
  });

  it('accuses a void switch with no default at all', () => {
    const found = findOffenders({
      name: SYNTHETIC,
      text: `type K = 'a' | 'b';
export function drop(k: K): void { switch (k) { case 'a': break; case 'b': break; } }
`,
    });
    expect(found.map((o) => o.reason)).toEqual(['no default clause']);
  });

  it('accepts a never assertion, a throw, a value-returning function, and an open subject', () => {
    const found = findOffenders({
      name: SYNTHETIC,
      text: `type K = 'a' | 'b';
export function marked(k: K): void { switch (k) { case 'a': break; default: { const _e: never = k; void _e; break; } } }
export function loud(k: K): void { switch (k) { case 'a': break; default: throw new Error('unhandled'); } }
export function returnsValue(k: K): string { switch (k) { case 'a': return 'x'; case 'b': return 'y'; } }
export function openSubject(s: string): void { switch (s) { case 'a': break; default: break; } }
`,
    });
    expect(found).toEqual([]);
  });
});
