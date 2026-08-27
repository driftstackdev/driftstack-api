// Every /v1/admin/* route must carry an admin-or-owner authorization gate.
//
// Security invariant: discover ALL Fastify admin registrations first, then
// inspect only their options argument. Finite template domains are expanded;
// any other computed path fails closed instead of disappearing. A scanner whose
// match itself requires `preHandler` is vacuous: a completely ungated route
// disappears from the inventory and the assertion still passes. TypeScript's
// AST also keeps a handler-body mention of requireScope from being mistaken for
// a preHandler.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
// ⛔ TIMEOUT — this file is an I/O-bound census: it walks the source tree and
// parses every file with the TypeScript compiler. Its runtime scales with
// machine load, not with anything it asserts, so under contention it fails with
// "Test timed out" rather than an assertion — which reads as a regression in the
// thing being checked and is not one. Measured 2026-08-27: the nine census tests
// in this family run in 4.7s of test time COMBINED (~0.5s each) on a quiet box,
// and one of them still exceeded the 10s default during a full-suite run while a
// second workload held the machine at load 50.
//
// ⚠️ A test that only fails under load is the kind that gets re-run until green
// rather than fixed. The clock is not what protects this file: a wall-clock
// timeout fires on a busy box and passes on an idle one regardless of the code.
// What detects a walk that stopped finding things is the census assertion this
// file already carries — an exact count pin or a non-vacuity floor over the
// walked population. Because that assertion is doing the real work, giving the
// clock enough room to absorb contention costs no coverage. See V-1975.
vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES = resolve(HERE, '..', '..', 'src', 'routes');
const METHODS = new Set(['get', 'post', 'patch', 'put', 'delete']);

interface AdminRouteDecl {
  file: string;
  method: string;
  path: string;
  optionsText: string;
  handlerIdentifier: string | null;
}

interface StubExemption {
  file: string;
  method: string;
  path: string;
  handler: string;
  reason: string;
}

// Activation-off routes return a fixed 503 and expose no admin data or
// mutation. Keep this list exact; a new stub does not become exempt merely by
// being a two-argument registration.
const STUB_EXEMPTIONS: readonly StubExemption[] = [];

function enclosingForOfValues(node: ts.Node, identifier: string): string[] | null {
  let parent: ts.Node | undefined = node.parent;
  while (parent !== undefined) {
    if (ts.isForOfStatement(parent) && ts.isVariableDeclarationList(parent.initializer)) {
      const declarations = parent.initializer.declarations;
      const declaration = declarations.length === 1 ? declarations[0] : undefined;
      if (
        declaration !== undefined &&
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === identifier
      ) {
        let expression = parent.expression;
        while (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression)) {
          expression = expression.expression;
        }
        if (!ts.isArrayLiteralExpression(expression)) return null;
        const values: string[] = [];
        for (const element of expression.elements) {
          if (!ts.isStringLiteral(element) && !ts.isNoSubstitutionTemplateLiteral(element)) {
            return null;
          }
          values.push(element.text);
        }
        return values;
      }
    }
    parent = parent.parent;
  }
  return null;
}

function routePaths(
  pathArg: ts.Expression,
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
): string[] {
  if (ts.isStringLiteral(pathArg) || ts.isNoSubstitutionTemplateLiteral(pathArg)) {
    return pathArg.text.startsWith('/')
      ? [pathArg.text]
      : [`<unresolved:${pathArg.getText(sourceFile)}>`];
  }
  if (ts.isTemplateExpression(pathArg)) {
    let paths = [pathArg.head.text];
    for (const span of pathArg.templateSpans) {
      if (!ts.isIdentifier(span.expression)) {
        return [`<unresolved:${pathArg.getText(sourceFile)}>`];
      }
      const values = enclosingForOfValues(call, span.expression.text);
      if (values === null || values.length === 0) {
        return [`<unresolved:${pathArg.getText(sourceFile)}>`];
      }
      paths = paths.flatMap((prefix) =>
        values.map((value) => `${prefix}${value}${span.literal.text}`),
      );
    }
    if (paths.every((path) => path.startsWith('/'))) return paths;
  }
  return [`<unresolved:${pathArg.getText(sourceFile)}>`];
}

