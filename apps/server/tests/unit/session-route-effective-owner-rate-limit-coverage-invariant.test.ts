// Session routes are dual-budgeted: the authenticated actor is charged by the
// Fastify preHandler first, then the selected effective owner is charged by the
// centralized owner limiter before route work begins. This AST guard scopes
// discovery to the three live registration functions so disabled stubs cannot
// satisfy (or inflate) the active inventory.

import { readFileSync } from 'node:fs';
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
const ROUTES_DIR = resolve(HERE, '..', '..', 'src', 'routes');
const RATE_LIMIT_MIDDLEWARE = resolve(HERE, '..', '..', 'src', 'middleware', 'rate-limit.ts');
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

interface ExpectedRoute {
  file: string;
  registrationFunction: string;
  method: string;
  path: string;
  bucket: string;
  cost: number;
  ownerVia?: 'prepareAgentMessage';
  ownerBefore?: 'transportTelemetry';
}

interface LimiterUse {
  bucket: string | null;
  cost: number | null;
  authorityBound: boolean;
  ownerAccount: string | null;
  position: number;
  text: string;
}

interface RouteRegistration {
  file: string;
  registrationFunction: string;
  method: string;
  path: string;
  options: ts.ObjectLiteralExpression | null;
  handler: ts.ArrowFunction | ts.FunctionExpression | null;
  sourceFile: ts.SourceFile;
  registrationBody: ts.Block;
}

const DIRECT_ROUTES: readonly ExpectedRoute[] = [
  route('sessions.ts', 'registerSessionRoutes', 'post', '/v1/sessions', 'sessions:create'),
  route(
    'sessions.ts',
    'registerSessionRoutes',
    'post',
    '/v1/profiles/:id/launch',
    'sessions:create',
  ),
  route('sessions.ts', 'registerSessionRoutes', 'get', '/v1/sessions', 'global'),
  route('sessions.ts', 'registerSessionRoutes', 'post', '/v1/sessions/:id/navigate', 'global'),
  route('sessions.ts', 'registerSessionRoutes', 'post', '/v1/sessions/:id/interact', 'global'),
  route('sessions.ts', 'registerSessionRoutes', 'post', '/v1/sessions/:id/gui-input', 'global'),
  route('sessions.ts', 'registerSessionRoutes', 'post', '/v1/sessions/:id/wait', 'global'),
  route('sessions.ts', 'registerSessionRoutes', 'get', '/v1/sessions/:id', 'global'),
  route('sessions.ts', 'registerSessionRoutes', 'get', '/v1/sessions/:id/state', 'global'),
  route('sessions.ts', 'registerSessionRoutes', 'post', '/v1/sessions/:id/capture', 'global'),
  route('sessions.ts', 'registerSessionRoutes', 'post', '/v1/sessions/:id/extract', 'global'),
  route('sessions.ts', 'registerSessionRoutes', 'post', '/v1/sessions/:id/search', 'global'),
  route('sessions.ts', 'registerSessionRoutes', 'post', '/v1/sessions/:id/login', 'global'),
  route('sessions.ts', 'registerSessionRoutes', 'delete', '/v1/sessions/:id', 'global'),
];

