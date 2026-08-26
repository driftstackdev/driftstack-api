// Every customer-facing mutation route must carry an abuse limiter or an
// exact, reviewable exemption.
//
// Discover registrations with the TypeScript AST before checking their
// options. Finite template domains are expanded; any other computed path fails
// closed instead of disappearing. A textual `app.post(` scanner skips generic
// Fastify calls such as `app.post<{ Params: ... }>(...)`; handler-body mentions
// must not satisfy the options-only security check.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = resolve(HERE, '..', '..', 'src', 'routes');
const MUTATION_METHODS = new Set(['post', 'put', 'patch', 'delete']);
const INTERNAL_LIMITER_IDENTIFIERS = new Set(['requireInternalAuth']);

interface MutationRouteDecl {
  file: string;
  method: string;
  path: string;
  optionsText: string;
  handlerIdentifier: string | null;
  ipGateIdentifiers: ReadonlySet<string>;
  hasTypeArguments: boolean;
}

interface RouteExemption {
  file: string;
  method: string;
  path: string;
  reason: string;
}

interface StubExemption extends RouteExemption {
  handler: string;
}

// Signature-verified provider ingress cannot use an IP gate without risking
// rejection of legitimate deliveries from provider address changes.
const SIGNED_INGRESS_EXEMPTIONS: readonly RouteExemption[] = [
  {
    file: 'webhooks-stripe.ts',
    method: 'post',
    path: '/v1/webhooks/stripe',
    reason: 'Stripe HMAC verification and bounded body replace a source-IP limiter.',
  },
  {
    file: 'webhooks-nowpayments.ts',
    method: 'post',
    path: '/v1/webhooks/nowpayments',
    reason: 'NowPayments HMAC verification and bounded body replace a source-IP limiter.',
  },
];

const DISABLED_503 =
  'Activation-off route returns a fixed FeatureUnavailable response and performs no work.';
const STUB_EXEMPTIONS: readonly StubExemption[] = [
  // V-1756 — account-mfa and auth-cli were activation-gated with NO disabled stub,
  // so their published operations 404'd on a deployment that had not enabled them.
  // Same posture as the billing/byok stubs above: a fixed 503, no work, no state.
  ...[
    ['delete', '/v1/account/mfa'],
    ['post', '/v1/account/mfa/enroll'],
    ['post', '/v1/account/mfa/verify'],
    ['post', '/v1/account/mfa/disable'],
    ['post', '/v1/account/mfa/recovery-codes/regenerate'],
  ].map(([method, path]) => ({
    file: 'account-mfa.ts',
    method: method!,
    path: path!,
    handler: 'stub',
    reason: DISABLED_503,
  })),
  ...[
    '/v1/auth/cli-authorize/initiate',
    '/v1/auth/cli-authorize/bind-device-code',
    '/v1/auth/cli-authorize/exchange',
  ].map((path) => ({
    file: 'auth-cli.ts',
    method: 'post',
    path,
    handler: 'stub',
    reason: DISABLED_503,
  })),
  ...['/v1/billing/checkout-session', '/v1/billing/portal-session'].map((path) => ({
    file: 'billing.ts',
    method: 'post',
    path,
    handler: 'stub',
    reason: DISABLED_503,
  })),
  ...[
    ['put', '/v1/account/me/byok-anthropic-key'],
    ['delete', '/v1/account/me/byok-anthropic-key'],
    ['post', '/v1/account/me/byok-anthropic-key/test'],
  ].map(([method, path]) => ({
    file: 'account-byok-anthropic.ts',
    method: method!,
    path: path!,
    handler: 'stub',
    reason: DISABLED_503,
  })),
  ...[
    ['post', '/v1/recipes'],
    ['delete', '/v1/recipes/:id'],
  ].map(([method, path]) => ({
    file: 'recipes.ts',
    method: method!,
    path: path!,
    handler: 'stub',
    reason: DISABLED_503,
  })),
  ...[
    ['post', '/v1/agent-sessions'],
    ['post', '/v1/agent-sessions/:id/cookies/set'],
    ['post', '/v1/agent-sessions/:id/history'],
    ['post', '/v1/agent-sessions/:id/files'],
    ['post', '/v1/agent-sessions/:id/message'],
    ['delete', '/v1/agent-sessions/:id'],
    ['post', '/v1/agent-sessions/:id/takeover'],
    ['post', '/v1/agent-sessions/:id/handback'],
    ['post', '/v1/agent-sessions/:id/mode'],
    ['post', '/v1/agent-sessions/:id/input-event'],
    ['post', '/v1/agent-sessions/:id/resume'],
  ].map(([method, path]) => ({
    file: 'agent-sessions.ts',
    method: method!,
    path: path!,
    handler: 'stub',
    reason: DISABLED_503,
  })),
  ...[
    '/v1/internal/atlas-priority/probe-signature',
    '/v1/internal/atlas-priority/event-status',
  ].map((path) => ({
    file: 'internal-atlas-priority.ts',
    method: 'post',
    path,
    handler: 'reject',
    reason: DISABLED_503,
  })),
];

