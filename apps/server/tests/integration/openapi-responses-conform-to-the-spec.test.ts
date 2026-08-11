// Real responses are validated against the OpenAPI schema that documents them.
//
// The spec is not documentation here — it is CODE. `packages/sdk-python` is
// GENERATED from it, so a spec that disagrees with the server produces a Python
// SDK that disagrees with the server, and ships that disagreement to customers
// as a typed model.
//
// 34 tests read this spec and every one of them compares SOURCE TEXT: spec vs
// api-types, spec vs the generated snapshot, spec vs the SDK's model list. Two
// integration tests do serve it over HTTP — but they fetch `/openapi.json`
// itself and assert the DOCUMENT's shape (it parses, it has an OpenAPI root, it
// declares a Problem schema, it lists /v1/sessions). Not one of them has ever
// checked a real response body against the schema that claims to describe it.
//
// So the whole corpus proves the spec is internally consistent and says nothing
// about whether it is TRUE. Every text-parity test passes when the spec and the
// generated SDK agree with each other and both are wrong about the server.
//
// The failure this catches is asymmetric, which is why `required` matters most:
//   - spec requires a field the server does not send -> the generated Python
//     model has a non-optional attribute that is absent. Customer-side break.
//   - server sends a field the spec omits -> generated models silently DROP it.
//     The data reaches the customer's process and their SDK discards it.
// Both are real; the first is louder and the second is worse.

import Ajv from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './_helpers/build-test-app.js';

let fx: Awaited<ReturnType<typeof buildTestApp>>;
let staff: Awaited<ReturnType<typeof buildTestApp>>;
let spec: SpecDocument;
let ajvInstance: Ajv | null = null;

/** Where the spec's component schemas are registered for ref resolution. */
const DEFS_ID = 'https://driftstack.test/openapi-components';

interface SpecDocument {
  paths?: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, unknown> };
}
interface Operation {
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}

/**
 * OpenAPI 3.0 schema -> draft-07, which is the dialect ajv 6 speaks.
 *
 * Two differences matter. `nullable: true` is an OpenAPI extension draft-07
 * does not know, and ignoring it would fail every legitimately null field
 * (`next_cursor`, `last_used_at`, `revoked_at` are null on the happy path). And
 * refs point at `#/components/schemas/`, which has no meaning to a bare
 * validator — the spec carries 1102 of them, so unresolved refs would not be a
 * lenient validator, they would be a crashing one.
 */
function toDraft07(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toDraft07);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'nullable') continue;
    out[k] =
      k === '$ref' && typeof v === 'string'
        ? v.replace('#/components/schemas/', `${DEFS_ID}#/definitions/`)
        : toDraft07(v);
  }
  if ((node as { nullable?: boolean }).nullable === true && typeof out['type'] === 'string') {
    out['type'] = [out['type'], 'null'];
  }
  return out;
}

/**
 * The JSON schema for a path+method+status, or undefined if undocumented.
 *
 * BOTH media types. Errors are published as `application/problem+json`, and an
 * `application/json`-only lookup silently skipped every one of them — which is
 * the half of the contract SDK error handling is built on. It also mislabelled
 * them: a documented 503 came back as "undocumented" because the lookup could
 * not see the media type it was published under, which reads like a missing
 * contract rather than a blind spot in the reader.
 */
function lookup(path: string, method: string, status: string): unknown {
  const content = spec.paths?.[path]?.[method]?.responses?.[status]?.content;
  return content?.['application/json']?.schema ?? content?.['application/problem+json']?.schema;
}

/** As `lookup`, but a miss is fatal rather than silent. */
function schemaFor(path: string, method: string, status: string): unknown {
  const schema = lookup(path, method, status);
  // Returning undefined here would hand ajv an "anything goes" schema, and the
  // endpoint would conform to nothing at all while reporting success.
  if (schema === undefined) {
    throw new Error(`spec documents no ${method.toUpperCase()} ${path} -> ${status} JSON schema`);
  }
  return schema;
}

