// Cross-route authz invariant — every X-Driftstack-Account ("acting-as") header
// read MUST go through the membership-validating resolver.
//
// `readEffectiveAccountHeader(req)` only parses the header. Authorization lives
// in `resolveEffectiveAccount(ctx, header)`, which rejects accounts outside the
// caller's memberships. Discover imported bindings with the TypeScript AST so
// aliases, generic syntax and formatting cannot make an unsafe read invisible.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = resolve(HERE, '..', '..', 'src', 'routes');
const ACTING_ACCOUNT_HEADER = 'x-driftstack-account';

interface ImportedBindings {
  named: ReadonlySet<string>;
  namespaces: ReadonlySet<string>;
}

interface HeaderRead {
  file: string;
  line: number;
  authorized: boolean;
}

interface RouteScan {
  reads: HeaderRead[];
  indirectReaderReferences: string[];
  rawHeaderLiterals: string[];
}

function importedBindings(
  sourceFile: ts.SourceFile,
  moduleSuffix: string,
  importedName: string,
): ImportedBindings {
  const named = new Set<string>();
  const namespaces = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.endsWith(moduleSuffix)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      const sourceName = element.propertyName?.text ?? element.name.text;
      if (sourceName === importedName) named.add(element.name.text);
    }
  }

  return { named, namespaces };
}

function isImportedCall(
  call: ts.CallExpression,
  bindings: ImportedBindings,
  importedName: string,
): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return bindings.named.has(callee.text);
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    bindings.namespaces.has(callee.expression.text) &&
    callee.name.text === importedName
  );
}

function isImportBindingIdentifier(node: ts.Identifier): boolean {
  return ts.isImportSpecifier(node.parent) || ts.isNamespaceImport(node.parent);
}

function scanRoute(file: string, source: string): RouteScan {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const readers = importedBindings(
    sourceFile,
    '/lib/effective-account-header.js',
    'readEffectiveAccountHeader',
  );
  const resolvers = importedBindings(sourceFile, '/services/auth.js', 'resolveEffectiveAccount');
  const reads: HeaderRead[] = [];
  const indirectReaderReferences: string[] = [];
  const rawHeaderLiterals: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text.toLowerCase() === ACTING_ACCOUNT_HEADER
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      rawHeaderLiterals.push(`${file}:${line + 1}`);
    }

    if (
      ts.isIdentifier(node) &&
      readers.named.has(node.text) &&
      !isImportBindingIdentifier(node) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      indirectReaderReferences.push(`${file}:${line + 1}`);
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      readers.namespaces.has(node.expression.text) &&
      node.name.text === 'readEffectiveAccountHeader' &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      indirectReaderReferences.push(`${file}:${line + 1}`);
    }

    if (ts.isCallExpression(node) && isImportedCall(node, readers, 'readEffectiveAccountHeader')) {
      const parent = node.parent;
      const authorized =
        ts.isCallExpression(parent) &&
        isImportedCall(parent, resolvers, 'resolveEffectiveAccount') &&
        parent.arguments[1] === node;
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      reads.push({ file, line: line + 1, authorized });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { reads, indirectReaderReferences, rawHeaderLiterals };
}

function unvalidatedReads(scans: readonly RouteScan[]): string[] {
  return scans
    .flatMap((scan) => scan.reads)
    .filter((read) => !read.authorized)
    .map((read) => `${read.file}:${read.line}`)
    .concat(scans.flatMap((scan) => scan.indirectReaderReferences))
    .sort();
}

describe('X-Driftstack-Account acting-as authz invariant (all routes/)', () => {
  const files = readdirSync(ROUTES_DIR).filter(
    (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
  );
  const scans = files.map((file) =>
    scanRoute(file, readFileSync(resolve(ROUTES_DIR, file), 'utf8')),
  );
  const reads = scans.flatMap((scan) => scan.reads);

  it('discovers the complete current acting-as reader surface', () => {
    // Review tripwire, not the security assertion — the invariant below is what
    // enforces authorization. Refreshed after confirming every one of the 30
    // reads is authorized (unvalidatedReads() is empty) and that the reader
    // surface is still exactly these 9 route files. The 31st read disappeared
    // through consolidation, not by an unsafe read escaping the resolver.
    expect(reads).toHaveLength(30);
    expect(new Set(reads.map((read) => read.file)).size).toBe(9);
  });

  it('every header-parser call is the membership resolver acting-account argument', () => {
    const unsafe = unvalidatedReads(scans);
    expect(
      unsafe,
      `Unvalidated X-Driftstack-Account read(s) — pass the parser directly as resolveEffectiveAccount's second argument:\n${unsafe.join('\n')}`,
    ).toEqual([]);
  });

  it('no route contains a raw X-Driftstack-Account header literal', () => {
    expect(scans.flatMap((scan) => scan.rawHeaderLiterals)).toEqual([]);
  });

  it('detects an unsafe parser imported under an alias', () => {
    const scan = scanRoute(
      'synthetic.ts',
      `import { readEffectiveAccountHeader as parseActingAs } from '../lib/effective-account-header.js';
       import { resolveEffectiveAccount as authorize } from '../services/auth.js';
       const selected = parseActingAs(request);
       authorize(ctx, selected);`,
    );
    expect(unvalidatedReads([scan])).toEqual(['synthetic.ts:3']);
  });

  it('accepts aliased, multiline parser-to-resolver composition', () => {
    const scan = scanRoute(
      'synthetic.ts',
      `import { readEffectiveAccountHeader as parseActingAs } from '../lib/effective-account-header.js';
       import { resolveEffectiveAccount as authorize } from '../services/auth.js';
       const effective = authorize(
         ctx,
         parseActingAs(request),
       );`,
    );
    expect(scan.reads).toHaveLength(1);
    expect(unvalidatedReads([scan])).toEqual([]);
  });

  it('rejects hiding the imported parser behind a local function alias', () => {
    const scan = scanRoute(
      'synthetic.ts',
      `import { readEffectiveAccountHeader } from '../lib/effective-account-header.js';
       const parseActingAs = readEffectiveAccountHeader;
       const selected = parseActingAs(request);`,
    );
    expect(unvalidatedReads([scan])).toEqual(['synthetic.ts:2']);
  });

  it('detects direct raw-header access structurally', () => {
    const scan = scanRoute(
      'synthetic.ts',
      `const selected = request.headers['X-Driftstack-Account'];`,
    );
    expect(scan.rawHeaderLiterals).toEqual(['synthetic.ts:1']);
  });
});
