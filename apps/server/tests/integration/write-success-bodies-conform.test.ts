// What a write RETURNS on success conforms to the schema documenting it.
//
// Two sweeps already cover writes and neither reads a success body.
// `every-write-endpoint-errors-as-rfc7807` drives them with an invalid payload
// on purpose and asserts the shape of the ERROR. The conformance population
// sweep validates GET only, because a synthetic write body mostly 400s. So the
// 201 a customer receives when they create a session, a key or a webhook — the
// response their SDK deserialises into the object they then use — had never
// been checked against its own contract.
//
// That gap is what hid `POST /v1/webhooks` documenting 200 while replying 201.
// A client branching on the documented status treats a successful creation as
// unexpected, and no amount of error-shape testing would ever notice.
//
// Request bodies are SYNTHESISED from the spec's own request schema — required
// fields, filled by type, enums taking their first member — with a small table
// of overrides where a generated value cannot satisfy a real rule. That keeps
// the sweep honest: it exercises whatever the contract says is required, so a
// new write endpoint is covered the day it is documented rather than the day
// someone remembers to add it here.

import Ajv from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './_helpers/build-test-app.js';

let fx: Awaited<ReturnType<typeof buildTestApp>>;
let spec: SpecDocument;
let ajvInstance: Ajv | null = null;

const DEFS_ID = 'https://driftstack.test/write-components';

