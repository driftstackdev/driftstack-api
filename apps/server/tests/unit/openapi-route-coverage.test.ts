// Published OpenAPI operation ↔ Fastify registration coverage.
//
// Compare METHOD + normalized path. A path-only regex lets documented GET and
// implemented POST satisfy one another, and counts comments/string constants as
// routes. Finite template domains are expanded; every other dynamic path is an
// explicit inventory item so it cannot disappear from reverse coverage.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTES_DIR = resolve(REPO_ROOT, 'apps/server/src/routes');
const APP_SOURCE = resolve(REPO_ROOT, 'apps/server/src/lib/app.ts');
const PUBLISHED_SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

interface OpenApiSpec {
  paths?: Record<string, Record<string, unknown>>;
}

function normalizePath(path: string): string {
  return path
    .replace(/\{[A-Za-z_]+\}/g, ':p')
    .replace(/:[A-Za-z_]+/g, ':p')
    .replace(/\/$/, '');
}

function operationKey(method: string, path: string): string {
  const inventoryPath = path.startsWith('<unresolved:') ? path : normalizePath(path);
  return `${method.toUpperCase()} ${inventoryPath}`;
}

function publishedOperations(spec: OpenApiSpec): Set<string> {
  const operations = new Set<string>();
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(pathItem)) {
      if (HTTP_METHODS.has(method)) operations.add(operationKey(method, path));
    }
  }
  return operations;
}

function fastifyFactoryIdentifiers(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const identifiers = new Set<string>();
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'Fastify'
    ) {
      identifiers.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return identifiers;
}

function isTypedFastifyParameter(
  node: ts.Node,
  receiver: string,
  sourceFile: ts.SourceFile,
): boolean {
  let parent: ts.Node | undefined = node.parent;
  while (parent !== undefined) {
    if (
      ts.isFunctionLike(parent) &&
      parent.parameters.some(
        (parameter) =>
          ts.isIdentifier(parameter.name) &&
          parameter.name.text === receiver &&
          parameter.type?.getText(sourceFile).includes('FastifyInstance') === true,
      )
    ) {
      return true;
    }
    parent = parent.parent;
  }
  return false;
}

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

