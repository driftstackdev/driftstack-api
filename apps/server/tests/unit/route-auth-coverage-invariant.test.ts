// Every literal Fastify route must either carry structural caller authority or
// match one exact, reviewed unauthenticated/manual-auth/disabled registration.
//
// Discover the full surface first. Public-looking paths, handler-body auth text
// and registration formatting never grant an exemption implicitly.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = resolve(HERE, '..', '..', 'src', 'routes');
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const FASTIFY_AUTHORITY_PROPERTIES = new Set([
  'requireAuth',
  'requireAuthEventSource',
  'requireScope',
  'requireOwner',
]);
const CUSTOM_AUTHORITY_IDENTIFIERS = new Set([
  'requireInternalAuth',
  'requireInteractiveWebSession',
  'controlKeyOrAccountAuth',
  'authenticateFleetUpgrade',
]);

type SecurityClass = 'public' | 'manual-auth' | 'disabled';

interface RouteDecl {
  file: string;
  registrationFunction: string;
  method: string;
  path: string;
  handler: string;
  structurallyAuthorized: boolean;
}

interface RouteExemption {
  file: string;
  registrationFunction: string;
  method: string;
  path: string;
  handler: string;
  securityClass: SecurityClass;
  reason: string;
}

function exactRoutes(
  file: string,
  registrationFunction: string,
  entries: readonly (readonly [method: string, path: string])[],
  handler: string,
  securityClass: SecurityClass,
  reason: string,
): RouteExemption[] {
  return entries.map(([method, path]) => ({
    file,
    registrationFunction,
    method,
    path,
    handler,
    securityClass,
    reason,
  }));
}

const PUBLIC_PROTOCOL = 'Deliberately anonymous protocol/status surface with its own abuse bound.';
const DISABLED_503 =
  'Activation-off handler performs no work and always returns FeatureUnavailable.';

const PUBLIC_EXEMPTIONS: readonly RouteExemption[] = [
  ...exactRoutes(
    'admin-incidents.ts',
    'registerAdminIncidentsRoutes',
    [
      ['get', '/v1/status/incidents'],
      ['get', '/v1/status/incidents/:id'],
    ],
    'inline',
    'public',
    PUBLIC_PROTOCOL,
  ),
  ...exactRoutes(
    'auth-cli.ts',
    'registerAuthCliRoutes',
    [
      ['post', '/v1/auth/cli-authorize/initiate'],
      ['post', '/v1/auth/cli-authorize/exchange'],
    ],
    'inline',
    'public',
    PUBLIC_PROTOCOL,
  ),
  ...exactRoutes(
    'auth-oauth-client.ts',
    'registerOAuthClientRoutes',
    [
      ['post', '/v1/auth/oauth-client/start'],
      ['get', '/v1/auth/oauth-client/callback'],
      ['post', '/v1/auth/oauth-client/confirm-merge'],
    ],
    'inline',
    'public',
    PUBLIC_PROTOCOL,
  ),
  ...exactRoutes(
    'auth.ts',
    'registerAuthRoutes',
    [
      ['post', '/v1/auth/signup'],
      ['post', '/v1/auth/verify-email'],
      ['post', '/v1/auth/resend-verification'],
      ['post', '/v1/auth/login'],
      ['post', '/v1/auth/mfa/challenge'],
      ['post', '/v1/auth/magic-link/request'],
      ['post', '/v1/auth/magic-link/consume'],
      ['post', '/v1/auth/password-reset/request'],
      ['post', '/v1/auth/password-reset/confirm'],
      ['post', '/v1/auth/refresh'],
      ['post', '/v1/auth/logout'],
    ],
    'inline',
    'public',
    PUBLIC_PROTOCOL,
  ),
  ...exactRoutes(
    'egress-echo.ts',
    'registerEgressEchoRoutes',
    [['get', '/v1/egress/echo']],
    'inline',
    'public',
    'Privacy-preserving unauthenticated exit-IP echo with a dedicated IP gate.',
  ),
  ...exactRoutes(
    'oauth.ts',
    'registerOAuthRoutes',
    [
      ['get', '/v1/oauth/authorize'],
      ['post', '/v1/oauth/token'],
      ['post', '/v1/oauth/introspect'],
      ['post', '/v1/oauth/revoke'],
    ],
    'inline',
    'public',
    PUBLIC_PROTOCOL,
  ),
  ...exactRoutes(
    'openapi.ts',
    'registerOpenApiRoutes',
    [['get', '/openapi.json']],
    'inline',
    'public',
    'Public API contract document.',
  ),
  ...exactRoutes(
    'status-stream.ts',
    'registerStatusStreamRoutes',
    [
      ['get', '/v1/status/stream'],
      ['get', '/v1/status/sla'],
    ],
    'inline',
    'public',
    PUBLIC_PROTOCOL,
  ),
  ...exactRoutes(
    'status-subscribe.ts',
    'registerStatusSubscribeRoutes',
    [
      ['post', '/v1/status/subscribe'],
      ['get', '/v1/status/subscribe/confirm'],
      ['get', '/v1/status/subscribe/unsubscribe'],
    ],
    'inline',
    'public',
    PUBLIC_PROTOCOL,
  ),
  ...exactRoutes(
    'status.ts',
    'registerStatusRoutes',
    [['get', '/v1/status']],
    'inline',
    'public',
    'Public status snapshot.',
  ),
  ...exactRoutes(
    'webhooks-nowpayments.ts',
    'registerNowpaymentsWebhookRoutes',
    [['post', '/v1/webhooks/nowpayments']],
    'inline',
    'public',
    'Public provider ingress authenticated by bounded-body HMAC verification.',
  ),
  ...exactRoutes(
    'webhooks-stripe.ts',
    'registerStripeWebhookRoutes',
    [['post', '/v1/webhooks/stripe']],
    'inline',
    'public',
    'Public provider ingress authenticated by bounded-body HMAC verification.',
  ),
];

