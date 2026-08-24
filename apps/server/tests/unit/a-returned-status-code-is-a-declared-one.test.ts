// V-1531 — a status code the server returns that its operation does not declare.
//
// The spec is code here: `packages/sdk-python` is GENERATED from it. A generated
// client models the responses the document declares, so a code the server can
// actually return and the document omits reaches the customer as an unmodelled
// branch — for a 2xx that is a success the SDK cannot type, and for a 4xx an
// error class that does not exist.
//
// Two neighbouring guards stop short of this. `openapi-route-coverage` compares
// METHOD + PATH, so an operation can be perfectly covered and still declare the
// wrong codes. `openapi-responses-conform-to-the-spec` validates response BODIES
// against the schema for the codes it exercises, which cannot see a code no arm
// exercises. This is the third axis, and it currently holds at zero.
//
// Registrations are read from the TypeScript AST rather than by regex, and the
// reason is a measured one rather than a preference. The first draft of this
// check matched `app.<method>(` textually and reported EIGHTEEN violations. All
// eighteen were false. `app.post<{ Params: { id: string } }>(` carries a generic
// between the method name and the paren, so every typed registration was
// invisible to the pattern and its handler's codes were attributed to whichever
// plain registration preceded it — which is how a GET came to "return" 201. The
// same fault, one spelling of a mechanism read as the whole mechanism, is what
// V-1515/V-1527/V-1529 each found in someone else's guard.
//
// The handler is taken as the last function-valued argument, and an identifier
// argument is resolved to its `const` declaration in the same file: the second
// false positive came from `reply.code(204)` inside `disableHandler`, a const
// declared between two registrations and textually inside neither. Handlers that
// cannot be resolved are COUNTED and asserted below rather than skipped in
// silence, because an unstated blind spot in a guard reads as coverage.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTES_DIR = resolve(REPO_ROOT, 'apps/server/src/routes');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

interface OpenApiSpec {
  paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
}

/** Fastify writes `:id`; OpenAPI writes `{id}`. */
function normalizePath(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

function declaredCodes(): Map<string, ReadonlySet<string>> {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as OpenApiSpec;
  const out = new Map<string, ReadonlySet<string>>();
  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!HTTP_METHODS.has(method)) continue;
      out.set(`${method.toUpperCase()} ${path}`, new Set(Object.keys(operation.responses ?? {})));
    }
  }
  return out;
}

interface Site {
  readonly operation: string;
  readonly codes: ReadonlySet<string>;
}

interface Scan {
  readonly sites: readonly Site[];
  /** Registrations whose handler could not be resolved to a function body. */
  readonly unresolvedHandlers: number;
}

