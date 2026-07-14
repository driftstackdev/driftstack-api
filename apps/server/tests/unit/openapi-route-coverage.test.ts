// Published OpenAPI operation ↔ Fastify registration coverage.
//
// Compare METHOD + normalized path. A path-only regex lets documented GET and
// implemented POST satisfy one another, and counts comments/string constants as
// routes. The AST inventory sees only literal Fastify registrations.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

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
  return `${method.toUpperCase()} ${normalizePath(path)}`;
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
        pathArg !== undefined &&
        (ts.isStringLiteral(pathArg) || ts.isNoSubstitutionTemplateLiteral(pathArg)) &&
        pathArg.text.startsWith('/')
      ) {
        operations.add(operationKey(node.expression.name.text, pathArg.text));
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
    expect(specOperations.size).toBe(212);
    expect(routeOperations.size).toBe(250);
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
      'GET /v1/status/incidents',
      'GET /v1/status/sla',
    ]);
    expect(missingOperations(coreOperations, specOperations)).toEqual([]);
  });

  it('backs every published method+path operation with a real registration', () => {
    const phantom = missingOperations(specOperations, routeOperations);
    expect(phantom, `Published phantom operation(s):\n${phantom.join('\n')}`).toEqual([]);
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
});
