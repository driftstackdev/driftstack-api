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

/** Paths whose single parameter is not an id at all. */
const NOT_AN_ID = new Set<string>();

function idTakingGetPaths(): string[] {
  const doc = JSON.parse(readFileSync(SPEC, 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const paths = Object.keys(doc.paths);
  // An empty or unparsed document would make every assertion below vacuous, so
  // the population is asserted before it is used.
  expect(paths.length, 'the spec parsed and has paths').toBeGreaterThan(100);
  return paths
    .filter((p) => (p.match(/\{/g) ?? []).length === 1)
    .filter((p) => doc.paths[p]?.get !== undefined)
    .filter((p) => !NOT_AN_ID.has(p))
    .sort();
}

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test('no id-taking GET route answers 5xx for a malformed id', async ({ request }) => {
  await server.resetState();

  // Internal-admin so the admin half of the surface is reached rather than
  // stopped at authorization. A route that refuses before reading the id is a
  // pass either way; what must not happen is a cast error behind the check.
  const admin = await seedAccount(server.client, {
    scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
  });

  const targets = idTakingGetPaths();
  expect(targets.length, 'the sweep has targets').toBeGreaterThan(20);

  const serverErrors: string[] = [];
  const gated: string[] = [];
  const exercised: string[] = [];

  for (const path of targets) {
    const url = server.baseUrl + path.replace(/\{[^}]+\}/, MALFORMED);
    const res = await request.get(url, { headers: authHeader(admin.plaintext) });
    const status = res.status();

    if (status < 500) {
      exercised.push(`${status} ${path}`);
      continue;
    }

    let body = '';
    try {
      body = await res.text();
    } catch {
      body = '<unreadable>';
    }
    // The exemption is keyed on the declared problem type, not on the status, so
    // a route that breaks cannot inherit it by happening to answer 503.
    if (status === 503 && body.includes('errors.driftstack.dev/feature-unavailable')) {
      gated.push(`${status} ${path}`);
      continue;
    }
    serverErrors.push(`${status} ${path} — ${body.slice(0, 200)}`);
  }

  // Printed unconditionally: the value of this spec is the roster it walks, and
  // a silent pass tells a later reader nothing about what was actually covered.
  console.log(
    `[V-1581] ${targets.length} id-taking GET routes — ${exercised.length} exercised, ` +
      `${gated.length} behind a deployment flag:\n` +
      `EXERCISED\n${exercised.join('\n')}\nGATED (not swept)\n${gated.join('\n')}`,
  );

  expect(
    serverErrors,
    'a malformed id is the client getting it wrong, never the server failing',
  ).toEqual([]);

  // The sweep is only worth something if most of the surface actually ran. This
  // is the blind-spot bound: if activation flags ever hide the majority of the
  // roster, that is a fact about this guard's reach and it should surface as a
  // failure rather than as a green tick over nine untested routes.
  expect(
    exercised.length,
    'most of the id-taking surface is genuinely reached, not gated away',
  ).toBeGreaterThan(targets.length / 2);
});