function collectIpGateIdentifiers(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const identifiers = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = node.initializer;
      if (
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === 'ipRateLimit'
      ) {
        identifiers.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return identifiers;
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

function scanMutationRoutes(file: string, source: string): MutationRouteDecl[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const ipGateIdentifiers = collectIpGateIdentifiers(sourceFile);
  const routes: MutationRouteDecl[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'app' &&
      MUTATION_METHODS.has(node.expression.name.text)
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
          routes.push({
            file,
            method: node.expression.name.text,
            path,
            optionsText: optionsArg?.getText(sourceFile) ?? '',
            handlerIdentifier:
              handlerArg !== undefined && ts.isIdentifier(handlerArg) ? handlerArg.text : null,
            ipGateIdentifiers,
            hasTypeArguments: (node.typeArguments?.length ?? 0) > 0,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return routes;
}

function routeMatches(exemption: RouteExemption, route: MutationRouteDecl): boolean {
  return (
    exemption.file === route.file &&
    exemption.method === route.method &&
    exemption.path === route.path
  );
}

function isExempt(route: MutationRouteDecl): boolean {
  if (SIGNED_INGRESS_EXEMPTIONS.some((exemption) => routeMatches(exemption, route))) return true;
  return STUB_EXEMPTIONS.some(
    (exemption) => routeMatches(exemption, route) && exemption.handler === route.handlerIdentifier,
  );
}

function hasProtection(route: MutationRouteDecl): boolean {
  if (/\b(?:rateLimit|ipRateLimit)\s*\(/.test(route.optionsText)) return true;
  if (/requireScope\s*\(\s*['"]driftstack_internal_admin['"]\s*\)/.test(route.optionsText)) {
    return true;
  }
  if (/\brequireOwner\b/.test(route.optionsText)) return true;
  for (const identifier of INTERNAL_LIMITER_IDENTIFIERS) {
    if (new RegExp(`\\b${identifier}\\b`).test(route.optionsText)) return true;
  }
  for (const identifier of route.ipGateIdentifiers) {
    if (new RegExp(`\\b${identifier}\\b`).test(route.optionsText)) return true;
  }
  return false;
}

function violations(routes: readonly MutationRouteDecl[]): string[] {
  return routes
    .filter((route) => !hasProtection(route) && !isExempt(route))
    .map((route) => `${route.method.toUpperCase()} ${route.path} (${route.file})`)
    .sort();
}

describe('mutation-route rate-limit coverage invariant', () => {
  const files = readdirSync(ROUTES_DIR).filter((file) => file.endsWith('.ts'));
  const routes = files.flatMap((file) =>
    scanMutationRoutes(file, readFileSync(resolve(ROUTES_DIR, file), 'utf8')),
  );

  it('discovers the complete current mutation registration surface', () => {
    // Review tripwire, not a security assertion — the invariant below is what
    // enforces protection. Refreshed after confirming violations(routes) is
    // EMPTY at this count, i.e. all 161 mutation routes carry a limiter, a
    // privileged gate, or an exact reviewed exemption. NOTE: A3's dual
    // actor + effective-owner limiter lane will move this number again; refresh
    // it the same way (prove violations() empty first), never by chasing green.
    // V-1611 #14 — 162 since `PATCH /v1/teams/:id`. Only ONE of the two new team
    // routes is a mutation; `GET /v1/teams` is not, which is why this moves by one
    // where the caller-authority pin moves by two. Refreshed with violations()
    // proven empty first, as the note above requires.
    // V-1756 — 170 since account-mfa (+5 mutations) and auth-cli (+3) gained the
    // disabled stubs their activation gates had always lacked.
    expect(routes).toHaveLength(170);
    // +1: `app.patch<{ Params: { id: string } }>('/v1/teams/:id', ...)` is the only
    // one of the two new routes carrying type arguments.
    expect(routes.filter((route) => route.hasTypeArguments)).toHaveLength(76);
  });

  it('every mutation route has a limiter, privileged gate, or exact exemption', () => {
    const unprotected = violations(routes);
    expect(
      unprotected,
      `Unprotected mutation route(s) found — add a limiter or exact reviewed exemption:\n${unprotected.join('\n')}`,
    ).toEqual([]);
  });

  it('every exact exemption resolves to a current registration', () => {
    const allExemptions = [...SIGNED_INGRESS_EXEMPTIONS, ...STUB_EXEMPTIONS];
    const stale = allExemptions.filter(
      (exemption) =>
        !routes.some(
          (route) =>
            routeMatches(exemption, route) &&
            (!('handler' in exemption) || exemption.handler === route.handlerIdentifier),
        ),
    );
    expect(stale).toEqual([]);
  });

  it('detects an unprotected generic route despite misleading handler text', () => {
    const synthetic = scanMutationRoutes(
      'synthetic.ts',
      `app.post<{ Body: { value: string } }>(
        '/v1/admin/leak',
        async () => {
          const misleading = "app.rateLimit('global')";
          return { misleading };
        },
      );`,
    );
    expect(violations(synthetic)).toEqual(['POST /v1/admin/leak (synthetic.ts)']);
  });

  it('accepts a generic route limiter only from the options argument', () => {
    const synthetic = scanMutationRoutes(
      'synthetic.ts',
      `app.post<{ Body: { value: string } }>(
        '/v1/safe',
        { preHandler: [app.requireAuth, app.rateLimit('global')] },
        async () => ({ ok: true }),
      );`,
    );
    expect(violations(synthetic)).toEqual([]);
  });

  it('expands finite literal template domains into every mutation route', () => {
    const synthetic = scanMutationRoutes(
      'synthetic.ts',
      `for (const action of ['start', 'stop'] as const) {
        app.post(
          \`/v1/jobs/\${action}\`,
          { preHandler: [app.requireAuth, app.rateLimit('global')] },
          async () => ({ ok: true }),
        );
      }`,
    );
    expect(synthetic.map((route) => route.path)).toEqual(['/v1/jobs/start', '/v1/jobs/stop']);
    expect(violations(synthetic)).toEqual([]);
  });

  it('reports an unresolved computed route instead of silently skipping it', () => {
    const synthetic = scanMutationRoutes(
      'synthetic.ts',
      `const path = chooseMutationPath();
      app.post(path, async () => ({ changed: true }));`,
    );
    expect(violations(synthetic)).toEqual(['POST <unresolved:path> (synthetic.ts)']);
  });
});
