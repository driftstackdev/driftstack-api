// Every /v1/admin/* route must carry an admin-or-owner authorization gate.
//
// Security invariant: discover ALL literal Fastify admin registrations first,
// then inspect only their options argument. A scanner whose match itself
// requires `preHandler` is vacuous: a completely ungated route disappears from
// the inventory and the assertion still passes. TypeScript's AST also keeps a
// handler-body mention of requireScope from being mistaken for a preHandler.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

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
      if (
        pathArg !== undefined &&
        (ts.isStringLiteral(pathArg) || ts.isNoSubstitutionTemplateLiteral(pathArg)) &&
        pathArg.text.startsWith('/v1/admin/')
      ) {
        const secondArg = node.arguments[1];
        const hasSeparateHandler = node.arguments.length >= 3;
        const optionsArg =
          hasSeparateHandler || (secondArg !== undefined && ts.isObjectLiteralExpression(secondArg))
            ? secondArg
            : undefined;
        const handlerArg = hasSeparateHandler ? node.arguments[2] : secondArg;
        routes.push({
          file,
          method: node.expression.name.text,
          path: pathArg.text,
          optionsText: optionsArg?.getText(sourceFile) ?? '',
          handlerIdentifier:
            handlerArg !== undefined && ts.isIdentifier(handlerArg) ? handlerArg.text : null,
        });
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
    expect(routes).toHaveLength(67);
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
});
