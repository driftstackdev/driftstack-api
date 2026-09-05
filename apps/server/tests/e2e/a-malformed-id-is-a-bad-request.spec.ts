// V-1581 — the route/database seam, swept.
//
// Why this exists. V-1580 fixed two admin routes that answered 500 for a
// malformed `:id`: the value reached a `uuid` column, Postgres refused the cast,
// and the operator saw a server error for what is plainly a bad request. The
// defect was invisible to both halves of the existing suite, and that is the
// part worth guarding rather than the two routes.
//
// Route tests wire `buildTestApp`, whose 47 in-memory repos key off a JS Map —
// where a garbage id is simply a key that is not present, so the natural
// assertion is 404 and it passes. Database tests exercise the repos directly and
// never enter a route, so nothing they do involves a path parameter. Measured
// while writing this: NOT ONE database-gated integration file injects HTTP. The
// bug lived exactly in the seam between the two, which is why one of the routes
// carried a 404 assertion for the precise input that produced a 500 in
// production.
//
// This spec is the seam. It runs against the real Postgres the e2e job already
// provides, and it enumerates its own targets from `openapi.json` — a document
// generated from the route definitions rather than written alongside them — so a
// new id-taking route is swept the day it is published, without anyone
// remembering to add it here.
//
// What it asserts is deliberately weak and therefore durable: a malformed id may
// be a 400, a 404, a 401/403 before the id is ever read, or a 422. It may not be
// a 5xx. That is the whole contract — a client's bad input is never the server's
// error — and it is the one property that cannot be satisfied by accident.
//
// One exception, and it is a typed one. Nine of these routes sit behind a
// deployment activation flag and answer 503 `feature-unavailable` before any
// parameter is read — AI chat, recipes, and customer-configurable egress are all
// off unless the operator turns them on. That is an intentional refusal with a
// declared problem type, not a failure, so it is accepted on the strength of the
// `type` field rather than the status code: a route that genuinely breaks cannot
// borrow the exemption by returning a bare 503.
//
// The cost of that exemption is that those nine are NOT swept for the defect
// this spec exists to catch, and a guard that quietly covers two thirds of its
// roster is worse than one that says so. The gated set is therefore printed and
// its size asserted, so switching a feature on widens the sweep and switching
// one off cannot silently narrow it past the point of meaning.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';
import { seedAccount, authHeader } from './helpers/seed.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');

/**
 * A value that is well-formed as a URL segment and malformed as every id this
 * surface issues: not a uuid, and not a `xxx_<uuid>` public id. It has to
 * survive routing to reach the handler, which is the point — the refusal must
 * come from the route, not from Fastify failing to match a path.
 */
const MALFORMED = 'not-a-uuid';

/**
 * Well-formed and certainly absent.
 *
 * V-1585 — the malformed pass above is refused early by every route that checks
 * the shape of its id, which is most of them and is correct behaviour. That means
 * it never reaches the lookup, and everything behind the lookup went untested:
 * four admin actions answered 500 for an account that simply does not exist, and
 * this spec was green over all four. A second pass with a well-formed id that
 * matches nothing is what actually exercises the miss path.
 */
const ABSENT_UUID = '11111111-2222-3333-4444-555555555555';

/** Paths whose single parameter is not an id at all. */
const NOT_AN_ID = new Set<string>();

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type Method = (typeof METHODS)[number];

/**
 * Operations that answer 2xx for an id that cannot exist, and are entitled to.
 *
 * V-1584 — only one, and it is a considered idiom rather than an oversight:
 * `revokeClient` returns silently when the client is absent, so revoking twice
 * is the same as revoking once. The sibling GET on the same path answers 404,
 * which makes the pair inconsistent but not wrong. Listed rather than excluded
 * from the sweep, so that if a second one ever appears it has to be argued for
 * here instead of just passing.
 */
/**
 * Problem types that mean "this deployment does not do that", not "this broke".
 *
 * Both are declared, typed refusals emitted before any work is attempted:
 * `feature-unavailable` is an activation flag (AI chat, recipes, egress) and
 * `driver-not-integrated` is a browser driver that does not implement the
 * operation here. Membership is keyed on the type, never on the 503, so a route
 * that genuinely fails cannot inherit the exemption by returning a bare 503.
 *
 * V-1585 — the second of these only became reachable once the sweep started
 * sending bodies the handlers accept; with an empty body those operations were
 * refused earlier and the gate was never seen.
 */
