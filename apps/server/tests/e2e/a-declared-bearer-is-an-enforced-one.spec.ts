// V-1591 — the document says these need a token. This asks whether they do.
//
// `openapi.json` declares `security: [{ BearerAuth: [] }]` on 201 of 232
// operations. That declaration is generated from the route definitions, but it is
// generated from what they DECLARE, not from what they enforce: a handler whose
// auth `preHandler` is missing still publishes the same security block, and every
// static check in this repo would agree with it. The only artefact that can
// disagree is the running server, asked without a token.
//
// Nothing was wrong when this was written, and that is the point of writing it.
// The measured split, printed by the spec on every run so it cannot go stale
// here: 146 refuse an anonymous caller outright, 27 answer a typed deployment
// gate before authentication is reached, and 28 are not routed in this build. A
// route that forgets its preHandler tomorrow lands in none of the three.
//
// The gate-before-auth ordering is deliberate-looking rather than a finding. It
// does mean an anonymous caller can learn which optional features a deployment
// has switched on, which is information the public status page carries anyway,
// and the bodies are product copy rather than secrets. It is recorded here so the
// next reader does not have to rediscover why 27 operations answer 503 to a
// request carrying no credentials.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(HERE, '../../../..', 'packages/sdk-python/openapi.json');

/** Well-formed, so a path parameter cannot be what refuses the request. */
const PATH_ID = '11111111-2222-3333-4444-555555555555';

const DEPLOYMENT_GATES = [
  'errors.driftstack.dev/feature-unavailable',
  'errors.driftstack.dev/driver-not-integrated',
] as const;

const isDeploymentGate = (status: number, text: string): boolean =>
  status === 503 && DEPLOYMENT_GATES.some((t) => text.includes(t));

const isUnrouted = (status: number, text: string): boolean =>
  status === 404 && /No route for/i.test(text);

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
const METHODS: readonly Method[] = ['get', 'post', 'put', 'patch', 'delete'];

function bearerOperations(): Array<{ method: Method; path: string; key: string }> {
  const doc = JSON.parse(readFileSync(SPEC, 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const paths = Object.keys(doc.paths);
  expect(paths.length, 'the spec parsed and has paths').toBeGreaterThan(100);

  const out: Array<{ method: Method; path: string; key: string }> = [];
  for (const path of paths.sort()) {
    for (const method of METHODS) {
      const op = doc.paths[path]?.[method];
      if (typeof op !== 'object' || op === null) continue;
      const security = (op as Record<string, unknown>)['security'];
      // Absent means the operation is published as needing no credentials; those
      // are a different question and are not this spec's claim.
      if (!JSON.stringify(security ?? null).includes('BearerAuth')) continue;
      out.push({ method, path, key: `${method.toUpperCase()} ${path}` });
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

test('an operation that declares a bearer token refuses a caller without one', async ({
  request,
}) => {
  await server.resetState();

  const targets = bearerOperations();
  expect(targets.length, 'the document declares a bearer requirement somewhere').toBeGreaterThan(
    150,
  );

  const served: string[] = [];
  const gated: string[] = [];
  const unrouted: string[] = [];
  let refused = 0;

  for (const op of targets) {
    // No Authorization header at all — not a bad token, no token.
    const url = server.baseUrl + op.path.replace(/\{[^}]+\}/g, PATH_ID);
    const opts = op.method === 'get' || op.method === 'delete' ? {} : { data: {} };
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
    if (status === 401 || status === 403) {
      refused += 1;
      continue;
    }

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
    if (isDeploymentGate(status, text)) {
      gated.push(op.key);
      continue;
    }
    served.push(`${op.key} -> ${status} ${text.slice(0, 160)}`);
  }

  console.log(
    `[V-1591] ${targets.length} bearer-declared operations — ${refused} refused anonymous, ` +
      `${gated.length} answered a deployment gate first, ${unrouted.length} unrouted`,
  );

  expect(
    served,
    'these publish a bearer requirement and answered a caller who sent no credentials',
  ).toEqual([]);

  // The refusals are the whole point, so a collapse in their number is a failure
  // even when nothing is served: if most of the surface stopped being reached the
  // empty list above would be worthless.
  expect(refused, 'most of the bearer surface was genuinely exercised').toBeGreaterThan(
    targets.length / 2,
  );

  expect(gated.length, 'the gate-before-auth set stays bounded').toBeLessThanOrEqual(27);
  // Measured for THIS population, not borrowed. The sibling id-sweep bounds its
  // unrouted set at twelve, but that sweep walks the 106 single-parameter
  // operations and this one walks all 201 that declare a bearer requirement, so
  // more of the dependency-gated modules fall inside it. Restating the sibling's
  // number here would have been a figure copied rather than measured, and it
  // failed on the first run for exactly that reason.
  expect(unrouted.length, 'unrouted operations are not covered by this spec').toBeLessThanOrEqual(
    28,
  );
});