const AGENT_MAIN_ROUTES: readonly ExpectedRoute[] = [
  route('agent-sessions.ts', 'registerAgentSessionsRoutes', 'post', '/v1/agent-sessions', 'global'),
  route('agent-sessions.ts', 'registerAgentSessionsRoutes', 'get', '/v1/agent-sessions', 'global'),
  route(
    'agent-sessions.ts',
    'registerAgentSessionsRoutes',
    'get',
    '/v1/agent-sessions/:id',
    'global',
  ),
  route(
    'agent-sessions.ts',
    'registerAgentSessionsRoutes',
    'get',
    '/v1/agent-sessions/:id/page-state',
    'global',
  ),
  route(
    'agent-sessions.ts',
    'registerAgentSessionsRoutes',
    'get',
    '/v1/agent-sessions/:id/network',
    'global',
  ),
  route(
    'agent-sessions.ts',
    'registerAgentSessionsRoutes',
    'get',
    '/v1/agent-sessions/:id/cookies',
    'global',
  ),
  route(
    'agent-sessions.ts',
    'registerAgentSessionsRoutes',
    'post',
    '/v1/agent-sessions/:id/cookies/set',
    'global',
  ),
  route(
    'agent-sessions.ts',
    'registerAgentSessionsRoutes',
    'post',
    '/v1/agent-sessions/:id/egress',
    'global',
  ),
  route(
    'agent-sessions.ts',
    'registerAgentSessionsRoutes',
    'post',
    '/v1/agent-sessions/:id/history',
    'global',
  ),
  route(
    'agent-sessions.ts',
    'registerAgentSessionsRoutes',
    'post',
    '/v1/agent-sessions/:id/files',
    'global',
  ),
  route(
    'agent-sessions.ts',
    'registerAgentSessionsRoutes',
    'get',
    '/v1/agent-sessions/:id/downloads',
    'global',
  ),
  route(
    'agent-sessions.ts',
    'registerAgentSessionsRoutes',
    'get',
    '/v1/agent-sessions/:id/downloads/content',
    'global',
  ),
  route(
    'agent-sessions.ts',
    'registerAgentSessionsRoutes',
    'get',
    '/v1/agent-sessions/:id/transcript',
    'global',
  ),
  route(
    'agent-sessions.ts',
    'registerAgentSessionsRoutes',
    'get',
    '/v1/agent-sessions/:id/gui-control-key',
    'global',
  ),
  route(
    'agent-sessions.ts',
    'registerAgentSessionsRoutes',
    'post',
    '/v1/agent-sessions/:id/input-event',
    'agent_sessions:input_event',
  ),
  route(
    'agent-sessions.ts',
    'registerAgentSessionsRoutes',
    'post',
    '/v1/agent-sessions/:id/mode',
    'global',
  ),
  route(
    'agent-sessions.ts',
    'registerAgentSessionsRoutes',
    'post',
    '/v1/agent-sessions/:id/takeover',
    'global',
  ),
  route(
    'agent-sessions.ts',
    'registerAgentSessionsRoutes',
    'post',
    '/v1/agent-sessions/:id/handback',
    'global',
  ),
  {
    ...route(
      'agent-sessions.ts',
      'registerAgentSessionsRoutes',
      'post',
      '/v1/agent-sessions/:id/message',
      'agent_sessions:message',
    ),
    ownerVia: 'prepareAgentMessage',
  },
  route(
    'agent-sessions.ts',
    'registerAgentSessionsRoutes',
    'delete',
    '/v1/agent-sessions/:id',
    'global',
  ),
  route(
    'agent-sessions.ts',
    'registerAgentSessionsRoutes',
    'post',
    '/v1/agent-sessions/:id/resume',
    'global',
  ),
];

const AGENT_SPLIT_ROUTES: readonly ExpectedRoute[] = [
  route(
    'agent-sessions-livekit-token.ts',
    'registerAgentSessionsLivekitTokenRoute',
    'post',
    '/v1/agent-sessions/:id/livekit-token',
    'global',
  ),
  {
    ...route(
      'agent-sessions-transport-report.ts',
      'registerAgentSessionsTransportReportRoute',
      'post',
      '/v1/agent-sessions/:id/transport-report',
      'global',
    ),
    ownerBefore: 'transportTelemetry',
  },
];