/** Every literal `.code(n)` / `.status(n)` inside one node. */
function statusCodesIn(node: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      (n.expression.name.text === 'code' || n.expression.name.text === 'status') &&
      n.arguments.length === 1
    ) {
      const [arg] = n.arguments;
      if (arg !== undefined && ts.isNumericLiteral(arg) && /^[2345]\d\d$/.test(arg.text)) {
        out.add(arg.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** `const h = async (req, reply) => {...}` in the same file, by name. */
function localFunctionConsts(sourceFile: ts.SourceFile): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      out.set(node.name.text, node.initializer);
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
      out.set(node.name.text, node.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

function scan(file: string, source: string): Scan {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const consts = localFunctionConsts(sourceFile);
  const sites: Site[] = [];
  let unresolvedHandlers = 0;

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      HTTP_METHODS.has(node.expression.name.text)
    ) {
      const [pathArg] = node.arguments;
      if (pathArg !== undefined && ts.isStringLiteral(pathArg)) {
        const method = node.expression.name.text.toUpperCase();
        const operation = `${method} ${normalizePath(pathArg.text)}`;
        const last = node.arguments[node.arguments.length - 1];
        let handler: ts.Node | undefined;
        if (last !== undefined && (ts.isArrowFunction(last) || ts.isFunctionExpression(last))) {
          handler = last;
        } else if (last !== undefined && ts.isIdentifier(last)) {
          handler = consts.get(last.text);
        }
        if (handler === undefined) {
          unresolvedHandlers += 1;
        } else {
          sites.push({ operation, codes: statusCodesIn(handler) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { sites, unresolvedHandlers };
}

function scanAll(): Scan {
  const sites: Site[] = [];
  let unresolvedHandlers = 0;
  for (const entry of readdirSync(ROUTES_DIR)) {
    if (!entry.endsWith('.ts')) continue;
    const result = scan(entry, readFileSync(resolve(ROUTES_DIR, entry), 'utf8'));
    sites.push(...result.sites);
    unresolvedHandlers += result.unresolvedHandlers;
  }
  return { sites, unresolvedHandlers };
}

describe('a returned status code is a declared one', () => {
  const declared = declaredCodes();
  const { sites, unresolvedHandlers } = scanAll();

  it('reads enough of the route tree to be worth trusting — a scan that resolved nothing would satisfy the assertions below without inspecting anything', () => {
    expect(sites.length, 'route registrations with a resolved handler').toBeGreaterThan(200);
    expect(declared.size, 'operations declaring responses in the published spec').toBeGreaterThan(
      200,
    );
    const published = sites.filter((s) => declared.has(s.operation));
    expect(
      published.length,
      'resolved registrations that map to a published operation',
    ).toBeGreaterThan(150);
  });

  it('CRITICAL every literal status code a published handler returns is declared by its operation. The Python SDK is generated from this document, so an undeclared code is a response the generated client cannot model — an untyped success for a 2xx, a missing error class for a 4xx. Neither neighbouring guard sees this: openapi-route-coverage compares method and path, and openapi-responses-conform-to-the-spec validates bodies only for codes an arm already exercises.', () => {
    const violations: string[] = [];
    for (const site of sites) {
      const codes = declared.get(site.operation);
      if (codes === undefined) continue; // not published; openapi-route-coverage owns that direction
      for (const code of [...site.codes].sort()) {
        if (!codes.has(code)) {
          violations.push(
            `${site.operation} returns ${code}, declares ${[...codes].sort().join('/')}`,
          );
        }
      }
    }
    expect(
      violations.sort(),
      'these operations return a code the published document does not declare',
    ).toEqual([]);
  });

  it('the handlers this scan could NOT resolve are counted, so the blind spot is a number rather than a silence. Raising it means registrations started being written in a form the AST walk does not follow, and the check above quietly stopped covering them', () => {
    expect(
      unresolvedHandlers,
      'registrations whose handler did not resolve to a function body',
    ).toBeLessThanOrEqual(12);
  });

  it("V-1534 CRITICAL POST /v1/agent-sessions/{id}/message declares 402, which it reaches by THROWING rather than by reply.code(). That is the blind spot of the arms above and it is stated here rather than left implicit: they scan literal codes inside a resolved handler, and these two throws sit two call frames below it in executeAgentMessage, so nothing above sees them. The document declared no 402 on any operation while the budget error's own comment read: Status 402 Payment Required so SDK consumers can branch on the status code AND the typed problem-type URI. A file-level version of this check was written and discarded — status-stream.ts throws 503 from an UNPUBLISHED operation and would have been judged against the declared set of a published sibling in the same file, so file granularity manufactures failures that are not real.", () => {
    const errorsSource = readFileSync(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'), 'utf8');
    const statusOfClass = (name: string): string | undefined => {
      const match = new RegExp(`export class ${name} extends ApiError \\{`).exec(errorsSource);
      if (match === null) return undefined;
      const start = match.index + match[0].length;
      let depth = 1;
      let end = start;
      while (end < errorsSource.length && depth > 0) {
        if (errorsSource[end] === '{') depth += 1;
        else if (errorsSource[end] === '}') depth -= 1;
        end += 1;
      }
      return /status:\s*(\d{3})/.exec(errorsSource.slice(start, end))?.[1];
    };

    // Both are 402 in errors.ts; if either is retyped, this arm must be revisited
    // rather than silently continuing to assert a code nothing raises any more.
    for (const name of ['BundledLlmBudgetExhaustedError', 'BundledLlmConsentRequiredError']) {
      expect(statusOfClass(name), `${name} still carries the status this arm pins`).toBe('402');
    }

    const route = readFileSync(resolve(ROUTES_DIR, 'agent-sessions.ts'), 'utf8');
    for (const name of ['BundledLlmBudgetExhaustedError', 'BundledLlmConsentRequiredError']) {
      expect(route, `${name} is still thrown by the agent-sessions routes`).toContain(
        `throw new ${name}`,
      );
    }

    const codes = declared.get('POST /v1/agent-sessions/{id}/message');
    expect(codes, 'the message operation is still published').not.toBeUndefined();
    expect(
      [...(codes ?? [])].sort(),
      'the message turn refuses with 402 when the bundled-LLM cap is reached or consent is ' +
        'absent, and a generated client cannot branch on a code the document omits',
    ).toContain('402');
  });
});