const MANUAL_AUTH_EXEMPTIONS: readonly RouteExemption[] = exactRoutes(
  'metrics.ts',
  'registerMetricsRoutes',
  [['get', '/metrics']],
  'inline',
  'manual-auth',
  'Handler performs constant-time bearer-token verification and fails closed when unconfigured.',
);

const DISABLED_EXEMPTIONS: readonly RouteExemption[] = [
  ...exactRoutes(
    'account-byok-anthropic.ts',
    'registerAccountByokAnthropicDisabledRoutes',
    [
      ['get', '/v1/account/me/byok-anthropic-key'],
      ['put', '/v1/account/me/byok-anthropic-key'],
      ['delete', '/v1/account/me/byok-anthropic-key'],
      ['post', '/v1/account/me/byok-anthropic-key/test'],
    ],
    'stub',
    'disabled',
    DISABLED_503,
  ),
  ...exactRoutes(
    'agent-sessions.ts',
    'registerAgentSessionsDisabledRoutes',
    [
      ['post', '/v1/agent-sessions'],
      ['get', '/v1/agent-sessions'],
      ['get', '/v1/agent-sessions/:id'],
      ['get', '/v1/agent-sessions/:id/page-state'],
      ['get', '/v1/agent-sessions/:id/cookies'],
      ['post', '/v1/agent-sessions/:id/cookies/set'],
      ['post', '/v1/agent-sessions/:id/history'],
      ['post', '/v1/agent-sessions/:id/files'],
      ['get', '/v1/agent-sessions/:id/downloads'],
      ['get', '/v1/agent-sessions/:id/downloads/content'],
      ['post', '/v1/agent-sessions/:id/message'],
      ['delete', '/v1/agent-sessions/:id'],
      ['post', '/v1/agent-sessions/:id/takeover'],
      ['post', '/v1/agent-sessions/:id/handback'],
      ['post', '/v1/agent-sessions/:id/mode'],
      ['post', '/v1/agent-sessions/:id/input-event'],
      ['post', '/v1/agent-sessions/:id/resume'],
    ],
    'stub',
    'disabled',
    DISABLED_503,
  ),
  ...exactRoutes(
    'billing.ts',
    'registerBillingDisabledRoutes',
    [
      ['post', '/v1/billing/checkout-session'],
      ['post', '/v1/billing/portal-session'],
      ['get', '/v1/billing'],
      ['get', '/v1/account/me/billing-portal'],
    ],
    'stub',
    'disabled',
    DISABLED_503,
  ),
  ...exactRoutes(
    'fleet-events.ts',
    'registerFleetEventsDisabledRoutes',
    [['get', '/v1/fleet/events']],
    'inline',
    'disabled',
    DISABLED_503,
  ),
  ...exactRoutes(
    'internal-atlas-priority.ts',
    'registerInternalAtlasPriorityDisabledRoutes',
    [
      ['post', '/v1/internal/atlas-priority/probe-signature'],
      ['post', '/v1/internal/atlas-priority/event-status'],
      ['get', '/v1/internal/atlas-priority/queue'],
      ['get', '/v1/internal/atlas-priority/event/:id'],
    ],
    'reject',
    'disabled',
    DISABLED_503,
  ),
  ...exactRoutes(
    'recipes.ts',
    'registerRecipesDisabledRoutes',
    [
      ['get', '/v1/agent-sessions/:id/recipe-suggestion'],
      ['post', '/v1/recipes'],
      ['get', '/v1/recipes'],
      ['get', '/v1/recipes/:id'],
      ['delete', '/v1/recipes/:id'],
    ],
    'stub',
    'disabled',
    DISABLED_503,
  ),
];