const EXPECTED_ROUTES = [...DIRECT_ROUTES, ...AGENT_MAIN_ROUTES, ...AGENT_SPLIT_ROUTES] as const;
const SOURCE_FILES = [...new Set(EXPECTED_ROUTES.map(({ file }) => file))];
const EXPECTED_OWNER_AUTHORITY = new Map<string, string>([
  ['sessions.ts#registerSessionRoutes POST /v1/sessions', 'ownerAccountId'],
  ['sessions.ts#registerSessionRoutes POST /v1/profiles/:id/launch', 'ownerAccountId'],
  ['sessions.ts#registerSessionRoutes GET /v1/sessions', 'effective.accountId'],
  ['sessions.ts#registerSessionRoutes POST /v1/sessions/:id/navigate', 'eff ?? ctx.account.id'],
  ['sessions.ts#registerSessionRoutes POST /v1/sessions/:id/interact', 'eff ?? ctx.account.id'],
  ['sessions.ts#registerSessionRoutes POST /v1/sessions/:id/gui-input', 'eff ?? ctx.account.id'],
  ['sessions.ts#registerSessionRoutes POST /v1/sessions/:id/wait', 'eff ?? ctx.account.id'],
  ['sessions.ts#registerSessionRoutes GET /v1/sessions/:id', 'effective.accountId'],
  ['sessions.ts#registerSessionRoutes GET /v1/sessions/:id/state', 'eff ?? ctx.account.id'],
  ['sessions.ts#registerSessionRoutes POST /v1/sessions/:id/capture', 'eff ?? ctx.account.id'],
  ['sessions.ts#registerSessionRoutes POST /v1/sessions/:id/extract', 'eff ?? ctx.account.id'],
  ['sessions.ts#registerSessionRoutes POST /v1/sessions/:id/search', 'eff ?? ctx.account.id'],
  ['sessions.ts#registerSessionRoutes POST /v1/sessions/:id/login', 'eff ?? ctx.account.id'],
  ['sessions.ts#registerSessionRoutes DELETE /v1/sessions/:id', 'effective.accountId'],
  ['agent-sessions.ts#registerAgentSessionsRoutes POST /v1/agent-sessions', 'ownerAccountId'],
  ['agent-sessions.ts#registerAgentSessionsRoutes GET /v1/agent-sessions', 'effective.accountId'],
  ['agent-sessions.ts#registerAgentSessionsRoutes GET /v1/agent-sessions/:id', 'rec.accountId'],
  [
    'agent-sessions.ts#registerAgentSessionsRoutes GET /v1/agent-sessions/:id/page-state',
    'rec.accountId',
  ],
  [
    'agent-sessions.ts#registerAgentSessionsRoutes GET /v1/agent-sessions/:id/network',
    'rec.accountId',
  ],
  [
    'agent-sessions.ts#registerAgentSessionsRoutes GET /v1/agent-sessions/:id/cookies',
    'rec.accountId',
  ],
  [
    'agent-sessions.ts#registerAgentSessionsRoutes POST /v1/agent-sessions/:id/cookies/set',
    'rec.accountId',
  ],
  [
    'agent-sessions.ts#registerAgentSessionsRoutes POST /v1/agent-sessions/:id/egress',
    'rec.accountId',
  ],
  [
    'agent-sessions.ts#registerAgentSessionsRoutes POST /v1/agent-sessions/:id/history',
    'rec.accountId',
  ],
  [
    'agent-sessions.ts#registerAgentSessionsRoutes POST /v1/agent-sessions/:id/files',
    'rec.accountId',
  ],
  [
    'agent-sessions.ts#registerAgentSessionsRoutes GET /v1/agent-sessions/:id/downloads',
    'rec.accountId',
  ],
  [
    'agent-sessions.ts#registerAgentSessionsRoutes GET /v1/agent-sessions/:id/downloads/content',
    'rec.accountId',
  ],
  [
    'agent-sessions.ts#registerAgentSessionsRoutes GET /v1/agent-sessions/:id/transcript',
    'session.accountId',
  ],
  [
    'agent-sessions.ts#registerAgentSessionsRoutes GET /v1/agent-sessions/:id/gui-control-key',
    'rec.accountId',
  ],
  [
    'agent-sessions.ts#registerAgentSessionsRoutes POST /v1/agent-sessions/:id/input-event',
    'rec.accountId',
  ],
  [
    'agent-sessions.ts#registerAgentSessionsRoutes POST /v1/agent-sessions/:id/mode',
    'rec.accountId',
  ],
  [
    'agent-sessions.ts#registerAgentSessionsRoutes POST /v1/agent-sessions/:id/takeover',
    'rec.accountId',
  ],
  [
    'agent-sessions.ts#registerAgentSessionsRoutes POST /v1/agent-sessions/:id/handback',
    'rec.accountId',
  ],
  [
    'agent-sessions.ts#registerAgentSessionsRoutes POST /v1/agent-sessions/:id/message',
    'pre.accountId',
  ],
  ['agent-sessions.ts#registerAgentSessionsRoutes DELETE /v1/agent-sessions/:id', 'pre.accountId'],
  [
    'agent-sessions.ts#registerAgentSessionsRoutes POST /v1/agent-sessions/:id/resume',
    'rec.accountId',
  ],
  [
    'agent-sessions-livekit-token.ts#registerAgentSessionsLivekitTokenRoute POST /v1/agent-sessions/:id/livekit-token',
    'session.accountId',
  ],
  [
    'agent-sessions-transport-report.ts#registerAgentSessionsTransportReportRoute POST /v1/agent-sessions/:id/transport-report',
    'session.accountId',
  ],
]);

