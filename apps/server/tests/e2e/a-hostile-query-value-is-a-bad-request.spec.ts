// V-1590 — the query-string half of "a client's bad input is never the server's error".
//
// Its sibling, `a-malformed-id-is-a-bad-request`, sweeps path parameters and has
// found six defects doing it. Every one of those lived in the same shape: a value
// that looks like an id, is not validated, and reaches a column that will not
// take it. Nothing about that shape is specific to path parameters, and the
// query string is the other place ids arrive — `?endpoint_id=`, `?account_id=`,
// `?cursor=`.
//
// It was the right place to look. `GET /v1/admin/webhook-dlq?endpoint_id=` had
// its `webhook_endpoint_` prefix removed and the remainder handed to a repo
// filtering a `uuid` column, so a mistyped drill-down was a cast error the admin
// saw as a 500. Stripping a prefix is not validating what is left, which is the
// third time this session that exact sentence has been the finding.
//
// The contract asserted here is the same weak, durable one: a hostile query value
// may be a 400, a 422, a 404, or a 401/403 before it is read, and it may not be a
// 5xx. Values are derived from each parameter's own declared type, so a new
// parameter is swept the day it is published.
//
// Scope, stated because it bounds the claim: GET and DELETE only. Operations that
// also require a body are covered for their ids by the sibling spec; adding body
// construction here would duplicate that machinery to reach a handful of extra
// parameters. Unrouted and deployment-gated operations are excluded the same way
// and for the same reasons the sibling excludes them.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';
import { seedAccount, authHeader } from './helpers/seed.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(HERE, '../../../..', 'packages/sdk-python/openapi.json');

/** A path parameter value that is well-formed, so the sweep reaches the query. */
const PATH_ID = '11111111-2222-3333-4444-555555555555';

/**
 * Hostile values per declared type.
 *
 * `' OR 1=1--` is here for the shape of the string, not as an injection probe:
 * the queries are parameterised and it cannot reach the planner. It earns its
 * place because it is a plausible paste from a support ticket, and because it is
 * one more non-uuid that a column may refuse.
 */
const HOSTILE: Record<string, readonly string[]> = {
  string: ['not-a-uuid', '%00', "' OR 1=1--", 'x'.repeat(600)],
  integer: ['-1', '0', '999999999', 'abc'],
  number: ['-1', 'abc'],
  boolean: ['maybe'],
  'date-time': ['not-a-date', '0000-00-00'],
};

const DEPLOYMENT_GATES = [
  'errors.driftstack.dev/feature-unavailable',
  'errors.driftstack.dev/driver-not-integrated',
] as const;

const isDeploymentGate = (status: number, text: string): boolean =>
  status === 503 && DEPLOYMENT_GATES.some((t) => text.includes(t));

const isUnrouted = (status: number, text: string): boolean =>
  status === 404 && /No route for/i.test(text);

type JsonNode = Record<string, unknown>;

interface QueryTarget {
  method: 'get' | 'delete';
  path: string;
  param: string;
  values: readonly string[];
}

function queryTargets(): QueryTarget[] {
  const doc = JSON.parse(readFileSync(SPEC, 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
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

  const paths = Object.keys(doc.paths);
  expect(paths.length, 'the spec parsed and has paths').toBeGreaterThan(100);

  const out: QueryTarget[] = [];
  for (const path of paths.sort()) {
    for (const method of ['get', 'delete'] as const) {
      const op = deref(doc.paths[path]?.[method]);
      if (!op) continue;
      const params = op['parameters'];
      if (!Array.isArray(params)) continue;
      for (const raw of params) {
        const pm = deref(raw);
        if (pm?.['in'] !== 'query') continue;
        const name = pm['name'];
        if (typeof name !== 'string') continue;
        const sc = deref(pm['schema']) ?? {};
        const declared = sc['type'];
        const kind = Array.isArray(declared) ? declared.find((t) => t !== 'null') : declared;
        const key = sc['format'] === 'date-time' ? 'date-time' : String(kind ?? 'string');
        out.push({ method, path, param: name, values: HOSTILE[key] ?? HOSTILE['string']! });
      }
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

test('no query parameter turns a hostile value into a server error', async ({ request }) => {
  await server.resetState();

  const admin = await seedAccount(server.client, {
    scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
  });
  const headers = authHeader(admin.plaintext);

  const targets = queryTargets();
  expect(targets.length, 'the sweep has parameters to push on').toBeGreaterThan(20);

  const serverErrors: string[] = [];
  const gated = new Set<string>();
  const unrouted = new Set<string>();
  let sent = 0;

  for (const t of targets) {
    for (const value of t.values) {
      const url =
        server.baseUrl +
        t.path.replace(/\{[^}]+\}/, PATH_ID) +
        `?${encodeURIComponent(t.param)}=${encodeURIComponent(value)}`;
      const res =
        t.method === 'get'
          ? await request.get(url, { headers })
          : await request.delete(url, { headers });
      sent += 1;
      const status = res.status();
      if (status < 500) continue;

      let text = '';
      try {
        text = await res.text();
      } catch {
        text = '<unreadable>';
      }
      if (isUnrouted(status, text)) {
        unrouted.add(`${t.method.toUpperCase()} ${t.path}`);
        continue;
      }
      if (isDeploymentGate(status, text)) {
        gated.add(`${t.method.toUpperCase()} ${t.path}`);
        continue;
      }
      serverErrors.push(
        `${t.method.toUpperCase()} ${t.path} ?${t.param}=${value} -> ${status} ${text.slice(0, 160)}`,
      );
    }
  }

  console.log(
    `[V-1590] ${targets.length} query parameters, ${sent} hostile requests — ` +
      `${gated.size} gated path(s), ${unrouted.size} unrouted path(s)`,
  );

  expect(
    serverErrors,
    'a hostile query value is the client getting it wrong, never the server failing',
  ).toEqual([]);

  // A 404 from "no such route" is indistinguishable from a real one by status
  // alone, which is how the sibling spec spent several batches scoring twenty
  // operations it never reached. Bounded here from the start rather than after.
  expect(unrouted.size, 'unrouted paths are not covered by this sweep').toBeLessThanOrEqual(6);
});
