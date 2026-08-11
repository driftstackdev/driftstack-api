// A status the server actually returns is a status the contract documents.
//
// This is the check that found the billing defect, run by hand. GET
// /v1/account/me/billing-portal answered 409 for every account that had never
// checked out — the ordinary state of a free-tier caller — while the published
// contract listed [302,400,401,403,429,503]. I only noticed because I read the
// skip list of another sweep. Nothing asserted it, so nothing would have
// noticed again.
//
// The existing route-coverage invariant answers a different question: does
// every registered PATH appear in the spec. It enumerates from source text and
// says nothing about STATUS. A path can be perfectly documented and still
// answer with a code its own contract denies, which is what happened.
//
// Unregistered routes are skipped by DERIVATION, not by a hand-kept exemption
// list. Several surfaces are wired conditionally — OAuth on `deps.oauthStore`,
// mac-nodes on the Drizzle repo plus an encryption key, admin atlas-priority
// likewise — and in a fixture without them the routes do not exist, so their
// 404 is structural rather than a contract gap. Reading that from the live
// route table means the skip cannot go stale: wire the dependency in and the
// operation starts being checked automatically, with nothing to remember.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './_helpers/build-test-app.js';

let fx: Awaited<ReturnType<typeof buildTestApp>>;
let staff: Awaited<ReturnType<typeof buildTestApp>>;
let spec: SpecDocument;
let served: Set<string>;

interface SpecDocument {
  paths?: Record<string, Record<string, Operation>>;
}
interface Operation {
  responses?: Record<string, { content?: Record<string, unknown> }>;
}

const METHODS = ['get', 'post', 'patch', 'delete'] as const;

/**
 * Flatten `printRoutes()` into `METHOD /path`.
 *
 * The tree repeats only the SEGMENT at each node and indents four columns per
 * level, so the full path is the concatenation of the segments on the stack. A
 * naive per-line read yields `/navigate` instead of
 * `/v1/sessions/{id}/navigate`, and then every route reads as unregistered and
 * the whole sweep skips itself into a green.
 */
function flatten(tree: string): Set<string> {
  const stack: Record<number, string> = {};
  const out = new Set<string>();
  for (const line of tree.split('\n')) {
    if (line.trim() === '') continue;
    const m = /^([\s│]*)(?:├──|└──)?\s*(\S*)\s*(?:\((.*)\))?$/.exec(line);
    if (m === null) continue;
    const depth = Math.floor((m[1] ?? '').length / 4);
    stack[depth] = m[2] ?? '';
    const methods = m[3];
    if (methods === undefined) continue;
    let full = '';
    for (let d = 0; d <= depth; d += 1) full += stack[d] ?? '';
    const path = full.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
    for (const raw of methods.split(',')) {
      const method = raw.trim();
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      out.add(`${method} ${path}`);
    }
  }
  return out;
}

beforeAll(async () => {
  fx = await buildTestApp({ scopes: ['read', 'write', 'account_owner'] });
  // A staff credential for the admin surface. With a customer key those routes
  // answer 403 — which IS documented — so this sweep confirmed the 403 and
  // never observed a single admin SUCCESS status.
  staff = await buildTestApp({
    scopes: ['read', 'write', 'account_owner', 'driftstack_internal_admin'],
  });
  served = flatten(fx.app.printRoutes({ commonPrefix: false }));
  spec = (await fx.app.inject({ method: 'GET', url: '/openapi.json' })).json<SpecDocument>();
}, 60_000);

afterAll(async () => {
  await fx.app.close();
  await staff.app.close();
});

describe('every status the server returns is documented for that operation', () => {
  it('CRITICAL the route table flattened to full paths. If it did not, every operation would read as unregistered and the sweep below would skip itself into a clean green.', () => {
    expect(served.size, 'operations served').toBeGreaterThan(200);
    expect(
      served.has('POST /v1/sessions/{id}/navigate'),
      'a nested route keeps its full path',
    ).toBe(true);
    expect(
      [...served].filter((s) => s === 'POST /navigate'),
      'no bare segment leaked through',
    ).toEqual([]);
    expect(
      [...flatten(['├── /v1/things (GET)', '│   └── /:id (GET, HEAD)'].join('\n'))],
      'segments concatenate and HEAD is dropped',
    ).toEqual(['GET /v1/things', 'GET /v1/things/{id}']);
  });

  it('CRITICAL no operation answers with a status its own contract denies. A path can be fully documented and still do this — GET /v1/account/me/billing-portal answered 409 to every account that had never checked out while its contract said that could not happen.', async () => {
    const violations: string[] = [];
    let checked = 0;
    let unregistered = 0;
    let adminSuccess = 0;

    for (const path of Object.keys(spec.paths ?? {})) {
      // A templated path needs a real id; a synthetic one answers 404 and would
      // report the 404 branch rather than the operation's own behaviour.
      if (path.includes('{')) continue;
      for (const method of METHODS) {
        const op = spec.paths?.[path]?.[method];
        if (op === undefined) continue;

        // Streams hold the connection open by design; requesting one hangs.
        const responses = Object.values(op.responses ?? {});
        if (responses.some((r) => r.content?.['text/event-stream'] !== undefined)) continue;

        if (!served.has(`${method.toUpperCase()} ${path}`)) {
          unregistered += 1;
          continue;
        }

        const isAdmin = path.startsWith('/v1/admin/');
        const target = isAdmin ? staff : fx;
        const res = await target.app.inject({
          method: method.toUpperCase() as 'GET',
          url: path,
          headers: { authorization: `Bearer ${target.plaintext}` },
          // An invalid body drives writes down their rejection paths, which is
          // where undocumented statuses live.
          ...(method === 'get' ? {} : { payload: { __not_a_valid_field__: 1 } }),
        });
        checked += 1;
        const status = String(res.statusCode);
        if (isAdmin && res.statusCode >= 200 && res.statusCode < 300) adminSuccess += 1;
        if (!Object.keys(op.responses ?? {}).includes(status)) {
          violations.push(
            `${method.toUpperCase()} ${path} answered ${status}, documented [${Object.keys(
              op.responses ?? {},
            ).join(',')}]`,
          );
        }
      }
    }

    // MEASURED, not estimated: 110 operations are exercised and exactly 11 are
    // skipped as unregistered — 9 OAuth, 1 admin atlas-priority, 1 mac-nodes,
    // every one a conditionally-wired surface this fixture omits. Floors on
    // both numbers, because the two ways this sweep can lie are opposite: a
    // collapse in coverage, and a wholesale skip. Either would otherwise report
    // exactly the same clean green as a full pass.
    expect(checked, 'operations actually exercised').toBeGreaterThan(90);
    expect(unregistered, 'operations skipped as unregistered here').toBeLessThan(15);
    // MEASURED, and the reason the staff credential is here at all: under a
    // customer key 0 of 29 admin operations reach a 2xx — every one answers the
    // documented 403, so the sweep confirmed that and learned nothing about
    // their success statuses. Under staff, 20 do. Floored so a credential that
    // silently loses its admin scope fails here instead of quietly returning to
    // checking only the 403s.
    expect(adminSuccess, 'admin operations observed at a SUCCESS status').toBeGreaterThan(15);
    expect(violations, 'operation(s) answering a status their contract denies:').toEqual([]);
  }, 180_000);
});