function route(
  file: string,
  registrationFunction: string,
  method: string,
  path: string,
  bucket: string,
  cost = 1,
): ExpectedRoute {
  return { file, registrationFunction, method, path, bucket, cost };
}

function sourceText(file: string): string {
  return readFileSync(resolve(ROUTES_DIR, file), 'utf8');
}

function parseSource(file: string, source: string): ts.SourceFile {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = (
    parsed as ts.SourceFile & { parseDiagnostics: readonly ts.DiagnosticWithLocation[] }
  ).parseDiagnostics;
  if (diagnostics.length > 0) {
    throw new Error(
      `${file} did not parse:\n${diagnostics
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
        .join('\n')}`,
    );
  }
  return parsed;
}

function findRegistrationBody(sourceFile: ts.SourceFile, name: string): ts.Block {
  const matches: ts.FunctionDeclaration[] = [];
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body !== undefined) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (matches.length !== 1) {
    throw new Error(
      `${sourceFile.fileName}: expected exactly one function ${name}, found ${matches.length}`,
    );
  }
  return matches[0]!.body!;
}

function literalText(node: ts.Expression | undefined): string | null {
  if (
    node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
  ) {
    return node.text;
  }
  return null;
}

function literalCost(node: ts.Expression | undefined): number | null {
  if (node === undefined) return 1;
  return ts.isNumericLiteral(node) ? Number(node.text) : null;
}

function isIdentifierNamed(node: ts.Node | undefined, expected: string): boolean {
  return node !== undefined && ts.isIdentifier(node) && node.text === expected;
}

function routeCall(node: ts.CallExpression): { method: string; path: string } | null {
  if (
    !ts.isPropertyAccessExpression(node.expression) ||
    !ts.isIdentifier(node.expression.expression) ||
    node.expression.expression.text !== 'app' ||
    !ROUTE_METHODS.has(node.expression.name.text)
  ) {
    return null;
  }
  const path = literalText(node.arguments[0]);
  return {
    method: node.expression.name.text,
    path: path ?? `<non-literal:${node.arguments[0]?.getText() ?? 'missing'}>`,
  };
}