function scanAdminRoutes(file: string, source: string): AdminRouteDecl[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const routes: AdminRouteDecl[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'app' &&
      METHODS.has(node.expression.name.text)
    ) {
      const pathArg = node.arguments[0];
      if (pathArg !== undefined) {
        const secondArg = node.arguments[1];
        const hasSeparateHandler = node.arguments.length >= 3;
        const optionsArg =
          hasSeparateHandler || (secondArg !== undefined && ts.isObjectLiteralExpression(secondArg))
            ? secondArg
            : undefined;
        const handlerArg = hasSeparateHandler ? node.arguments[2] : secondArg;
        for (const path of routePaths(pathArg, node, sourceFile)) {
          if (!path.startsWith('/v1/admin/') && !path.startsWith('<unresolved:')) continue;
          routes.push({
            file,
            method: node.expression.name.text,
            path,
            optionsText: optionsArg?.getText(sourceFile) ?? '',
            handlerIdentifier:
              handlerArg !== undefined && ts.isIdentifier(handlerArg) ? handlerArg.text : null,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return routes;
}

function isStubExempt(route: AdminRouteDecl): boolean {
  return STUB_EXEMPTIONS.some(
    (stub) =>
      stub.file === route.file &&
      stub.method === route.method &&
      stub.path === route.path &&
      stub.handler === route.handlerIdentifier,
  );
}

function hasAdminGate(route: AdminRouteDecl): boolean {
  return (
    /requireScope\s*\(\s*['"]driftstack_internal_admin['"]\s*\)/.test(route.optionsText) ||
    /\brequireOwner\b/.test(route.optionsText)
  );
}

function violations(routes: readonly AdminRouteDecl[]): string[] {
  return routes
    .filter((route) => !hasAdminGate(route) && !isStubExempt(route))
    .map((route) => `${route.method.toUpperCase()} ${route.path} (${route.file})`)
    .sort();
}

describe('/v1/admin route authorization invariant', () => {
  const files = readdirSync(ROUTES).filter((file) => file.endsWith('.ts'));
  const routes = files.flatMap((file) =>
    scanAdminRoutes(file, readFileSync(join(ROUTES, file), 'utf8')),
  );

  it('discovers the complete current admin registration surface', () => {
    // Exact count makes deletion/invisibility visible during review; the lower
    // bound prevents a bulk registration-style refactor from passing vacuously.
    // Refreshed after confirming the gating invariant below is green (every
    // live /v1/admin route still carries internal-admin scope or requireOwner)
    // and that no admin route changed since `8dad6e4f6` — the count itself had
    // gone stale earlier.
    expect(routes).toHaveLength(68);
    expect(routes.length).toBeGreaterThanOrEqual(60);
  });

  it('every live /v1/admin route is gated by internal-admin scope or requireOwner', () => {
    const ungated = violations(routes);
    expect(
      ungated,
      `ungated /v1/admin routes — add internal-admin scope or requireOwner:\n${ungated.join('\n')}`,
    ).toEqual([]);
  });

  it('explicit activation-stub exemptions resolve to an exact registration', () => {
    const stale = STUB_EXEMPTIONS.filter(
      (stub) =>
        !routes.some(
          (route) =>
            route.file === stub.file &&
            route.method === stub.method &&
            route.path === stub.path &&
            route.handlerIdentifier === stub.handler,
        ),
    );
    expect(stale).toEqual([]);
  });

  it('detects a completely ungated route even when its handler mentions an admin scope', () => {
    const synthetic = scanAdminRoutes(
      'synthetic.ts',
      `app.get('/v1/admin/leak', async () => {
        const misleading = "app.requireScope('driftstack_internal_admin')";
        return { misleading };
      });`,
    );
    expect(violations(synthetic)).toEqual(['GET /v1/admin/leak (synthetic.ts)']);
  });

  it('accepts an authorization gate only from the route options argument', () => {
    const synthetic = scanAdminRoutes(
      'synthetic.ts',
      `app.get(
        '/v1/admin/safe',
        { preHandler: [app.requireAuth, app.requireScope('driftstack_internal_admin')] },
        async () => ({ ok: true }),
      );`,
    );
    expect(violations(synthetic)).toEqual([]);
  });

  it('expands finite literal template domains into every admin route', () => {
    const synthetic = scanAdminRoutes(
      'synthetic.ts',
      `for (const resource of ['accounts', 'sessions'] as const) {
        app.get(
          \`/v1/admin/\${resource}\`,
          { preHandler: [app.requireAuth, app.requireScope('driftstack_internal_admin')] },
          async () => ({ ok: true }),
        );
      }`,
    );
    expect(synthetic.map((route) => route.path)).toEqual([
      '/v1/admin/accounts',
      '/v1/admin/sessions',
    ]);
    expect(violations(synthetic)).toEqual([]);
  });

  it('reports an unresolved computed route instead of silently skipping it', () => {
    const synthetic = scanAdminRoutes(
      'synthetic.ts',
      `const path = chooseAdminPath();
      app.get(path, async () => ({ secret: true }));`,
    );
    expect(violations(synthetic)).toEqual(['GET <unresolved:path> (synthetic.ts)']);
  });
});
