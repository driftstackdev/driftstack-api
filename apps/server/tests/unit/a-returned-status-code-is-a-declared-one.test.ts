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

/**
 * A source file with trailing comments cut away, for arms that assert a call or a
 * throw is still PRESENT.
 *
 * V-1545 — three arms in this file grew three different answers to the same
 * question, and two of them were wrong in ways only a mutation showed. Asserting
 * against raw source left an arm green when the code it pins was commented out —
 * the mutation that proves such a pin is literally "comment it out", so the pin
 * and its proof cancelled. Stripping comments with a block-comment regex went the
 * other way and deleted a whole constructor call, failing against correct source.
 * Dropping whole comment lines is not enough either: the mutation can leave live
 * code and the commented-out original on ONE line.
 *
 * Cutting at `//` handles all three. It also truncates a `https://` inside a string
 * literal, which is harmless here because nothing in this file asserts on a URL —
 * stated rather than left as a surprise for whoever adds the arm that does.
 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => (line.includes('//') ? line.slice(0, line.indexOf('//')) : line))
    .join('\n');
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
    const errorsSource = codeOf(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'));
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

    const route = codeOf(resolve(ROUTES_DIR, 'agent-sessions.ts'));
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
    const errorsSource = codeOf(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'));
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
        codeOf(resolve(ROUTES_DIR, entry.routeFile)),
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
    const service = codeOf(resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'));
    // The gate and the throw both still live in create(), and the throw is still
    // the only one of its kind in the tree — if either moves, the pins below are
    // asserting a code nothing raises.
    expect(service, 'create() still consults the legal gate').toMatch(/legalGate\.required\(/);
    expect(service, 'create() still refuses with LegalAcceptanceRequiredError').toContain(
      'throw new LegalAcceptanceRequiredError',
    );

    const errorsSource = codeOf(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'));
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
    const service = codeOf(resolve(REPO_ROOT, 'apps/server/src/services/webhooks.ts'));
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
    const service = codeOf(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
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

    const errorsSource = codeOf(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'));
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
    const profiles = codeOf(resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'));
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
    const bootstrap = codeOf(resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts'));
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

  it("V-1544 CRITICAL all three launch paths declare the storage-quota 409, which closes the candidate list. assertWithinStorageQuotaForLaunch throws StorageQuotaExceededError once an account's stored profile bytes pass its tier cap. It is unconditional — no optional dependency short-circuits it — and it is reached from resolveProfileBinding on both session paths and directly on the agent-session path, which is why one omission spanned three of the surface's most-used writes. The chain was found by resolving call targets through the type checker and walking shortest-path to the throw; reading the agent-sessions service alone showed nothing, because the throw is two modules away.", () => {
    // Trailing comments are cut before matching. V-1543 established why a
    // `.toContain` on raw source is not enough, and this arm proved it again: the
    // mutation that shows the pin works is "comment the throw out", and against raw
    // source the arm stayed GREEN while the gate no longer refused anything.
    const profiles = codeOf(resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'))
      .split('\n')
      .map((line) => (line.includes('//') ? line.slice(0, line.indexOf('//')) : line))
      .join('\n');
    const at = profiles.indexOf('async assertWithinStorageQuotaForLaunch(');
    expect(at, 'the storage gate still exists').toBeGreaterThan(-1);
    let paren = profiles.indexOf('(', at);
    let pdepth = 0;
    for (; paren < profiles.length; paren += 1) {
      if (profiles[paren] === '(') pdepth += 1;
      else if (profiles[paren] === ')') {
        pdepth -= 1;
        if (pdepth === 0) break;
      }
    }
    const open = profiles.indexOf('{', paren);
    let depth = 0;
    let end = open;
    for (; end < profiles.length; end += 1) {
      if (profiles[end] === '{') depth += 1;
      else if (profiles[end] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    expect(profiles.slice(open, end), 'the gate still refuses over the hard cap').toContain(
      'throw new StorageQuotaExceededError',
    );

    // Comment LINES dropped, not comments — V-1543 records why both alternatives fail.
    const callers = (file: string): string => codeOf(resolve(ROUTES_DIR, file));
    expect(callers('sessions.ts'), 'the session paths still run the gate').toContain(
      'assertWithinStorageQuotaForLaunch',
    );
    expect(callers('agent-sessions.ts'), 'the agent-session path still runs the gate').toContain(
      'assertWithinStorageQuotaForLaunch',
    );

    const missing = [
      'POST /v1/sessions',
      'POST /v1/profiles/{id}/launch',
      'POST /v1/agent-sessions',
    ]
      .filter((operation) => {
        const codes = declared.get(operation);
        expect(codes, `${operation} is still published`).not.toBeUndefined();
        return codes !== undefined && !codes.has('409');
      })
      .sort();
    expect(
      missing,
      'these launch paths refuse with 409 when the account is over its stored-profile cap, and a ' +
        'generated client cannot model a refusal the contract omits',
    ).toEqual([]);
  });

  it('V-1564 CRITICAL the three refusals a keyless turn can hit stay in the order the source calls deliberate: tier first (403), then consent (402), then the generic credential error (502). Each names a different fix — upgrade, flip a toggle, supply a key — and the code says so twice: the tier branch is commented "Deliberately NOT the consent error: consent is on", and the consent branch exists so the customer is not sent the generic 502 that "doesn\'t hint at the simpler dashboard fix". Reordering them compiles, keeps every status declared, and tells a paying customer to buy an upgrade they already have. Pinned statically because the 502 has no behavioural test: the branch needs a claude decomposer with no key, and every integration test that reaches this route either succeeds or is refused earlier.', () => {
    const route = codeOf(resolve(ROUTES_DIR, 'agent-sessions.ts'));

    const entry = route.indexOf(
      "resolvedByokKey === undefined && agentDecomposerKind === 'claude'",
    );
    expect(entry, 'the keyless-turn branch still exists').toBeGreaterThan(-1);

    const tier = route.indexOf('bundledLlmTierIneligible', entry);
    const consent = route.indexOf('BundledLlmConsentRequiredError', entry);
    const generic = route.indexOf('ByokAnthropicRequiredError', entry);
    for (const [name, at] of [
      ['tier refusal', tier],
      ['consent refusal', consent],
      ['credential refusal', generic],
    ] as const) {
      expect(at, `${name} still reachable from the keyless-turn branch`).toBeGreaterThan(-1);
    }

    expect(
      [tier, consent, generic],
      'the keyless-turn refusals are out of order — a customer would be told to fix the wrong thing',
    ).toEqual([tier, consent, generic].slice().sort((a, b) => a - b));
  });

  it('V-1565 CRITICAL no route validates a customer-supplied id with a hex-or-dash character class before handing it to a Postgres uuid column. `/^[0-9a-f-]{36}$/` accepts 36 hex digits with no dashes, and accepts 36 dashes, so a filter that looks validated reaches PG as an invalid uuid cast and answers 500 where the boundary owes a 400. Three route files carry a comment saying they fixed exactly this; admin-audit-log.ts fixed it for its CURSOR and left the same class in the arm that validates `admin_id` and `target_id`. Checked as a shape rather than a filename, so the fourth copy fails here instead of being found by the next person who reads a stack trace.', () => {
    const LOOSE = /\[0-9a-fA-F-\]\{36\}|\[0-9a-f-\]\{36\}/;
    const offenders: string[] = [];
    let scanned = 0;
    for (const entry of readdirSync(ROUTES_DIR)) {
      if (!entry.endsWith('.ts')) continue;
      scanned += 1;
      const code = codeOf(resolve(ROUTES_DIR, entry));
      const lines = code.split('\n');
      lines.forEach((line, i) => {
        if (LOOSE.test(line)) offenders.push(`${entry}:${(i + 1).toString()}`);
      });
    }
    // Comment lines are already cut by codeOf, so a route file DESCRIBING the old
    // pattern in prose does not count — three of them do exactly that.
    expect(scanned, 'route files scanned for the loose id shape').toBeGreaterThan(20);
    expect(
      offenders.sort(),
      'these lines accept a non-UUID as a UUID and hand it to a uuid column, turning a 400 into a 500',
    ).toEqual([]);
  });

  it('V-1566 CRITICAL a request-schema field typed as a bare z.string() is a DELEGATION POINT — the schema declines to check its shape, so something downstream must. V-1568 corrects the scope this arm itself claimed: it said exactly two on the whole surface while scanning api-types ONLY, and four more are declared inline in route files. Six in total, each bare for a stated reason — the audit-log pair accept either a raw UUID or a prefixed id, which one zod type cannot express; `keep` and `active_only` are confirmation tokens whose refusal message is the contract, narrowed to a type rather than a literal on purpose; `tabId` and `last_fill_text` are free text. Both are also precisely where V-1565 found a validator that admitted 36 dashes and handed them to a Postgres uuid column as a 500. Every other request field carries a length, a regex, an enum or a format, and PG rejects what the schema lets through. A third bare field means a third delegation, and the delegate is the part that was wrong last time.', () => {
    const TYPES_DIR = resolve(REPO_ROOT, 'packages/api-types/src');
    const bare = /^\s*([a-z_]\w*):\s*z\.string\(\)(?:\.optional\(\)|\.nullable\(\))*\s*,?\s*$/;
    const found: string[] = [];
    let schemas = 0;
    for (const entry of readdirSync(TYPES_DIR)) {
      if (!entry.endsWith('.ts')) continue;
      const lines = codeOf(resolve(TYPES_DIR, entry)).split('\n');
      let current: string | null = null;
      for (const line of lines) {
        const opened = /export const (\w*(?:Query|Request|Body|Params)\w*)\s*=\s*z\.object\(/.exec(
          line,
        );
        if (opened) {
          current = opened[1] ?? null;
          schemas += 1;
          continue;
        }
        if (current !== null && /^\s*\}\)/.test(line)) {
          current = null;
          continue;
        }
        if (current === null) continue;
        const m = bare.exec(line);
        if (m) found.push(`${current}.${m[1] ?? ''}`);
      }
    }

    // A parse that matched no schemas would report no delegation points.
    // Route files declare schemas inline, which the api-types walk cannot see —
    // the scope gap this arm carried while claiming the whole surface.
    for (const entry of readdirSync(ROUTES_DIR)) {
      if (!entry.endsWith('.ts')) continue;
      const lines = codeOf(resolve(ROUTES_DIR, entry)).split('\n');
      let current: string | null = null;
      let depth = 0;
      for (const line of lines) {
        const opened = /(?:const (\w+)\s*=\s*)?z\.object\(\{/.exec(line);
        if (opened) {
          current = opened[1] ?? `${entry}:<inline>`;
          depth = 1;
          schemas += 1;
          continue;
        }
        if (current === null) continue;
        depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
        if (depth <= 0) {
          current = null;
          continue;
        }
        const m = bare.exec(line);
        if (m) found.push(`${current}.${m[1] ?? ''}`);
      }
    }

    expect(schemas, 'schemas parsed from api-types and the route files').toBeGreaterThan(60);
    expect(
      found.sort(),
      'a request field whose shape the schema does not check — confirm something downstream does, ' +
        'the way maybeUuidFromInput does for the audit-log pair, then add it here',
    ).toEqual(
      [
        'BulkRevokeQuerySchema.keep',
        'ListAuditLogQuerySchema.admin_id',
        'ListAuditLogQuerySchema.target_id',
        'ListOAuthLinksQuerySchema.active_only',
        'NavigateHistoryBodySchema.tabId',
        'probeSignatureBodySchema.last_fill_text',
      ].sort(),
    );
  });
});