const EXEMPTIONS = [...PUBLIC_EXEMPTIONS, ...MANUAL_AUTH_EXEMPTIONS, ...DISABLED_EXEMPTIONS];

function registrationFunctionFor(
  node: ts.Node,
  receiver: string,
  sourceFile: ts.SourceFile,
): ts.FunctionDeclaration | null {
  let parent: ts.Node | undefined = node.parent;
  while (parent !== undefined) {
    if (
      ts.isFunctionDeclaration(parent) &&
      parent.parameters.some(
        (parameter) =>
          ts.isIdentifier(parameter.name) &&
          parameter.name.text === receiver &&
          parameter.type?.getText(sourceFile).includes('FastifyInstance') === true,
      )
    ) {
      return parent;
    }
    parent = parent.parent;
  }
  return null;
}

function hasStructuralAuthority(optionsArg: ts.Expression | undefined): boolean {
  if (optionsArg === undefined) return false;
  let found = false;
  function visit(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node) && FASTIFY_AUTHORITY_PROPERTIES.has(node.name.text)) {
      found = true;
      return;
    }
    if (ts.isIdentifier(node) && CUSTOM_AUTHORITY_IDENTIFIERS.has(node.text)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(optionsArg);
  return found;
}

function scanRoutes(file: string, source: string): RouteDecl[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const routes: RouteDecl[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      METHODS.has(node.expression.name.text)
    ) {
      const registrationFunction = registrationFunctionFor(
        node,
        node.expression.expression.text,
        sourceFile,
      );
      const pathArg = node.arguments[0];
      if (
        registrationFunction !== null &&
        pathArg !== undefined &&
        (ts.isStringLiteral(pathArg) || ts.isNoSubstitutionTemplateLiteral(pathArg)) &&
        pathArg.text.startsWith('/')
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
          registrationFunction: registrationFunction.name?.text ?? '<anonymous>',
          method: node.expression.name.text,
          path: pathArg.text,
          handler:
            handlerArg !== undefined && ts.isIdentifier(handlerArg)
              ? handlerArg.text
              : handlerArg !== undefined &&
                  (ts.isArrowFunction(handlerArg) || ts.isFunctionExpression(handlerArg))
                ? 'inline'
                : '<unknown>',
          structurallyAuthorized: hasStructuralAuthority(optionsArg),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return routes;
}

function routeMatches(exemption: RouteExemption, route: RouteDecl): boolean {
  return (
    exemption.file === route.file &&
    exemption.registrationFunction === route.registrationFunction &&
    exemption.method === route.method &&
    exemption.path === route.path &&
    exemption.handler === route.handler
  );
}

function violations(routes: readonly RouteDecl[]): string[] {
  return routes
    .filter(
      (route) =>
        !route.structurallyAuthorized &&
        !EXEMPTIONS.some((exemption) => routeMatches(exemption, route)),
    )
    .map(
      (route) =>
        `${route.method.toUpperCase()} ${route.path} (${route.file}#${route.registrationFunction})`,
    )
    .sort();
}

describe('all-route caller-authority invariant', () => {
  const files = readdirSync(ROUTES_DIR).filter((file) => file.endsWith('.ts'));
  const routes = files.flatMap((file) =>
    scanRoutes(file, readFileSync(resolve(ROUTES_DIR, file), 'utf8')),
  );

  it('discovers the complete current Fastify registration surface', () => {
    expect(routes).toHaveLength(282);
    expect(routes.filter((route) => route.structurallyAuthorized)).toHaveLength(214);
  });

  it('every route has structural caller authority or one exact reviewed exemption', () => {
    const unclassified = violations(routes);
    expect(
      unclassified,
      `Route(s) lack caller authority and an exact reviewed exemption:\n${unclassified.join('\n')}`,
    ).toEqual([]);
  });

  it('the anonymous/manual/disabled surface is exact, unique, and non-stale', () => {
    expect(PUBLIC_EXEMPTIONS).toHaveLength(32);
    expect(MANUAL_AUTH_EXEMPTIONS).toHaveLength(1);
    expect(DISABLED_EXEMPTIONS).toHaveLength(35);
    const exemptionKeys = EXEMPTIONS.map((exemption) =>
      [
        exemption.file,
        exemption.registrationFunction,
        exemption.method,
        exemption.path,
        exemption.handler,
      ].join('|'),
    );
    expect(new Set(exemptionKeys).size).toBe(EXEMPTIONS.length);
    const stale = EXEMPTIONS.filter(
      (exemption) => !routes.some((route) => routeMatches(exemption, route)),
    );
    const noLongerNeeded = EXEMPTIONS.filter((exemption) =>
      routes.some((route) => routeMatches(exemption, route) && route.structurallyAuthorized),
    );
    expect(stale).toEqual([]);
    expect(noLongerNeeded).toEqual([]);
  });

  it('detects an ungated route even when its handler contains misleading auth text', () => {
    const synthetic = scanRoutes(
      'synthetic.ts',
      `function registerSyntheticRoutes(server: FastifyInstance): void {
        server.get('/v1/customer/leak', async () => {
          const misleading = 'server.requireAuth';
          return { misleading };
        });
      }`,
    );
    expect(violations(synthetic)).toEqual([
      'GET /v1/customer/leak (synthetic.ts#registerSyntheticRoutes)',
    ]);
  });

  it('accepts authority only when it is structurally present in route options', () => {
    const synthetic = scanRoutes(
      'synthetic.ts',
      `function registerSyntheticRoutes(server: FastifyInstance): void {
        server.get(
          '/v1/customer/safe',
          { preHandler: [server.requireAuth, server.requireScope('read')] },
          async () => ({ ok: true }),
        );
      }`,
    );
    expect(violations(synthetic)).toEqual([]);
  });

  it('does not infer exemptions from a public-looking path', () => {
    const synthetic = scanRoutes(
      'synthetic.ts',
      `function registerSyntheticRoutes(server: FastifyInstance): void {
        server.get('/v1/status/private-leak', async () => ({ secret: true }));
      }`,
    );
    expect(violations(synthetic)).toEqual([
      'GET /v1/status/private-leak (synthetic.ts#registerSyntheticRoutes)',
    ]);
  });
});