const DEPLOYMENT_GATES = [
  'errors.driftstack.dev/feature-unavailable',
  'errors.driftstack.dev/driver-not-integrated',
] as const;

const isDeploymentGate = (status: number, text: string): boolean =>
  status === 503 && DEPLOYMENT_GATES.some((t) => text.includes(t));

/**
 * Fastify's own "there is no such route" answer.
 *
 * V-1587 — this sweep counted a 404 as a healthy refusal, and an operation whose
 * module was never registered answers 404 too. Two of the 106 declared
 * operations are still in that state under the e2e harness: `buildApp` registers
 * several route modules only when an optional dependency is supplied
 * (`if (deps.incidentsService !== undefined)` and its siblings), and the harness
 * supplies a subset. It was twenty when this was written — V-1588 wired the
 * incidents service and the force-action repos, which the harness already had —
 * and the rest need dependencies that would have to be invented. So a fifth of
 * the roster was being scored as covered while
 * nothing behind those paths was ever reached — the same silently-inert shape
 * this suite keeps finding, this time in the guard rather than in the code.
 *
 * They are counted separately, listed, and bounded. Nothing here is a production
 * defect: every one of these routes is registered by the real application.
 */
const isUnrouted = (status: number, text: string): boolean =>
  status === 404 && /No route for/i.test(text);

const IDEMPOTENT_ON_MISSING = new Set<string>(['DELETE /v1/admin/oauth/clients/{id}']);

/**
 * A body that satisfies the operation's required scalar fields, and nothing more.
 *
 * V-1585 — without this the mutating half of the sweep is shadowed: a handler
 * that parses its body before looking the id up answers 400 for the body and the
 * id is never judged. That is not hypothetical — `POST /v1/admin/accounts/{id}/tier`
 * is one of the four routes that answered 500 for an absent account, and an
 * empty-body sweep cannot see it because `ChangeTierRequestSchema` rejects `{}`
 * first.
 *
 * Only required scalars are filled, and only from the schema: an enum takes its
 * first value, a string 'x', a number its declared minimum. Required object and
 * array fields are left out rather than guessed, so those operations stay
 * body-shadowed — six of them, reported rather than papered over.
 */
type JsonNode = Record<string, unknown>;

function minimalBody(
  doc: JsonNode,
  op: unknown,
): { data: Record<string, unknown>; complete: boolean; query: string } {
  const deref = (node: unknown): JsonNode | undefined => {
    let cur = typeof node === 'object' && node !== null ? (node as JsonNode) : undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const ref = cur?.['$ref'];
      if (typeof ref !== 'string') break;
      let walk: unknown = doc;
      for (const key of ref.replace(/^#\//, '').split('/')) {
        walk = typeof walk === 'object' && walk !== null ? (walk as JsonNode)[key] : undefined;
      }
      cur = typeof walk === 'object' && walk !== null ? (walk as JsonNode) : undefined;
    }
    return cur;
  };
  /**
   * A value satisfying `node`, or undefined when one cannot be built from the
   * schema alone.
   *
   * V-1589 — this handled scalars only, which left the discriminated-union and
   * array-bodied operations permanently shadowed: five session routes could not
   * be swept because their body was rejected before the id was looked at. A
   * `oneOf` takes its FIRST variant rather than trying them all — the point is to
   * get a body the handler accepts so the id is reached, not to exercise the
   * union — and an array takes exactly one item, since `minItems` on this surface
   * is never more than one.
   *
   * Depth-capped. A self-referential schema would otherwise recurse forever, and
   * a sweep that hangs is worse than one that skips.
   */
  const scalar = (node: unknown, depth = 0): unknown => {
    if (depth > 6) return undefined;
    const sc = deref(node) ?? {};
    const en = sc['enum'];
    if (Array.isArray(en) && en.length > 0) return en[0];

    const variants = sc['oneOf'] ?? sc['anyOf'];
    if (Array.isArray(variants) && variants.length > 0) {
      return scalar(variants[0], depth + 1);
    }

    // JSON Schema allows `type` to be a list, and this surface uses it for
    // nullable fields — `['string', 'null']`. Taking the first non-null member is
    // what makes those buildable; treating the whole array as an unknown type is
    // what left the two crypto-orders notes shadowed.
    const declared = sc['type'];
    const kind = Array.isArray(declared) ? declared.find((t) => t !== 'null') : declared;

    switch (kind) {
      case 'string':
        return sc['format'] === 'date-time' ? '2026-01-01T00:00:00.000Z' : 'x';
      case 'integer':
      case 'number':
        return typeof sc['minimum'] === 'number' ? sc['minimum'] : 1;
      case 'boolean':
        return true;
      case 'array': {
        const item = scalar(sc['items'], depth + 1);
        return item === undefined ? undefined : [item];
      }
      case 'object': {
        const req = Array.isArray(sc['required']) ? (sc['required'] as string[]) : [];
        const props =
          typeof sc['properties'] === 'object' && sc['properties'] !== null
            ? (sc['properties'] as JsonNode)
            : {};
        const out: Record<string, unknown> = {};
        for (const key of req) {
          const value = scalar(props[key], depth + 1);
          if (value === undefined) return undefined;
          out[key] = value;
        }
        return out;
      }
      default:
        return undefined;
    }
  };
  const opNode = typeof op === 'object' && op !== null ? (op as JsonNode) : undefined;
  const content = deref(opNode?.['requestBody'])?.['content'];
  const json =
    typeof content === 'object' && content !== null
      ? (content as JsonNode)['application/json']
      : undefined;
  const schema = deref(
    typeof json === 'object' && json !== null ? (json as JsonNode)['schema'] : undefined,
  );
  if (!schema) return { data: {}, complete: true, query: requiredQuery(opNode, scalar) };
  const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
  const props =
    typeof schema['properties'] === 'object' && schema['properties'] !== null
      ? (schema['properties'] as JsonNode)
      : {};
  const data: Record<string, unknown> = {};
  let complete = true;
  for (const key of required) {
    const value = scalar(props[key]);
    if (value === undefined) complete = false;
    else data[key] = value;
  }
  return { data, complete, query: requiredQuery(opNode, scalar) };
}