/**
 * One validator for the whole spec, with the component schemas registered ONCE.
 *
 * Inlining all of `components.schemas` into each endpoint's schema — the
 * obvious way — recompiles the entire component graph 65 times and blew the
 * 10s test timeout. Registered as a single shared document, each response
 * schema compiles to just itself plus refs.
 *
 * `validateFormats: false` is deliberate, not a workaround. The spec annotates
 * `uuid`, `date-time`, `email`, `int32`; ajv 8 ships no format vocabulary and
 * THROWS on each one, which would read as a conformance failure when it is a
 * validator-configuration failure. Formats are also not this guard's subject:
 * structure, `required` and nullability are what break a generated client.
 * `strict: false` for the same reason — OpenAPI carries annotation keywords
 * (`example`, `discriminator`) that strict mode rejects outright.
 */
function ajv(): Ajv {
  if (ajvInstance) return ajvInstance;
  ajvInstance = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  ajvInstance.addSchema({
    $id: DEFS_ID,
    definitions: toDraft07(spec.components?.schemas ?? {}),
  });
  return ajvInstance;
}

/** Validate a body against one response schema from the spec. */
function validateSchema(schema: unknown, body: unknown): string[] {
  const check = ajv().compile(toDraft07(schema) as object);
  return check(body)
    ? []
    : (check.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`);
}

function validate(path: string, method: string, status: string, body: unknown): string[] {
  return validateSchema(schemaFor(path, method, status), body);
}

beforeAll(async () => {
  fx = await buildTestApp({ scopes: ['read', 'write', 'account_owner'] });
  // A staff credential too. With a customer key every /v1/admin route answers
  // 403 — which IS documented, so the sweep validated the problem body and
  // moved on, never reading a single admin SUCCESS shape. Two real contract
  // defects were sitting behind that 403 the whole time.
  staff = await buildTestApp({
    scopes: ['read', 'write', 'account_owner', 'driftstack_internal_admin'],
  });
  // The SERVED spec, not the checked-in file: this is the contract a customer
  // fetches and points a generator at.
  const res = await fx.app.inject({ method: 'GET', url: '/openapi.json' });
  spec = res.json<SpecDocument>();
});

afterAll(async () => {
  await fx.app.close();
  await staff.app.close();
});

const auth = (): { authorization: string } => ({ authorization: `Bearer ${fx.plaintext}` });

describe('real responses conform to the OpenAPI spec that generates the SDKs', () => {
  it('CRITICAL the validator resolves refs, honours nullable, and REJECTS a body that violates the spec. Every assertion below reports an absence of errors, so a validator that could not fail would satisfy all of them.', () => {
    expect(Object.keys(spec.paths ?? {}).length, 'paths in the served spec').toBeGreaterThan(20);
    expect(
      Object.keys(spec.components?.schemas ?? {}).length,
      'component schemas available to resolve refs against',
    ).toBeGreaterThan(10);

    // Known-bad against a REAL schema: `data` must be an array.
    expect(
      validate('/v1/sessions', 'get', '200', {
        data: 'not-an-array',
        has_more: false,
        next_cursor: null,
      }),
      'a body that violates the real spec is reported',
    ).not.toEqual([]);

    // A required field the server failed to send is caught. This is the exact
    // shape of the customer-facing break: the generated model declares it
    // non-optional.
    expect(
      validate('/v1/sessions', 'get', '200', { has_more: false, next_cursor: null }),
      'a missing required field is reported',
    ).not.toEqual([]);

    // And nullable is honoured, or every happy-path response would "fail".
    expect(
      validate('/v1/sessions', 'get', '200', { data: [], has_more: false, next_cursor: null }),
      'a legitimately null field is not a violation',
    ).toEqual([]);

    // An undocumented path must throw rather than vacuously pass.
    expect(() => schemaFor('/v1/not-a-real-path', 'get', '200')).toThrow();
  });

  it('CRITICAL GET /v1/archetypes conforms. The public catalogue is the one endpoint every unauthenticated customer hits first.', async () => {
    const res = await fx.app.inject({ method: 'GET', url: '/v1/archetypes' });
    expect(res.statusCode).toBe(200);
    expect(validate('/v1/archetypes', 'get', '200', res.json()), 'spec violations:').toEqual([]);
  });

  it('CRITICAL GET /v1/sessions conforms, envelope and all', async () => {
    const res = await fx.app.inject({ method: 'GET', url: '/v1/sessions', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(validate('/v1/sessions', 'get', '200', res.json()), 'spec violations:').toEqual([]);
  });

  it('CRITICAL GET /v1/account/me conforms', async () => {
    const res = await fx.app.inject({ method: 'GET', url: '/v1/account/me', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(validate('/v1/account/me', 'get', '200', res.json()), 'spec violations:').toEqual([]);
  });

  it('CRITICAL every documented parameterless GET conforms, on whatever status it actually returns. Four hand-picked endpoints already surfaced one real contract defect, so the population is swept rather than sampled — including error responses, which is where a generated client breaks hardest and where nothing else here looks.', async () => {
    // Streaming endpoints are excluded by their DECLARED content type, not by
    // name: `/v1/account/me/notifications` is Server-Sent Events, so it holds
    // the connection open by design and a sweep that requested it simply hung
    // (it was the one endpoint over 50ms — it never returned at all). Reading
    // the exclusion off the spec means a stream added later is skipped
    // automatically instead of hanging CI once.
    const paths = Object.keys(spec.paths ?? {}).filter((p) => {
      if (p.includes('{')) return false;
      const op = spec.paths?.[p]?.['get'];
      if (op === undefined) return false;
      const responses = Object.values(op.responses ?? {});
      if (responses.some((r) => r.content?.['text/event-stream'] !== undefined)) return false;
      return responses.some(
        (r) =>
          r.content?.['application/json'] !== undefined ||
          r.content?.['application/problem+json'] !== undefined,
      );
    });

    const violations: string[] = [];
    const undocumented: string[] = [];
    let validated = 0;

    for (const path of paths) {
      // Admin paths go through the staff app; a customer key sees only their
      // 403 and the success shape behind it is never read.
      const isAdmin = path.startsWith('/v1/admin/');
      const app = isAdmin ? staff.app : fx.app;
      const bearer = isAdmin ? staff.plaintext : fx.plaintext;
      const res = await app.inject({
        method: 'GET',
        url: path,
        headers: { authorization: `Bearer ${bearer}` },
      });
      const status = String(res.statusCode);
      const schema = lookup(path, 'get', status);
      if (schema === undefined) {
        undocumented.push(`${path} -> ${status}`);
        continue;
      }
      validated += 1;
      const errors = validateSchema(schema, res.json());
      if (errors.length > 0) violations.push(`${path} -> ${status}: ${errors.join('; ')}`);
    }

    // MEASURED, not assumed: 63 of the 68 swept endpoints are actually
    // validated. It was 34 of 65 until the lookup started reading
    // `application/problem+json` as well — the admin routes this customer key
    // cannot reach answer 403 with a documented problem body, so they were
    // being skipped as "undocumented" when the contract described them all
    // along. Error bodies are also where SDK error handling lives, which makes
    // them the more valuable half to validate.
    //
    // The floor is the whole point of reporting that number. A sweep that
    // validated two endpoints and found no violations looks identical, in a
    // green run, to one that validated sixty. Pinned below the observed 63 so
    // ordinary drift does not trip it, high enough that a collapse in
    // reachability fails loudly instead of quietly checking almost nothing.
    expect(validated, `endpoints actually validated (of ${paths.length} swept)`).toBeGreaterThan(
      55,
    );
    expect(violations, 'response(s) that violate the schema documenting them:').toEqual([]);
    // Not asserted: `undocumented` — a status the spec does not describe is
    // usually this fixture's 403, not a contract fault. Surfaced deliberately
    // so the number is visible rather than silently swallowed.
    expect(undocumented.length, 'statuses reached that the spec does not document').toBeLessThan(
      paths.length,
    );
    // Sixty-five sequential requests against a real app instance; the default
    // 10s is a budget for a single-request test, not for a population sweep.
  }, 120_000);

  it('CRITICAL POST /v1/api-keys conforms on 201. The spec marks `plaintext` REQUIRED and it is unrecoverable after this response, so a spec-vs-server disagreement on this field is the most expensive one in the API.', async () => {
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(),
      payload: { name: 'conformance-probe', scopes: ['read'] },
    });
    expect(res.statusCode).toBe(201);
    expect(validate('/v1/api-keys', 'post', '201', res.json()), 'spec violations:').toEqual([]);
  });
});