function scanFastifyOperations(file: string, source: string): Set<string> {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const factoryIdentifiers = fastifyFactoryIdentifiers(sourceFile);
  const operations = new Set<string>();

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      HTTP_METHODS.has(node.expression.name.text)
    ) {
      const receiver = node.expression.expression.text;
      const pathArg = node.arguments[0];
      if (
        (factoryIdentifiers.has(receiver) || isTypedFastifyParameter(node, receiver, sourceFile)) &&
        pathArg !== undefined
      ) {
        for (const path of routePaths(pathArg, node, sourceFile)) {
          operations.add(operationKey(node.expression.name.text, path));
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return operations;
}

function missingOperations(spec: ReadonlySet<string>, routes: ReadonlySet<string>): string[] {
  return [...spec].filter((operation) => !routes.has(operation)).sort();
}

// Reverse coverage is intentionally stricter for the admin surface: every
// staff/owner operation is part of the published internal contract. These are
// the only literal Fastify registrations intentionally omitted from OpenAPI.
// Keep this exact so a newly registered route cannot disappear from security
// review and generated-client discovery without a deliberate test change.
const INTENTIONALLY_UNPUBLISHED_OPERATIONS = new Set([
  'GET /healthz',
  'GET /metrics',
  'GET /openapi.json',
  'GET /ready',
  'GET /v1/agent-sessions/:p/gui-control-key',
  'GET /v1/auth/oauth-client/callback',
  'GET /v1/auth/oauth/github/callback',
  'GET /v1/auth/oauth/google/callback',
  'GET /v1/internal/atlas-priority/event/:p',
  'GET /v1/internal/atlas-priority/queue',
  'GET /v1/mac-nodes',
  'GET /v1/status/stream',
  'GET /v1/whoami',
  'POST /v1/agent-sessions/:p/transport-report',
  'POST /v1/internal/atlas-priority/event-status',
  'POST /v1/internal/atlas-priority/probe-signature',
  'POST /v1/mac-nodes',
  'POST /v1/mac-nodes/:p/control',
  'POST /v1/oauth/authorize/complete',
  'POST /v1/sessions/:p/gui-input',
  'POST /v1/webhooks/nowpayments',
  'POST /v1/webhooks/stripe',
]);

describe('published OpenAPI operation ↔ Fastify registration coverage', () => {
  const spec = JSON.parse(readFileSync(PUBLISHED_SPEC, 'utf8')) as OpenApiSpec;
  const specOperations = publishedOperations(spec);
  const routeOperations = new Set<string>();
  for (const file of readdirSync(ROUTES_DIR).filter((entry) => entry.endsWith('.ts'))) {
    for (const operation of scanFastifyOperations(
      file,
      readFileSync(resolve(ROUTES_DIR, file), 'utf8'),
    )) {
      routeOperations.add(operation);
    }
  }
  for (const operation of scanFastifyOperations('lib/app.ts', readFileSync(APP_SOURCE, 'utf8'))) {
    routeOperations.add(operation);
  }

  it('inventories the complete current published and registered operation sets', () => {
    // d5e30ea9c published the 232nd operation in the frozen generator
    // authority; keep this inventory aligned with that exact spec rather than
    // retaining the prior archetype-catalog-era count.
    // 234 since V-1611 #14 published `GET /v1/teams` + `PATCH /v1/teams/{id}`.
    expect(specOperations.size).toBe(234);
    // f66e8a02c added PUT /v1/admin/incidents/:id as the 254th unique Fastify
    // registration; this verifier-only correction does not add a route.
    // 256 since V-1611 #14 registered `GET /v1/teams` + `PATCH /v1/teams/:id`.
    expect(routeOperations.size).toBe(256);
  });

  it('documents the method-specific customer-core contract', () => {
    const coreOperations = new Set([
      'POST /v1/sessions',
      'GET /v1/sessions/:p',
      'POST /v1/sessions/:p/navigate',
      'POST /v1/sessions/:p/capture',
      'GET /v1/profiles',
      'GET /v1/profiles/:p',
      'GET /v1/api-keys',
      'POST /v1/api-keys/:p/rotate',
      'GET /v1/webhooks',
      'GET /v1/webhooks/:p',
      'POST /v1/webhooks/:p/rotate-secret',
      'POST /v1/billing/crypto-checkout',
      'GET /v1/billing/crypto-orders',
      'GET /v1/billing/crypto-orders/:p',
      'GET /v1/account/me',
      'GET /v1/account/me/notifications',
      'GET /v1/account/cost',
      'GET /v1/account/audit-log',
      'GET /v1/agent-sessions/:p/transcript',
      'POST /v1/profiles/:p/launch',
      'POST /v1/auth/signup',
      'POST /v1/auth/login',
      'POST /v1/auth/verify-email',
      'GET /v1/status',
      'GET /v1/archetypes',
      'GET /v1/status/incidents',
      'GET /v1/status/sla',
    ]);
    expect(missingOperations(coreOperations, specOperations)).toEqual([]);
  });

  it('backs every published method+path operation with a real registration', () => {
    const phantom = missingOperations(specOperations, routeOperations);
    expect(phantom, `Published phantom operation(s):\n${phantom.join('\n')}`).toEqual([]);
  });

  it('publishes every registered staff and owner admin operation', () => {
    const undocumentedAdmin = missingOperations(routeOperations, specOperations).filter(
      (operation) => operation.includes(' /v1/admin/'),
    );
    expect(
      undocumentedAdmin,
      `Undocumented admin operation(s):\n${undocumentedAdmin.join('\n')}`,
    ).toEqual([]);
  });

  it('pins the exact non-admin operations intentionally omitted from OpenAPI', () => {
    const undocumented = missingOperations(routeOperations, specOperations);
    expect(
      undocumented,
      `Unexpected unpublished or stale-exception operation(s):\n${undocumented.join('\n')}`,
    ).toEqual([...INTENTIONALLY_UNPUBLISHED_OPERATIONS].sort());
  });

  it('does not let the wrong method or a matching comment satisfy coverage', () => {
    const syntheticRoutes = scanFastifyOperations(
      'synthetic.ts',
      `function registerSyntheticRoutes(server: FastifyInstance): void {
        // GET /v1/customer/resource is not a registration.
        server.post('/v1/customer/resource', async () => ({ ok: true }));
      }`,
    );
    const syntheticSpec = new Set(['GET /v1/customer/resource']);
    expect(missingOperations(syntheticSpec, syntheticRoutes)).toEqual([
      'GET /v1/customer/resource',
    ]);
  });

  it('normalizes parameter names without erasing method identity', () => {
    const syntheticRoutes = scanFastifyOperations(
      'synthetic.ts',
      `function registerSyntheticRoutes(server: FastifyInstance): void {
        server.get('/v1/customer/:resourceId', async () => ({ ok: true }));
      }`,
    );
    expect(missingOperations(new Set(['GET /v1/customer/:p']), syntheticRoutes)).toEqual([]);
    expect(missingOperations(new Set(['DELETE /v1/customer/:p']), syntheticRoutes)).toEqual([
      'DELETE /v1/customer/:p',
    ]);
  });

  it('expands finite literal template domains into concrete operations', () => {
    const syntheticRoutes = scanFastifyOperations(
      'synthetic.ts',
      `function registerSyntheticRoutes(server: FastifyInstance): void {
        for (const resource of ['profiles', 'sessions'] as const) {
          server.get(\`/v1/\${resource}/public\`, async () => ({ ok: true }));
        }
      }`,
    );
    expect([...syntheticRoutes]).toEqual(['GET /v1/profiles/public', 'GET /v1/sessions/public']);
  });

  it('surfaces an unresolved dynamic path in reverse coverage', () => {
    const syntheticRoutes = scanFastifyOperations(
      'synthetic.ts',
      `function registerSyntheticRoutes(server: FastifyInstance): void {
        const path = chooseCustomerPath();
        server.get(path, async () => ({ secret: true }));
      }`,
    );
    expect(missingOperations(syntheticRoutes, new Set())).toEqual(['GET <unresolved:path>']);
  });
});
