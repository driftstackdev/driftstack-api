// A staff action that changes state and leaves no audit row is a change nobody
// can account for afterwards.
//
// This has shipped twice. Migration 0097's own comment records that
// `admin-crypto-orders.ts` and `admin-validation-harness.ts` "had zero audit
// wiring despite this file's header invariant" — found by hand, fixed by hand,
// with nothing left behind to catch the third one.
//
// `every-declared-admin-audit-action-is-reachable` guards the other direction:
// a declared enum value that no code can emit. It cannot see this one. A new
// admin route that mutates and never audits adds no enum value, so that guard
// stays green while the action goes unrecorded.
//
// Scope, stated because it bounds the claim: this proves an audit call is
// REACHED from the route's registration block, not that the row lands with
// correct content. `admin.test.ts` drives the row itself over HTTP. The block
// runs from one `app.<verb>(` registration to the next, so the final route in a
// file extends to end-of-file and is the one place a stray helper could satisfy
// the check for it — every other block is bounded by the next registration.
//
// V-1583 — the scan used to read only files NAMED `admin-*.ts`, which is a roster
// keyed by filename rather than by what a route IS. `oauth.ts` registers five
// `/v1/admin/` routes and `internal-atlas-priority.ts` two, so three admin
// mutations that ship unaudited TODAY were outside the scan, and the arm below
// could assert an empty list only because it could not see them. Membership is
// now decided by path, the way the sentence at the top of this file reads.
//
// Both sibling guards had already made this correction and already carry the
// three routes; this file is the one that was left behind, and the set below is
// pinned equal to theirs rather than maintained in parallel.
//
// Measured after widening: 33 mutating admin routes, 3 without an audit call —
// all three rostered below with the migration that blocks them.
// It is a regression guard, not a fix.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = resolve(HERE, '..', '..', 'src', 'routes');

/** `app.post<{...}>(` — the generic argument sits between the verb and the paren. */
const ROUTE_REGISTRATION = /app\.(get|post|patch|put|delete)\s*(<[^(]*>)?\s*\(/g;

/** Verbs that change state. A GET that mutates is a bug this does not try to find. */
const MUTATING = new Set(['post', 'patch', 'put', 'delete']);

/**
 * Any spelling that reaches the audit recorder.
 *
 * `withAudit` is the wrapper most admin routes use, and matching only
 * `audit.record` would have missed every one of them — the first draft of this
 * measurement did exactly that and reported `admin-webhooks.ts` as having three
 * unaudited mutating routes, which was an artefact of the pattern rather than a
 * finding.
 */
const AUDIT_CALL = /withAudit|audit\.record|adminAudit|recordAdminAction/;

function routeFiles(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(ROUTES_DIR, f))
    .sort();
}

/** Only `/v1/admin/*`. A customer route registered in an admin module is not an admin endpoint. */
const isAdminPath = (path: string): boolean => path.startsWith('/v1/admin/');

/**
 * Admin mutations that write no audit row today.
 *
 * All three manage third-party OAuth clients and none can be wired without a
 * migration: `admin_audit_log.action` is a closed Postgres enum carrying no
 * `oauth_client.*` value, and `docs/decisions.md` records that as deliberate —
 * adding an admin endpoint is a migration-bearing change. Choosing the vocabulary
 * IS the migration-bearing part, so they sit here rather than being quietly wired
 * to an existing action that means something else.
 *
 * The finding belongs to `admin-audit-route-coverage-invariant` (V-1007). This
 * set is pinned equal to that file's below, by reading its source, so the two
 * cannot drift apart when the migration lands.
 */
const KNOWN_UNAUDITED: ReadonlySet<string> = new Set([
  'POST /v1/admin/oauth/clients',
  'DELETE /v1/admin/oauth/clients/:id',
  'POST /v1/admin/oauth/clients/:id/rotate-secret',
]);

interface RouteBlock {
  file: string;
  verb: string;
  path: string;
  body: string;
}

function routeBlocks(): RouteBlock[] {
  const blocks: RouteBlock[] = [];
  for (const file of routeFiles()) {
    const source = readFileSync(file, 'utf-8');
    const marks = [...source.matchAll(ROUTE_REGISTRATION)];
    marks.forEach((m, i) => {
      const start = m.index;
      const end = i + 1 < marks.length ? marks[i + 1]!.index : source.length;
      const body = source.slice(start, end);
      blocks.push({
        file: file.slice(file.lastIndexOf('/') + 1),
        verb: m[1]!,
        path: /'(\/v1\/[^']+)'/.exec(body)?.[1] ?? '(path not parsed)',
        body,
      });
    });
  }
  return blocks;
}

