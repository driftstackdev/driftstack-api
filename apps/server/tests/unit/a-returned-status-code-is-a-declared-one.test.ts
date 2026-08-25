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

  it("V-1535 CRITICAL three more THROWN codes are declared, each traced to its operation through the call graph rather than by proximity. A shared error mapper makes proximity useless here: propagating every code in auth.ts's mapAuthFlowError to each of its callers accuses seven auth routes of a 409 only signup can raise, and signup already declares it. Each entry below was traced, then checked in source, and is pinned three ways - the class still carries the status, the route file still throws it, and the operation still declares it - so retyping the error or removing the declaration both fail here.", () => {
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

    const TRACED: ReadonlyArray<{
      operation: string;
      code: string;
      errorClass: string;
      routeFile: string;
    }> = [
      // Unknown or cross-account profile_id. POST /v1/profiles/{id}/launch reaches
      // the same resolver and already declared 404 — the two shapes disagreed.
      {
        operation: 'POST /v1/sessions',
        code: '404',
        errorClass: 'NotFoundError',
        routeFile: 'sessions.ts',
      },
      // Pre-launch egress proxy probe: undecryptable config or a failed probe,
      // blocking the launch before any dispatch.
      {
        operation: 'POST /v1/agent-sessions',
        code: '422',
        errorClass: 'ProxyValidationFailedError',
        routeFile: 'agent-sessions.ts',
      },
      // No usable Anthropic credential, thrown beside the 402 V-1534 declared.
      {
        operation: 'POST /v1/agent-sessions/{id}/message',
        code: '502',
        errorClass: 'ByokAnthropicRequiredError',
        routeFile: 'agent-sessions.ts',
      },
    ];

    const missing: string[] = [];
    for (const entry of TRACED) {
      expect(
        statusOfClass(entry.errorClass),
        `${entry.errorClass} still carries the status this arm pins`,
      ).toBe(entry.code);
      expect(
        readFileSync(resolve(ROUTES_DIR, entry.routeFile), 'utf8'),
        `${entry.errorClass} is still thrown in ${entry.routeFile}`,
      ).toContain(`throw new ${entry.errorClass}`);
      const codes = declared.get(entry.operation);
      expect(codes, `${entry.operation} is still published`).not.toBeUndefined();
      if (codes !== undefined && !codes.has(entry.code)) {
        missing.push(`${entry.operation} can answer ${entry.code} and does not declare it`);
      }
    }
    expect(missing.sort(), 'traced throws whose operation stopped declaring them').toEqual([]);
  });

  it('V-1540 CRITICAL the two routes that MINT an api key declare the 409 their SERVICE raises. Every arm above reads apps/server/src/routes, which is a blind spot with a name: ApiKeysService.create gates on legalGate.required and throws LegalAcceptanceRequiredError, and no route file contains that throw, so the route-scoped tracer that found the last three codes could not see this one. Both minting paths reach that one service method — POST /v1/api-keys and POST /v1/auth/cli-authorize/bind-device-code — and neither declared 409. Rotation does NOT gate, so it is deliberately absent from this list.', () => {
    const service = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'),
      'utf8',
    );
    // The gate and the throw both still live in create(), and the throw is still
    // the only one of its kind in the tree — if either moves, the pins below are
    // asserting a code nothing raises.
    expect(service, 'create() still consults the legal gate').toMatch(/legalGate\.required\(/);
    expect(service, 'create() still refuses with LegalAcceptanceRequiredError').toContain(
      'throw new LegalAcceptanceRequiredError',
    );

    const errorsSource = readFileSync(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'), 'utf8');
    const match = /export class LegalAcceptanceRequiredError extends ApiError \{/.exec(
      errorsSource,
    );
    expect(match, 'the error class still exists').not.toBeNull();
    const start = (match?.index ?? 0) + (match?.[0].length ?? 0);
    let depth = 1;
    let end = start;
    while (end < errorsSource.length && depth > 0) {
      if (errorsSource[end] === '{') depth += 1;
      else if (errorsSource[end] === '}') depth -= 1;
      end += 1;
    }
    expect(
      /status:\s*(\d{3})/.exec(errorsSource.slice(start, end))?.[1],
      'LegalAcceptanceRequiredError still carries the status this arm pins',
    ).toBe('409');

    const missing = ['POST /v1/api-keys', 'POST /v1/auth/cli-authorize/bind-device-code']
      .filter((operation) => {
        const codes = declared.get(operation);
        expect(codes, `${operation} is still published`).not.toBeUndefined();
        return codes !== undefined && !codes.has('409');
      })
      .sort();
    expect(
      missing,
      'these routes mint a key through a service that refuses with 409 when the account owes a ' +
        'legal acceptance, and a generated client cannot model a refusal the contract omits',
    ).toEqual([]);
  });

  it('V-1541 CRITICAL the two webhook write routes declare the 409 WebhooksService raises. Found by resolving call targets through the TypeScript checker rather than by name, which is the general form V-1540 named and did not attempt: create refuses when the account is at MAX_ENDPOINTS_PER_ACCOUNT active endpoints or `events` arrives empty, update refuses a disabled endpoint or an empty `events`. Both live in services and no route file contains either throw. Pins the chain, not the conclusion — if the service stops refusing, this fails rather than continuing to assert a code nothing raises.', () => {
    const service = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/services/webhooks.ts'),
      'utf8',
    );
    const method = (name: string): string => {
      const at = service.indexOf(`async ${name}(`);
      expect(at, `WebhooksService.${name} still exists`).toBeGreaterThan(-1);
      // Skip the PARAMETER list before looking for the body. An earlier draft took
      // the first `{` after the name and captured the destructured argument's type
      // object instead, so the assertions below ran against a parameter signature
      // and failed on a method that had not changed.
      let paren = service.indexOf('(', at);
      let pdepth = 0;
      for (; paren < service.length; paren += 1) {
        if (service[paren] === '(') pdepth += 1;
        else if (service[paren] === ')') {
          pdepth -= 1;
          if (pdepth === 0) break;
        }
      }
      const open = service.indexOf('{', paren);
      let depth = 0;
      let i = open;
      for (; i < service.length; i += 1) {
        if (service[i] === '{') depth += 1;
        else if (service[i] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      return service.slice(open, i);
    };

    expect(method('create'), 'create still refuses at the endpoint cap').toMatch(
      /throw new ConflictError\(\s*\n?\s*`Account already has/,
    );
    expect(method('update'), 'update still refuses a disabled endpoint').toContain(
      "throw new ConflictError('Cannot update a disabled endpoint.",
    );

    const missing = ['POST /v1/webhooks', 'PATCH /v1/webhooks/{id}']
      .filter((operation) => {
        const codes = declared.get(operation);
        expect(codes, `${operation} is still published`).not.toBeUndefined();
        return codes !== undefined && !codes.has('409');
      })
      .sort();
    expect(
      missing,
      'these webhook writes refuse with 409 from the service layer, and a generated client cannot ' +
        'model a refusal the contract omits',
    ).toEqual([]);
  });

  it("V-1542 CRITICAL both session-create paths declare the 410 SessionsService.create raises. It fires when the reservation is terminalized DURING dispatch — the service's own log event is post_dispatch_activation_lost_cleanup_failed — so a terminal driver failure mid-dispatch reaches it with no customer action at all. POST /v1/sessions and POST /v1/profiles/{id}/launch both call that one method and neither declared 410. Distinguish this from the four billing 404s the same tracer flagged and this file deliberately does NOT pin: those come from `getAccount(accountId) === null` on an id requireAuth already resolved, so reaching one means the caller's own account vanished mid-request. That is an internal inconsistency, not a contract branch, and declaring it would advertise a 404 no caller can act on.", () => {
    const service = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'),
      'utf8',
    );
    const at = service.indexOf('async create(');
    expect(at, 'SessionsService.create still exists').toBeGreaterThan(-1);
    let paren = service.indexOf('(', at);
    let pdepth = 0;
    for (; paren < service.length; paren += 1) {
      if (service[paren] === '(') pdepth += 1;
      else if (service[paren] === ')') {
        pdepth -= 1;
        if (pdepth === 0) break;
      }
    }
    const open = service.indexOf('{', paren);
    let depth = 0;
    let end = open;
    for (; end < service.length; end += 1) {
      if (service[end] === '{') depth += 1;
      else if (service[end] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    expect(
      service.slice(open, end),
      'create() still refuses a reservation terminalized during dispatch',
    ).toContain('throw new SessionDestroyedError()');

    const errorsSource = readFileSync(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'), 'utf8');
    const cls = /export class SessionDestroyedError extends ApiError \{([\s\S]*?)\n\}/.exec(
      errorsSource,
    );
    expect(cls, 'SessionDestroyedError still exists').not.toBeNull();
    expect(
      /status:\s*(\d{3})/.exec(cls?.[1] ?? '')?.[1],
      'SessionDestroyedError still carries the status this arm pins',
    ).toBe('410');

    const missing = ['POST /v1/sessions', 'POST /v1/profiles/{id}/launch']
      .filter((operation) => {
        const codes = declared.get(operation);
        expect(codes, `${operation} is still published`).not.toBeUndefined();
        return codes !== undefined && !codes.has('410');
      })
      .sort();
    expect(
      missing,
      'these routes create a session that can be terminalized mid-dispatch, and a generated client ' +
        'cannot model a 410 the contract omits',
    ).toEqual([]);
  });

  it('V-1543 CRITICAL purge and transfer declare the 409 their live-session guard raises, closing the V-1541 candidate list. Both call assertNoActiveSession, which refuses while an agent session still holds the profile; bootstrap passes agentSessionsRepo into that slot specifically so the guard is not inert, and its comment records that a null there fails open. Transfer adds two more: a recipient name collision and a concurrent transfer-or-delete. NOT pinned here, and deliberately: GET /v1/profile-snapshots was flagged by the same tracer and is false — only the per-profile route passes parentProfileId, so only that route can 404, and it already declares one. Method-level propagation cannot see which argument a caller supplies.', () => {
    const profiles = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'),
      'utf8',
    );
    expect(profiles, 'purge still consults the live-session guard').toMatch(
      /async purge\([\s\S]{0,400}?assertNoActiveSession\(/,
    );
    expect(profiles, 'the guard still refuses with a conflict').toMatch(
      /assertNoActiveSession[\s\S]{0,600}?throw new ConflictError/,
    );
    expect(profiles, 'transfer still refuses a recipient name collision').toContain(
      'Recipient account already has a profile named',
    );

    // The guard is only live because bootstrap supplies the repo; a null there
    // fails open, and the 409 this arm pins would stop being reachable.
    // Comment LINES are dropped first. Two drafts failed here and both are worth
    // the comment: matching the raw source left `// agentSessionsRepo,` — the
    // literal shape of the fail-open this asserts against — satisfying the match,
    // and a regex comment-stripper mis-paired on a block comment and deleted the
    // constructor call outright, so the arm failed against correct source. Dropping
    // whole comment lines does neither.
    const bootstrap = readFileSync(resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts'), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(bootstrap, 'ProfilesService is still constructed with the agent-sessions repo').toMatch(
      /new ProfilesService\([\s\S]{0,1400}?agentSessionsRepo/,
    );

    const missing = ['DELETE /v1/profiles/{id}/purge', 'POST /v1/profiles/{id}/transfer']
      .filter((operation) => {
        const codes = declared.get(operation);
        expect(codes, `${operation} is still published`).not.toBeUndefined();
        return codes !== undefined && !codes.has('409');
      })
      .sort();
    expect(
      missing,
      'these profile operations refuse with 409 while a session holds the profile, and a generated ' +
        'client cannot model a refusal the contract omits',
    ).toEqual([]);
  });
});