interface SpecDocument {
  paths?: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, unknown> };
}
interface Operation {
  requestBody?: { content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}

/**
 * Payloads a generated value cannot produce.
 *
 * Kept as small as possible and stated per reason, because every entry here is
 * a place the sweep stops deriving from the contract and starts trusting me.
 */
const PAYLOAD_OVERRIDES: Record<string, Record<string, unknown>> = {
  // `events` must be non-empty; a synthesised `[]` is a 400 and the endpoint
  // would silently drop out of the swept set.
  'POST /v1/webhooks': {
    url: 'https://example.com/driftstack/hook',
    events: ['session.completed'],
  },
  // Same shape of rule on `scopes`.
  'POST /v1/api-keys': { name: 'write-conformance-probe', scopes: ['read'] },
};

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

function deref(node: unknown, depth = 0): Record<string, unknown> {
  if (node === null || typeof node !== 'object' || depth > 8) return {};
  const n = node as Record<string, unknown>;
  if (typeof n['$ref'] === 'string') {
    const name = n['$ref'].split('/').pop() ?? '';
    return deref(spec.components?.schemas?.[name], depth + 1);
  }
  return n;
}

/** A minimal body satisfying a request schema's REQUIRED fields. */
function synthesise(schema: unknown, depth = 0): unknown {
  const s = deref(schema, depth);
  if (depth > 8) return 'probe';
  const enumValues = s['enum'];
  if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues[0];
  const rawType = s['type'];
  const type = Array.isArray(rawType) ? rawType.find((t) => t !== 'null') : rawType;
  if (type === 'object') {
    const out: Record<string, unknown> = {};
    const required = Array.isArray(s['required']) ? (s['required'] as string[]) : [];
    const props = (s['properties'] ?? {}) as Record<string, unknown>;
    for (const key of required) out[key] = synthesise(props[key], depth + 1);
    return out;
  }
  if (type === 'array') return [synthesise(s['items'], depth + 1)];
  if (type === 'integer' || type === 'number') return 1;
  if (type === 'boolean') return true;
  if (s['format'] === 'uuid') return '00000000-0000-4000-8000-000000000abc';
  if (s['format'] === 'email') return 'probe@example.com';
  if (s['format'] === 'uri' || s['format'] === 'url') return 'https://example.com/x';
  return 'probe';
}

function ajv(): Ajv {
  if (ajvInstance) return ajvInstance;
  ajvInstance = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  ajvInstance.addSchema({ $id: DEFS_ID, definitions: toDraft07(spec.components?.schemas ?? {}) });
  return ajvInstance;
}

interface Result {
  op: string;
  status: string;
  errors: string[];
  documented: boolean;
}

const results: Result[] = [];

beforeAll(async () => {
  fx = await buildTestApp({
    scopes: ['read', 'write', 'account_owner', 'driftstack_internal_admin'],
  });
  spec = (await fx.app.inject({ method: 'GET', url: '/openapi.json' })).json<SpecDocument>();

  for (const path of Object.keys(spec.paths ?? {})) {
    if (path.includes('{')) continue;
    for (const method of ['post', 'patch', 'delete'] as const) {
      const op = spec.paths?.[path]?.[method];
      if (op === undefined) continue;
      const key = `${method.toUpperCase()} ${path}`;
      // Typed, not `unknown`: an unknown payload makes fastify's inject
      // overload unresolvable, `res` degrades to any, and every read off it
      // becomes an unsafe-call lint error.
      const payload: Record<string, unknown> =
        PAYLOAD_OVERRIDES[key] ??
        (synthesise(op.requestBody?.content?.['application/json']?.schema) as Record<
          string,
          unknown
        >);

      const res = await fx.app.inject({
        method: method.toUpperCase() as 'POST',
        url: path,
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload,
      });
      // Only SUCCESS bodies. Failures are the other sweep's subject.
      if (res.statusCode < 200 || res.statusCode >= 300) continue;

      const status = String(res.statusCode);
      const content = op.responses?.[status]?.content;
      const schema =
        content?.['application/json']?.schema ?? content?.['application/problem+json']?.schema;
      if (schema === undefined) {
        // 204 legitimately has no body or schema; anything else means the
        // status the route really returns is not the one it documents.
        results.push({ op: key, status, errors: [], documented: status === '204' });
        continue;
      }
      const check = ajv().compile(toDraft07(schema) as object);
      const body: unknown = res.body === '' ? null : res.json<unknown>();
      results.push({
        op: key,
        status,
        documented: true,
        errors: check(body)
          ? []
          : (check.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`),
      });
    }
  }
}, 180_000);

afterAll(async () => {
  await fx.app.close();
});

describe('write success bodies conform to their documented schema', () => {
  it('CRITICAL the synthesiser produced bodies the server actually accepted. Every assertion below reports an ABSENCE, so a sweep whose payloads all 400d would report a clean pass having validated nothing.', () => {
    // MEASURED: 14 writes succeed today. Floored well below that so ordinary
    // change does not trip it, high enough that a synthesiser regression —
    // every payload rejected — fails loudly instead of sweeping an empty set.
    expect(results.length, 'write operations that returned 2xx').toBeGreaterThanOrEqual(10);

    // The synthesiser itself, on a schema whose answer is not in doubt.
    expect(
      synthesise({
        type: 'object',
        required: ['name', 'count', 'mode'],
        properties: {
          name: { type: 'string' },
          count: { type: 'integer' },
          mode: { type: 'string', enum: ['fast', 'slow'] },
          ignored: { type: 'string' },
        },
      }),
      'required fields are filled by type, enums take their first member, optional fields are omitted',
    ).toEqual({ name: 'probe', count: 1, mode: 'fast' });
  });

  it('CRITICAL every write returns the status it documents. This is what hid POST /v1/webhooks replying 201 while its contract said 200 — a client branching on the documented status treats a successful creation as unexpected, and no error-shape test would ever see it.', () => {
    expect(
      results.filter((r) => !r.documented).map((r) => `${r.op} returned ${r.status}`),
      'write(s) whose success status has no documented schema:',
    ).toEqual([]);
  });

  it('CRITICAL every write success body matches its schema. This is the object the customer SDK deserialises and then uses, so a field missing here surfaces as an undefined property somewhere far from the call.', () => {
    expect(
      results
        .filter((r) => r.errors.length > 0)
        .map((r) => `${r.op} -> ${r.status}: ${r.errors.join('; ')}`),
      'write success body(ies) violating their own schema:',
    ).toEqual([]);
  });
});