describe('every mutating admin route writes an audit row', () => {
  it('CRITICAL the scan finds real admin routes, so an absence is measured against a real set', () => {
    const blocks = routeBlocks();
    expect(routeFiles().length, 'no route files found — the scan is broken').toBeGreaterThan(10);
    const adminMutations = blocks.filter((b) => MUTATING.has(b.verb) && isAdminPath(b.path));
    expect(
      adminMutations.length,
      'no mutating admin route found — either the registration idiom changed or the pattern is broken',
    ).toBeGreaterThan(25);
    // The whole point of the widening: a file not named `admin-*` that registers
    // an admin mutation must be inside the population. Asserted rather than
    // assumed, because the previous version of this arm passed without it.
    expect(
      adminMutations.filter((b) => !b.file.startsWith('admin-')).map((b) => b.file),
      'admin mutations outside an admin-named module are in scope',
    ).not.toEqual([]);
    // The detector must be able to answer BOTH ways, or the check below is
    // decided by the pattern rather than by the routes.
    expect(
      AUDIT_CALL.test('await withAudit(request, ...)'),
      'detector cannot see an audit call',
    ).toBe(true);
    expect(AUDIT_CALL.test('return reply.send(rows)'), 'detector says yes to anything').toBe(false);
  });

  it('CRITICAL a mutating admin route reaches an audit call', () => {
    const unaudited = routeBlocks()
      .filter((b) => MUTATING.has(b.verb) && isAdminPath(b.path) && !AUDIT_CALL.test(b.body))
      .filter((b) => !KNOWN_UNAUDITED.has(`${b.verb.toUpperCase()} ${b.path}`))
      .map((b) => `${b.file} ${b.verb.toUpperCase()} ${b.path}`)
      .sort();

    expect(
      unaudited,
      'these change state as a staff action and never reach the audit recorder, so the change ' +
        'cannot be attributed afterwards — migration 0097 records this shipping twice already',
    ).toEqual([]);
  });

  it('CRITICAL a rostered route that starts auditing is struck from the list. Checked in this direction too, because an exemption outlives its reason silently: when the enum migration lands and the OAuth routes are wired, nothing else in this suite would notice the entries here had become false, and a permanent exemption is how the guard stops covering the surface it names.', () => {
    const audited = routeBlocks()
      .filter((b) => MUTATING.has(b.verb) && isAdminPath(b.path))
      .filter(
        (b) => KNOWN_UNAUDITED.has(`${b.verb.toUpperCase()} ${b.path}`) && AUDIT_CALL.test(b.body),
      )
      .map((b) => `${b.verb.toUpperCase()} ${b.path}`)
      .sort();
    expect(audited, 'recorded here as unaudited but now reaches the recorder — strike it').toEqual(
      [],
    );

    // And an entry naming a route that no longer exists is equally stale.
    const live = new Set(
      routeBlocks()
        .filter((b) => MUTATING.has(b.verb) && isAdminPath(b.path))
        .map((b) => `${b.verb.toUpperCase()} ${b.path}`),
    );
    expect(
      [...KNOWN_UNAUDITED].filter((k) => !live.has(k)).sort(),
      'recorded here but no longer a mutating admin route — strike it',
    ).toEqual([]);
  });

  it('CRITICAL this set is the same set admin-audit-route-coverage-invariant carries. That file owns the finding and scans the whole admin surface; this one was the straggler still keyed to a filename. Three copies of one list drift — one gets struck when the migration lands and the others keep asserting a gap that closed — so it is pinned by reading the sibling source rather than by hoping they are edited together. A rename there fails here and names the rename, which is cheaper than a stale compliance claim.', () => {
    const siblingSource = readFileSync(
      resolve(HERE, 'admin-audit-route-coverage-invariant.test.ts'),
      'utf8',
    );
    const block = /const UNAUDITED_MUTATIONS: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\)/.exec(
      siblingSource,
    );
    expect(block, 'the sibling still declares UNAUDITED_MUTATIONS as a literal set').not.toBeNull();
    const theirs = [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(theirs.length, 'the sibling set parsed non-empty').toBeGreaterThan(0);
    expect([...KNOWN_UNAUDITED].sort(), 'the two rosters name the same routes').toEqual(theirs);
  });
});