function collectRoutes(
  file: string,
  registrationFunction: string,
  source: string,
): RouteRegistration[] {
  const sourceFile = parseSource(file, source);
  const registrationBody = findRegistrationBody(sourceFile, registrationFunction);
  const routes: RouteRegistration[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const identity = routeCall(node);
      if (identity !== null) {
        const options = node.arguments[1];
        const handler = node.arguments[2];
        routes.push({
          file,
          registrationFunction,
          ...identity,
          options: options !== undefined && ts.isObjectLiteralExpression(options) ? options : null,
          handler:
            handler !== undefined &&
            (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))
              ? handler
              : null,
          sourceFile,
          registrationBody,
        });
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(registrationBody);
  return routes;
}

function preHandlerExpression(options: ts.ObjectLiteralExpression | null): ts.Expression | null {
  if (options === null) return null;
  const properties = options.properties.filter(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      ((ts.isIdentifier(property.name) && property.name.text === 'preHandler') ||
        (ts.isStringLiteral(property.name) && property.name.text === 'preHandler')),
  );
  return properties.length === 1 ? properties[0]!.initializer : null;
}

function actorLimiterUses(routeRegistration: RouteRegistration): LimiterUse[] {
  const preHandler = preHandlerExpression(routeRegistration.options);
  if (preHandler === null) return [];
  const uses: LimiterUse[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'app' &&
      node.expression.name.text === 'rateLimit'
    ) {
      uses.push({
        bucket: literalText(node.arguments[0]),
        cost: literalCost(node.arguments[1]),
        authorityBound: true,
        ownerAccount: null,
        position: node.getStart(routeRegistration.sourceFile),
        text: node.getText(routeRegistration.sourceFile),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(preHandler);
  return uses;
}

function parameterName(
  callable: ts.ArrowFunction | ts.FunctionExpression,
  index: number,
): string | null {
  const parameter = callable.parameters[index];
  return parameter !== undefined && ts.isIdentifier(parameter.name) ? parameter.name.text : null;
}

function ownerLimiterUses(
  root: ts.Node,
  sourceFile: ts.SourceFile,
  requestName: string | null,
  replyName: string | null,
): LimiterUse[] {
  const uses: LimiterUse[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'consumeEffectiveOwnerRateLimit'
    ) {
      uses.push({
        bucket: literalText(node.arguments[4]),
        cost: literalCost(node.arguments[5]),
        authorityBound:
          requestName !== null &&
          replyName !== null &&
          isIdentifierNamed(node.arguments[0], 'app') &&
          isIdentifierNamed(node.arguments[1], requestName) &&
          isIdentifierNamed(node.arguments[2], replyName),
        ownerAccount: node.arguments[3]?.getText(sourceFile) ?? null,
        position: node.getStart(sourceFile),
        text: node.getText(sourceFile),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return uses;
}

function findNestedHelper(
  registration: RouteRegistration,
  name: string,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const matches: (ts.ArrowFunction | ts.FunctionExpression)[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      matches.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(registration.registrationBody);
  return matches.length === 1 ? matches[0]! : null;
}

function helperCalls(
  routeRegistration: RouteRegistration,
  helperName: string,
): { count: number; authorityBound: boolean } {
  const handler = routeRegistration.handler;
  if (handler === null) return { count: 0, authorityBound: false };
  const requestName = parameterName(handler, 0);
  const replyName = parameterName(handler, 1);
  let count = 0;
  let authorityBound = true;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === helperName) {
        count += 1;
        authorityBound =
          authorityBound &&
          requestName !== null &&
          replyName !== null &&
          isIdentifierNamed(node.arguments[0], requestName) &&
          isIdentifierNamed(node.arguments[1], replyName);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(handler.body);
  return { count, authorityBound };
}

function requestLogInfoPositions(
  root: ts.Node,
  sourceFile: ts.SourceFile,
  requestName: string | null,
): number[] {
  const positions: number[] = [];
  function visit(node: ts.Node): void {
    if (
      requestName !== null &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'info' &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === 'log' &&
      isIdentifierNamed(node.expression.expression.expression, requestName)
    ) {
      positions.push(node.getStart(sourceFile));
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return positions;
}

function identity(routeLike: {
  file: string;
  registrationFunction: string;
  method: string;
  path: string;
}): string {
  return `${routeLike.file}#${routeLike.registrationFunction} ${routeLike.method.toUpperCase()} ${routeLike.path}`;
}

function sameLimiterUse(actual: LimiterUse, expected: ExpectedRoute): boolean {
  return actual.bucket === expected.bucket && actual.cost === expected.cost;
}

function validateLimiter(
  errors: string[],
  label: string,
  uses: readonly LimiterUse[],
  expected: ExpectedRoute,
): void {
  if (uses.length !== 1) {
    errors.push(
      `${identity(expected)}: expected exactly one ${label} limiter, found ${uses.length}`,
    );
    return;
  }
  const use = uses[0]!;
  if (!use.authorityBound) {
    errors.push(
      `${identity(expected)}: ${label} limiter is not bound to app/request/reply authority`,
    );
  }
  if (!sameLimiterUse(use, expected)) {
    errors.push(
      `${identity(expected)}: ${label} limiter ${use.text} is ${String(use.bucket)}/${String(use.cost)}, expected ${expected.bucket}/${expected.cost}`,
    );
  }
}

function validateRouteLimiter(
  errors: string[],
  registration: RouteRegistration,
  expected: ExpectedRoute,
): void {
  const actorUses = actorLimiterUses(registration);
  validateLimiter(errors, 'actor', actorUses, expected);

  const handler = registration.handler;
  if (handler === null) {
    errors.push(`${identity(expected)}: route must use an inline function handler`);
    return;
  }

  if (expected.ownerVia === 'prepareAgentMessage') {
    const invocation = helperCalls(registration, expected.ownerVia);
    if (invocation.count !== 1 || !invocation.authorityBound) {
      errors.push(
        `${identity(expected)}: expected exactly one authority-bound ${expected.ownerVia}(request, reply) call`,
      );
    }
    const helper = findNestedHelper(registration, expected.ownerVia);
    if (helper === null) {
      errors.push(
        `${identity(expected)}: expected exactly one nested ${expected.ownerVia} implementation`,
      );
      return;
    }
    const helperOwnerUses = ownerLimiterUses(
      helper.body,
      registration.sourceFile,
      parameterName(helper, 0),
      parameterName(helper, 1),
    );
    validateLimiter(errors, `${expected.ownerVia} owner`, helperOwnerUses, expected);
    validateOwnerAuthority(errors, helperOwnerUses, expected);
    const directUses = ownerLimiterUses(
      handler.body,
      registration.sourceFile,
      parameterName(handler, 0),
      parameterName(handler, 1),
    );
    if (directUses.length !== 0) {
      errors.push(
        `${identity(expected)}: message handler must not bypass ${expected.ownerVia} with a second owner limiter`,
      );
    }
    return;
  }

  const ownerUses = ownerLimiterUses(
    handler.body,
    registration.sourceFile,
    parameterName(handler, 0),
    parameterName(handler, 1),
  );
  validateLimiter(errors, 'effective-owner', ownerUses, expected);
  validateOwnerAuthority(errors, ownerUses, expected);

  if (expected.ownerBefore === 'transportTelemetry') {
    const telemetryPositions = requestLogInfoPositions(
      handler.body,
      registration.sourceFile,
      parameterName(handler, 0),
    );
    if (telemetryPositions.length !== 1) {
      errors.push(
        `${identity(expected)}: expected exactly one request telemetry log, found ${telemetryPositions.length}`,
      );
    } else if (ownerUses.length === 1 && ownerUses[0]!.position >= telemetryPositions[0]!) {
      errors.push(
        `${identity(expected)}: effective-owner limiter must precede transport telemetry publication`,
      );
    }
  }

  if (actorUses.length === 1 && ownerUses.length === 1) {
    const actor = actorUses[0]!;
    const owner = ownerUses[0]!;
    if (actor.bucket !== owner.bucket || actor.cost !== owner.cost) {
      errors.push(
        `${identity(expected)}: actor ${String(actor.bucket)}/${String(actor.cost)} and owner ${String(owner.bucket)}/${String(owner.cost)} diverge`,
      );
    }
  }
}

function validateOwnerAuthority(
  errors: string[],
  uses: readonly LimiterUse[],
  expected: ExpectedRoute,
): void {
  const expectedAuthority = EXPECTED_OWNER_AUTHORITY.get(identity(expected));
  if (expectedAuthority === undefined) {
    errors.push(`${identity(expected)}: expected owner authority is not classified`);
    return;
  }
  if (uses.length === 1 && uses[0]!.ownerAccount !== expectedAuthority) {
    errors.push(
      `${identity(expected)}: owner authority ${String(uses[0]!.ownerAccount)} must be ${expectedAuthority}`,
    );
  }
}

function audit(sources: Readonly<Record<string, string>>): string[] {
  const registrations = [
    ...collectRoutes(
      'sessions.ts',
      'registerSessionRoutes',
      sources['sessions.ts'] ?? sourceText('sessions.ts'),
    ),
    ...collectRoutes(
      'agent-sessions.ts',
      'registerAgentSessionsRoutes',
      sources['agent-sessions.ts'] ?? sourceText('agent-sessions.ts'),
    ),
    ...collectRoutes(
      'agent-sessions-livekit-token.ts',
      'registerAgentSessionsLivekitTokenRoute',
      sources['agent-sessions-livekit-token.ts'] ?? sourceText('agent-sessions-livekit-token.ts'),
    ),
    ...collectRoutes(
      'agent-sessions-transport-report.ts',
      'registerAgentSessionsTransportReportRoute',
      sources['agent-sessions-transport-report.ts'] ??
        sourceText('agent-sessions-transport-report.ts'),
    ),
  ];
  const errors: string[] = [];
  const expectedByIdentity = new Map(
    EXPECTED_ROUTES.map((expected) => [identity(expected), expected]),
  );
  const actualByIdentity = new Map<string, RouteRegistration[]>();
  for (const registration of registrations) {
    const key = identity(registration);
    const matches = actualByIdentity.get(key) ?? [];
    matches.push(registration);
    actualByIdentity.set(key, matches);
    if (!expectedByIdentity.has(key)) {
      errors.push(`${key}: unclassified live route`);
    }
  }

  for (const expected of EXPECTED_ROUTES) {
    const registrationsForRoute = actualByIdentity.get(identity(expected)) ?? [];
    if (registrationsForRoute.length !== 1) {
      errors.push(
        `${identity(expected)}: expected exactly one live registration, found ${registrationsForRoute.length}`,
      );
      continue;
    }
    validateRouteLimiter(errors, registrationsForRoute[0]!, expected);
  }
  return errors.sort();
}

function replaceOnce(source: string, search: string, replacement: string): string {
  const first = source.indexOf(search);
  if (first < 0 || source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`mutation anchor must occur exactly once: ${search}`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + search.length)}`;
}

function fallbackConsumeCalls(root: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'rateLimitConsume' &&
      isIdentifierNamed(node.arguments[0], 'fallbackStore') &&
      isIdentifierNamed(node.arguments[1], 'consumeInput')
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return calls;
}

function fallbackConsumeCounts(source: string): {
  total: number;
  effectiveOwner: number;
  actor: number;
} {
  const sourceFile = parseSource('rate-limit.ts', source);
  const effectiveOwnerRoots: ts.Node[] = [];
  const actorRoots: ts.Node[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'consumeEffectiveOwner' &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      effectiveOwnerRoots.push(node.initializer.body);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      isIdentifierNamed(node.expression.expression, 'app') &&
      node.expression.name.text === 'decorate' &&
      literalText(node.arguments[0]) === 'rateLimit' &&
      node.arguments[1] !== undefined &&
      (ts.isArrowFunction(node.arguments[1]) || ts.isFunctionExpression(node.arguments[1]))
    ) {
      actorRoots.push(node.arguments[1].body);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (effectiveOwnerRoots.length !== 1 || actorRoots.length !== 1) {
    throw new Error(
      `expected one effective-owner root and one actor rateLimit decorator, found ${effectiveOwnerRoots.length}/${actorRoots.length}`,
    );
  }
  return {
    total: fallbackConsumeCalls(sourceFile).length,
    effectiveOwner: fallbackConsumeCalls(effectiveOwnerRoots[0]!).length,
    actor: fallbackConsumeCalls(actorRoots[0]!).length,
  };
}

describe('session-route effective-owner rate-limit coverage invariant', () => {
  const sources = Object.fromEntries(SOURCE_FILES.map((file) => [file, sourceText(file)]));

  // 21 main since P-17's `POST /v1/agent-sessions/:id/egress`, which consumes the
  // effective-owner limiter against `rec.accountId` exactly as its siblings do.
  it('pins exactly 14 direct routes and 23 live agent routes (21 main + 2 split)', () => {
    expect(DIRECT_ROUTES).toHaveLength(14);
    expect(AGENT_MAIN_ROUTES).toHaveLength(21);
    expect(AGENT_SPLIT_ROUTES).toHaveLength(2);
    expect(EXPECTED_ROUTES).toHaveLength(37);
    // 37 with P-17's egress route, whose owner authority is `rec.accountId`.
    expect(EXPECTED_OWNER_AUTHORITY).toHaveLength(37);
    expect(audit(sources)).toEqual([]);
  });

  it('turns RED when a live route loses its effective-owner consume', () => {
    const original = sources['sessions.ts']!;
    const mutated = replaceOnce(
      original,
      `const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
      await consumeEffectiveOwnerRateLimit(app, request, reply, effective.accountId, 'global');
      const page = await service.list`,
      `const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
      await Promise.resolve();
      const page = await service.list`,
    );
    expect(audit({ ...sources, 'sessions.ts': mutated })).toContain(
      'sessions.ts#registerSessionRoutes GET /v1/sessions: expected exactly one effective-owner limiter, found 0',
    );
  });

  it('turns RED when actor and owner buckets diverge', () => {
    const original = sources['sessions.ts']!;
    const mutated = replaceOnce(
      original,
      `const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
      await consumeEffectiveOwnerRateLimit(app, request, reply, effective.accountId, 'global');
      const page = await service.list`,
      `const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
      await consumeEffectiveOwnerRateLimit(app, request, reply, effective.accountId, 'sessions:create');
      const page = await service.list`,
    );
    const errors = audit({ ...sources, 'sessions.ts': mutated });
    expect(errors).toContain(
      "sessions.ts#registerSessionRoutes GET /v1/sessions: effective-owner limiter consumeEffectiveOwnerRateLimit(app, request, reply, effective.accountId, 'sessions:create') is sessions:create/1, expected global/1",
    );
    expect(errors).toContain(
      'sessions.ts#registerSessionRoutes GET /v1/sessions: actor global/1 and owner sessions:create/1 diverge',
    );
  });

  it('turns RED when a new live route is not explicitly classified', () => {
    const original = sources['sessions.ts']!;
    const insertionPoint = '  // ── POST /v1/sessions ─';
    const injected = `  app.get(
    '/v1/sessions/unclassified',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request, reply) => {
      await consumeEffectiveOwnerRateLimit(
        app,
        request,
        reply,
        request.account!.account.id,
        'global',
      );
      return { ok: true };
    },
  );

`;
    const mutated = replaceOnce(original, insertionPoint, `${injected}${insertionPoint}`);
    expect(audit({ ...sources, 'sessions.ts': mutated })).toContain(
      'sessions.ts#registerSessionRoutes GET /v1/sessions/unclassified: unclassified live route',
    );
  });

  it('turns RED when transport telemetry publishes before owner admission', () => {
    const original = sources['agent-sessions-transport-report.ts']!;
    const ownerConsume =
      "      await consumeEffectiveOwnerRateLimit(app, req, reply, session.accountId, 'global');\n";
    const withoutOwner = replaceOnce(original, ownerConsume, '');
    const mutated = replaceOnce(
      withoutOwner,
      '      return reply.code(204).send();',
      `${ownerConsume}      return reply.code(204).send();`,
    );
    expect(
      audit({
        ...sources,
        'agent-sessions-transport-report.ts': mutated,
      }),
    ).toContain(
      'agent-sessions-transport-report.ts#registerAgentSessionsTransportReportRoute POST /v1/agent-sessions/:id/transport-report: effective-owner limiter must precede transport telemetry publication',
    );
  });

  it('turns RED when a resource-owner authority is replaced by the actor account', () => {
    const original = sources['agent-sessions-transport-report.ts']!;
    const mutated = replaceOnce(
      original,
      "consumeEffectiveOwnerRateLimit(app, req, reply, session.accountId, 'global')",
      "consumeEffectiveOwnerRateLimit(app, req, reply, req.account!.account.id, 'global')",
    );
    expect(
      audit({
        ...sources,
        'agent-sessions-transport-report.ts': mutated,
      }),
    ).toContain(
      'agent-sessions-transport-report.ts#registerAgentSessionsTransportReportRoute POST /v1/agent-sessions/:id/transport-report: owner authority req.account!.account.id must be session.accountId',
    );
  });
});

describe('dual-budget fallback consumption invariant', () => {
  it('has exactly one bounded fallback consume in each actor and effective-owner path', () => {
    expect(fallbackConsumeCounts(readFileSync(RATE_LIMIT_MIDDLEWARE, 'utf8'))).toEqual({
      total: 2,
      effectiveOwner: 1,
      actor: 1,
    });
  });
});
