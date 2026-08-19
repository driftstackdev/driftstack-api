// V-1039 — a read-scoped key is actually refused on every mutating route.
//
// V-1024 derives gate STRENGTH from source: no mutating route may be satisfied by
// a read-only scope, with one listed exception. That is a claim about which
// literal sits inside a `requireScope(...)` call. The property it stands in for is
// behavioural — a key issued for reporting must not be able to change state.
//
// V-1038 verified gate PRESENCE the same way and found the answer depended on a
// layer nobody had named: the account-keyed rate limiter refuses an anonymous
// request, so route-level auth could be deleted without opening anything. This
// file cannot be fooled that way. The caller holds a VALID key, so auth passes and
// the rate limiter is satisfied; the only thing left that can refuse is the scope
// check itself. Whatever answer comes back is the scope gate's answer.
//
// Same accounting as V-1038: routes this build does not serve are counted and
// skipped rather than silently dropped, and the exercised count carries a floor.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';
import { authHeader, seedAccount } from './helpers/seed.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes');

const REGISTRATION =
  /app\.(get|post|put|patch|delete)\s*(?:<[^(]*>)?\s*\(\s*['"`](\/v1\/[^'"`]*)['"`]/g;

/** A scope that a `read`-only key does NOT satisfy. */
const NON_READ_SCOPE = /requireScope\(\s*'((?!read)[a-z_][a-z_:-]*)'/;

/**
 * The one mutating route V-1024 records as deliberately read-scoped.
 *
 * `POST /v1/billing/crypto-checkout/quote` is a stateless price preview that
 * writes nothing; it is POST only because it takes a body. It requires
 * `read:billing` on purpose, so a read key SHOULD succeed there and it is not a
 * counterexample to anything.
 *
 * Measured caveat: this build does not serve that route, so the entry is currently
 * INERT here — removing it changes no result. It stays because it is correct about
 * the source (V-1024 verified the route writes nothing) and because a build that
 * does serve it would otherwise report a false counterexample. It is listed as an
 * exception that is not presently exercised, rather than one that has been shown
 * to be needed.
 */
const DELIBERATELY_READ_SCOPED: ReadonlySet<string> = new Set([
  'POST /v1/billing/crypto-checkout/quote',
]);

interface Mutating {
  readonly verb: 'post' | 'put' | 'patch' | 'delete';
  readonly path: string;
  readonly scope: string;
  readonly file: string;
}

function mutatingRoutesNeedingWrite(): Mutating[] {
  const out: Mutating[] = [];
  for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(resolve(ROUTES, file), 'utf8');
    const fns = [...src.matchAll(/^export function (\w+)/gm)].map(
      (m) => [m.index, m[1] as string] as const,
    );
    const owner = (pos: number): string => {
      let cur = '(top)';
      for (const [at, name] of fns) {
        if (at <= pos) cur = name;
        else break;
      }
      return cur;
    };
    const ms = [...src.matchAll(REGISTRATION)];
    for (const [i, m] of ms.entries()) {
      if (/Disabled/.test(owner(m.index))) continue;
      const verb = m[1] ?? 'get';
      if (verb === 'get') continue;
      const start = m.index + m[0].length;
      const end = i + 1 < ms.length ? (ms[i + 1]?.index ?? src.length) : src.length;
      const segment = src.slice(start, end);
      const handlerAt = segment.search(/async\s*\(\s*(?:request|req|socket|_)/);
      const options = handlerAt > 0 ? segment.slice(0, handlerAt) : segment.slice(0, 500);
      const scope = NON_READ_SCOPE.exec(options);
      if (scope === null) continue;
      const path = m[2] ?? '';
      if (DELIBERATELY_READ_SCOPED.has(`${verb.toUpperCase()} ${path}`)) continue;
      out.push({
        verb: verb as Mutating['verb'],
        path,
        scope: scope[1] as string,
        file,
      });
    }
  }
  return out;
}

function concrete(path: string): string {
  return path
    .replace(/:accountId/g, 'acc_00000000-0000-4000-8000-000000000000')
    .replace(/:sessionId|:id\b/g, 'ses_00000000-0000-4000-8000-000000000000')
    .replace(/:[A-Za-z_]+/g, 'placeholder');
}

const MUTATING = mutatingRoutesNeedingWrite();

let server: TestServer;
let readOnlyAuth: { Authorization: string };

test.beforeAll(async () => {
  server = await startTestServer();
  // `read` alone: no write, no admin, no account_owner. api_builder tier, because
  // free is a desktop tier whose keys are refused at AUTH before any scope gate.
  const seeded = await seedAccount(server.client, { scopes: ['read'], tier: 'api_builder' });
  readOnlyAuth = authHeader(seeded.plaintext);
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test('the derived roster really found the mutating surface', () => {
  expect(MUTATING.length, 'mutating routes requiring a non-read scope').toBeGreaterThanOrEqual(60);
  expect(
    new Set(MUTATING.map((r) => r.scope)).size,
    'only one distinct scope found — the matcher is reading one literal, not the surface',
  ).toBeGreaterThanOrEqual(3);
});

test('a read-scoped key is refused on every mutating route the build serves', async ({
  request,
}) => {
  const accepted: string[] = [];
  const notServed: string[] = [];
  let exercised = 0;

  for (const route of MUTATING) {
    const res = await request[route.verb](`${server.baseUrl}${concrete(route.path)}`, {
      headers: readOnlyAuth,
      data: {},
      failOnStatusCode: false,
    });
    const status = res.status();

    if (status === 404 || status === 503) {
      notServed.push(`${route.verb.toUpperCase()} ${route.path} → ${status}`);
      continue;
    }

    exercised += 1;
    // 403 is the scope refusal. 401 would mean the credential itself was rejected,
    // which is a different failure and not what this file is measuring, so it is
    // reported too rather than quietly accepted.
    if (status !== 403) {
      accepted.push(
        `${route.verb.toUpperCase()} ${route.path} needs '${route.scope}' → ${status}  (${route.file})`,
      );
    }
  }

  expect(
    exercised,
    `only ${exercised} mutating routes were served by this build (${notServed.length} absent or ` +
      'behind a disabled stub) — too few for this check to mean anything',
  ).toBeGreaterThanOrEqual(40);

  expect(
    accepted.sort(),
    'a key holding ONLY the read scope was not refused with 403 on these mutating routes — a ' +
      'credential issued for reporting can change state:',
  ).toEqual([]);
});