/**
 * The operation's REQUIRED query parameters, filled from their own schemas.
 *
 * V-1586 — the third way this sweep was shadowed. A body the handler rejects was
 * one, an id shape the route refuses early was another, and a required query
 * parameter is the third: `DELETE /v1/admin/accounts/{id}/quota-override`
 * answers 400 for a missing `bucket_key` before it looks at the account at all,
 * and behind that 400 it was answering 500 for an account that does not exist.
 *
 * Optional parameters are deliberately left off. Supplying them would change the
 * question from "is the id judged" to "does some filter combination work".
 */
function requiredQuery(op: JsonNode | undefined, scalar: (node: unknown) => unknown): string {
  const params = op?.['parameters'];
  if (!Array.isArray(params)) return '';
  const pairs: string[] = [];
  for (const raw of params) {
    const pm = typeof raw === 'object' && raw !== null ? (raw as JsonNode) : undefined;
    if (pm?.['in'] !== 'query' || pm['required'] !== true) continue;
    const name = pm['name'];
    if (typeof name !== 'string') continue;
    const value = scalar(pm['schema']);
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      continue;
    }
    pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

interface Operation {
  method: Method;
  path: string;
  key: string;
  body: Record<string, unknown>;
  bodyComplete: boolean;
  query: string;
}

function idTakingOperations(): Operation[] {
  const doc = JSON.parse(readFileSync(SPEC, 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const paths = Object.keys(doc.paths);
  // An empty or unparsed document would make every assertion below vacuous, so
  // the population is asserted before it is used.
  expect(paths.length, 'the spec parsed and has paths').toBeGreaterThan(100);
  const out: Operation[] = [];
  for (const path of paths.sort()) {
    if ((path.match(/\{/g) ?? []).length !== 1) continue;
    if (NOT_AN_ID.has(path)) continue;
    for (const method of METHODS) {
      if (doc.paths[path]?.[method] === undefined) continue;
      const { data, complete, query } = minimalBody(doc, doc.paths[path]?.[method]);
      out.push({
        method,
        path,
        key: `${method.toUpperCase()} ${path}`,
        body: data,
        bodyComplete: complete,
        query,
      });
    }
  }
  return out;
}

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test('no id-taking route answers 5xx or 2xx for a malformed id', async ({ request }) => {
  await server.resetState();

  // Internal-admin so the admin half of the surface is reached rather than
  // stopped at authorization. A route that refuses before reading the id is a
  // pass either way; what must not happen is a cast error behind the check.
  const admin = await seedAccount(server.client, {
    scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
  });
  const headers = authHeader(admin.plaintext);

  const targets = idTakingOperations();
  expect(targets.length, 'the sweep has targets').toBeGreaterThan(80);
  expect(
    targets.filter((o) => o.method !== 'get').length,
    'and the mutating half is in scope, which is where the schedule bug lived',
  ).toBeGreaterThan(60);

  const serverErrors: string[] = [];
  const succeeded: string[] = [];
  const gated: string[] = [];
  const exercised: string[] = [];
  const unrouted: string[] = [];

  for (const op of targets) {
    const url = server.baseUrl + op.path.replace(/\{[^}]+\}/, MALFORMED) + op.query;
    // An empty object rather than no body at all: several handlers parse the
    // body before the id, and omitting it entirely changes which error comes
    // back without changing what is being tested.
    const opts = {
      headers,
      ...(op.method === 'get' || op.method === 'delete' ? {} : { data: op.body }),
    };
    const res =
      op.method === 'get'
        ? await request.get(url, opts)
        : op.method === 'delete'
          ? await request.delete(url, opts)
          : op.method === 'put'
            ? await request.put(url, opts)
            : op.method === 'patch'
              ? await request.patch(url, opts)
              : await request.post(url, opts);
    const status = res.status();
    let text = '';
    try {
      text = await res.text();
    } catch {
      text = '<unreadable>';
    }

    if (isUnrouted(status, text)) {
      unrouted.push(op.key);
      continue;
    }

    if (status >= 500) {
      // The exemption is keyed on the declared problem type, not on the status,
      // so a route that breaks cannot inherit it by happening to answer 503.
      if (isDeploymentGate(status, text)) {
        gated.push(op.key);
      } else {
        serverErrors.push(`${op.key} -> ${status} ${text.slice(0, 200)}`);
      }
      continue;
    }

    if (status < 300 && !IDEMPOTENT_ON_MISSING.has(op.key)) {
      succeeded.push(`${op.key} -> ${status}`);
      continue;
    }

    exercised.push(`${status} ${op.key}`);
  }

  // Printed unconditionally: the value of this spec is the roster it walks, and
  // a silent pass tells a later reader nothing about what was actually covered.
  console.log(
    `[V-1584] ${targets.length} id-taking operations — ${exercised.length} refused, ` +
      `${gated.length} behind a deployment flag, ${unrouted.length} not registered here:\n` +
      `REFUSED\n${exercised.join('\n')}\nGATED (not swept)\n${gated.join('\n')}\n` +
      `NOT ROUTABLE (not swept)\n${unrouted.join('\n')}`,
  );

  expect(
    serverErrors,
    'a malformed id is the client getting it wrong, never the server failing',
  ).toEqual([]);

  // The assertion that actually found something. A route answering 2xx for an id
  // that cannot exist has not looked the id up — the validation-schedule trigger
  // returned 200 with a run id for any string at all, and dispatched work for an
  // archetype that does not exist. A 5xx sweep alone reads that as healthy.
  expect(
    succeeded,
    'an id that cannot exist must not produce a success; either it was never looked up ' +
      'or the lookup matched something it should not have',
  ).toEqual([]);

  // The sweep is only worth something if most of the surface actually ran. This
  // is the blind-spot bound: if activation flags ever hide the majority of the
  // roster, that is a fact about this guard's reach and it should surface as a
  // failure rather than as a green tick over untested routes.
  expect(
    exercised.length,
    'most of the id-taking surface is genuinely reached, not gated away',
  ).toBeGreaterThan(targets.length / 2);

  // V-1587 — the count that was silently wrong. These answer 404 because their
  // module is not registered under this harness, which is indistinguishable from
  // a genuine miss unless the body is read. Bounded so the untested share cannot
  // grow without someone deciding it should.
  expect(
    unrouted.length,
    'operations the harness does not route are not covered by this sweep',
  ).toBeLessThanOrEqual(2);
});

test('no id-taking route answers 5xx for an id that is well-formed and absent', async ({
  request,
}) => {
  await server.resetState();

  const admin = await seedAccount(server.client, {
    scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
  });
  const headers = authHeader(admin.plaintext);

  const targets = idTakingOperations();
  const serverErrors: string[] = [];
  const gated: string[] = [];
  const reached: string[] = [];
  const unrouted: string[] = [];
  let reshaped = 0;

  for (const op of targets) {
    const call = async (idValue: string) => {
      const url = server.baseUrl + op.path.replace(/\{[^}]+\}/, idValue) + op.query;
      const opts = {
        headers,
        ...(op.method === 'get' || op.method === 'delete' ? {} : { data: op.body }),
      };
      const r =
        op.method === 'get'
          ? await request.get(url, opts)
          : op.method === 'delete'
            ? await request.delete(url, opts)
            : op.method === 'put'
              ? await request.put(url, opts)
              : op.method === 'patch'
                ? await request.patch(url, opts)
                : await request.post(url, opts);
      let text = '';
      try {
        text = await r.text();
      } catch {
        text = '<unreadable>';
      }
      return { status: r.status(), text };
    };

    // Most ids on this surface are published as `xxx_<uuid>`, and a bare uuid is
    // refused for the shape alone. The refusal names the shape it wants, so ask
    // again in that shape rather than maintaining a prefix table here that would
    // drift the moment a route is added. The inner quotes arrive JSON-escaped.
    let out = await call(ABSENT_UUID);
    const wants = /Expected \\?"([a-z]+)_<uuid>/.exec(out.text);
    if (out.status === 400 && wants) {
      reshaped += 1;
      out = await call(`${wants[1] as string}_${ABSENT_UUID}`);
    }

    if (isUnrouted(out.status, out.text)) {
      unrouted.push(op.key);
      continue;
    }

    if (out.status >= 500) {
      if (isDeploymentGate(out.status, out.text)) {
        gated.push(op.key);
      } else {
        serverErrors.push(`${op.key} -> ${out.status} ${out.text.slice(0, 200)}`);
      }
      continue;
    }
    reached.push(`${out.status} ${op.key}`);
  }

  console.log(
    `[V-1585] ${targets.length} operations, ${reshaped} re-asked in the shape the route named — ` +
      `${reached.length} answered, ${gated.length} gated, ${unrouted.length} not registered here:\n` +
      `${reached.join('\n')}\nNOT ROUTABLE (not swept)\n${unrouted.join('\n')}`,
  );

  expect(
    serverErrors,
    'an id that is well-formed and simply matches nothing is a miss, not a server failure',
  ).toEqual([]);

  // Without the re-ask this sweep degenerates into the malformed pass: every
  // prefixed route answers 400 on shape and the lookup is never reached, which is
  // exactly how four 500s stayed hidden. Asserted so the second pass cannot
  // quietly stop being a second pass.
  expect(reshaped, 'the re-ask actually fired for the prefixed-id routes').toBeGreaterThan(15);

  // The operations whose required body could not be built from scalars alone.
  // They are still body-shadowed and this says so rather than letting a green
  // read as full coverage; the bound keeps that set from quietly growing.
  const shadowed = targets.filter((o) => !o.bodyComplete).map((o) => o.key);
  console.log(`[V-1585] still body-shadowed (${shadowed.length}):\n${shadowed.join('\n')}`);
  // V-1589 — this was "stays small" with a bound of ten while eight operations
  // sat behind it. Every body on this surface is now buildable from its own
  // schema, so the honest bound is none: an operation whose required body cannot
  // be constructed is one this sweep cannot reach, and that should be a failure
  // asking for the generator to learn the shape rather than a number quietly
  // absorbing it.
  expect(shadowed, 'every required body is buildable from the published schema').toEqual([]);

  expect(
    unrouted.length,
    'operations the harness does not route are not covered by this sweep',
  ).toBeLessThanOrEqual(2);
});

test('a refusal names what is actually missing', async ({ request }) => {
  await server.resetState();

  const admin = await seedAccount(server.client, {
    scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
  });
  const headers = authHeader(admin.plaintext);

  // V-1586 — clearing a quota override on an account that does not exist used to
  // answer 500, because the failure-path audit write carries a foreign key to
  // accounts. Nulling that key on a not-found makes the status right on its own,
  // and the sweep proves that much. It does NOT prove the message: without the
  // existence check the refusal comes from `clear()` and reads "no active
  // override for account X", which quietly asserts the account exists. This arm
  // is the reason the check is there, so removing it fails something.
  const res = await request.delete(
    `${server.baseUrl}/v1/admin/accounts/acc_${ABSENT_UUID}/quota-override?bucket_key=global`,
    { headers },
  );

  expect(res.status(), 'an absent account is a miss, not a server failure').toBe(404);
  const parsed = JSON.parse(await res.text()) as { detail?: unknown };
  const detail = typeof parsed.detail === 'string' ? parsed.detail : '';
  expect(detail, 'and the refusal is about the account').toMatch(/account/i);
  expect(detail, 'not about an override that was never the missing thing').not.toMatch(/override/i);
});

/**
 * Body properties whose NAME says they carry an id.
 *
 * V-1595 — path parameters and query parameters both turned out to hide the same
 * defect, so the third door is the request body. `POST /v1/sessions` takes
 * `profile_id`, `POST /v1/admin/oauth/clients` takes `account_id`, and both land
 * in `uuid` columns exactly like the parameters that produced six findings.
 */
const ID_FIELD_RE = /(^|_)ids?$/;

test('no id-shaped body field turns a malformed value into a server error', async ({ request }) => {
  await server.resetState();

  const admin = await seedAccount(server.client, {
    scopes: [
      'read',
      'write',
      'admin',
      'driftstack_internal_admin',
      'write:profiles',
      'write:sessions',
    ],
  });
  const headers = authHeader(admin.plaintext);

  const doc = JSON.parse(readFileSync(SPEC, 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };

  const serverErrors: string[] = [];
  const succeeded: string[] = [];
  const gated: string[] = [];
  const unrouted: string[] = [];
  const observed: string[] = [];
  let poked = 0;

  for (const path of Object.keys(doc.paths).sort()) {
    for (const method of ['post', 'put', 'patch'] as const) {
      const op = doc.paths[path]?.[method];
      if (op === undefined) continue;
      const { data } = minimalBody(doc, op);
      // Every id-shaped property, whether or not the schema requires it: an
      // optional filter is exactly where the crypto-orders defect lived.
      const schema = (() => {
        const rb = (op as JsonNode)['requestBody'];
        const content =
          typeof rb === 'object' && rb !== null ? (rb as JsonNode)['content'] : undefined;
        const json =
          typeof content === 'object' && content !== null
            ? (content as JsonNode)['application/json']
            : undefined;
        return typeof json === 'object' && json !== null ? (json as JsonNode)['schema'] : undefined;
      })();
      const resolved = typeof schema === 'object' && schema !== null ? (schema as JsonNode) : {};
      const props =
        typeof resolved['properties'] === 'object' && resolved['properties'] !== null
          ? (resolved['properties'] as JsonNode)
          : {};

      for (const field of Object.keys(props)) {
        if (!ID_FIELD_RE.test(field)) continue;
        poked += 1;
        const url = server.baseUrl + path.replace(/\{[^}]+\}/, ABSENT_UUID);
        const body = { ...data, [field]: MALFORMED };
        const res =
          method === 'post'
            ? await request.post(url, { headers, data: body })
            : method === 'put'
              ? await request.put(url, { headers, data: body })
              : await request.patch(url, { headers, data: body });

        const status = res.status();
        let text = '';
        try {
          text = await res.text();
        } catch {
          text = '<unreadable>';
        }
        const key = `${method.toUpperCase()} ${path} {${field}}`;
        observed.push(`  ${status} ${key} :: ${text.slice(0, 90).replace(/\s+/g, ' ')}`);
        if (isUnrouted(status, text)) {
          unrouted.push(key);
        } else if (isDeploymentGate(status, text)) {
          gated.push(key);
        } else if (status >= 500) {
          serverErrors.push(`${key} -> ${status} ${text.slice(0, 160)}`);
        } else if (status < 300) {
          succeeded.push(`${key} -> ${status}`);
        }
      }
    }
  }

  console.log(
    `[V-1595] ${poked} id-shaped body fields poked — ${gated.length} gated, ${unrouted.length} unrouted\n` +
      observed.join('\n'),
  );

  expect(poked, 'the surface has id-shaped body fields to push on').toBeGreaterThan(8);

  // Half of them are behind activation flags, so half of this sweep proves
  // nothing about validation. Stated and bounded rather than folded into the
  // pass: if the gated share grows, the two assertions below quietly cover less
  // while still reporting green.
  expect(
    gated.length,
    'the deployment-gated share of body fields stays bounded',
  ).toBeLessThanOrEqual(9);

  expect(
    serverErrors,
    'a malformed id in a body field is the client getting it wrong, never the server failing',
  ).toEqual([]);

  expect(
    succeeded,
    'an id that cannot exist must not produce a success from a body field either',
  ).toEqual([]);
});
