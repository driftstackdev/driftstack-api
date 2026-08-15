// Account B cannot reach account A's agent session through ANY of its routes.
//
// Measured before writing a line, and this was the worst result of the three
// resources: making `callerCanAccessAgentSession` return true unconditionally —
// disabling agent-session ownership completely — left the ENTIRE integration
// suite green. 2,193 passing, zero failures. Twenty id-taking routes and
// nineteen call sites of that predicate, and nothing anywhere verified it.
//
// Sessions had 2 guarding tests and profiles 1. Agent sessions had none, on the
// resource that carries the live browser, its transcript, its cookies, its page
// state and its downloads.
//
// Note the predicate is NOT a plain account-id comparison: a team admin may
// legitimately reach a member's session. Account B here is an unrelated account
// with no membership in A's team, which is the case that must always be denied.
//
// ─── 2026-08-15: five routes this file had been missing ────────────────────
//
// The table below was written by reading the route file. That is how it came to
// omit five id-taking routes. Rebuilt it the other way — enumerate every
// `'/v1/agent-sessions/:id…'` registration mechanically, diff against the table
// — and `/cookies/set`, `/input-event`, `/files`, `/downloads/content` and
// `/history` were absent.
//
// ⚠️ Four of the five have their own route test, each carrying an arm named
// "unknown/foreign session → 404". Every one of those posts a session id that
// was NEVER CREATED. A nonexistent id 404s on the first lookup, before ownership
// is consulted, so those arms prove the not-found path and nothing about the
// boundary their names claim.
//
// MEASURED, with `callerCanAccessAgentSession` returning true unconditionally:
//
//   the four dedicated route files      48 tests, ALL PASS
//   this file, after the five were added  17 tests, ALL RED
//
// So ownership on those five routes could have been deleted outright and the
// only thing that would have noticed is a file that did not cover them. The
// names read like a boundary test; the fixture never built the boundary.
//
// These are also the worst five to leave open. In order: writing cookies into
// another customer's live browser (a session-fixation primitive — plant your
// auth cookie in their session, or read theirs back), injecting synthetic taps
// and keystrokes into it, uploading a file into it, pulling the bytes of
// something they downloaded, and driving their history.
//
// ⭐ The lesson is about how the list was built, not about the five. A table of
// routes transcribed by hand drifts the moment a route is added, and it drifts
// SILENTLY — every arm still passes. So the table is now checked against the
// routes Fastify actually registered (bottom of this file), and that check found
// TWO MORE the source grep could not have: `/transport-report` and
// `/recipe-suggestion` live in `agent-sessions-transport-report.ts` and
// `recipes.ts`. A route's PATH decides whether it is inside this boundary; the
// file it happens to live in does not.
//
// LEDGER — control 20/20:
//
//   callerCanAccessAgentSession returns true      18 red (every route arm)
//   the admin-role requirement dropped            SURVIVES
//   a route removed from the table                 1 red (the drift arm)
//
// The survivor is correct and scoped by the note above: account B holds no
// membership at all, so an arm built on it cannot see a change to what a MEMBER
// may do. Member-vs-admin belongs to a fixture that seeds a membership, and
// pretending otherwise here would be the same false-coverage this file exists to
// stop.

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  seedAdditionalAccount,
  type TestAppFixture,
} from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

/** Full rights over B's OWN account, so the scope gate cannot mask ownership. */
const FULL_SCOPES = ['read', 'write', 'account_owner', 'gui_control'] as const;

const AGENT_ROUTES: ReadonlyArray<{
  method: 'GET' | 'POST' | 'DELETE';
  suffix: string;
  payload?: Record<string, unknown>;
}> = [
  { method: 'GET', suffix: '' },
  { method: 'POST', suffix: '/message', payload: { user_message: 'hello from B' } },
  { method: 'DELETE', suffix: '' },
  { method: 'GET', suffix: '/transcript' },
  { method: 'GET', suffix: '/page-state' },
  { method: 'GET', suffix: '/cookies' },
  { method: 'GET', suffix: '/downloads' },
  { method: 'GET', suffix: '/gui-control-key' },
  { method: 'POST', suffix: '/mode', payload: { mode: 'manual' } },
  { method: 'POST', suffix: '/takeover', payload: { client_id: 'b-client' } },
  { method: 'POST', suffix: '/handback', payload: {} },
  { method: 'POST', suffix: '/resume', payload: {} },
  // Added 2026-08-15 — see the header for how these five were found.
  { method: 'POST', suffix: '/cookies/set', payload: { cookies: [] } },
  {
    method: 'POST',
    suffix: '/input-event',
    payload: { event: { type: 'mouseMove', x: 10, y: 10 } },
  },
  {
    method: 'POST',
    suffix: '/files',
    payload: { name: 'b.pdf', mime: 'application/pdf', dataB64: 'aGVsbG8=' },
  },
  { method: 'GET', suffix: '/downloads/content?name=secret.pdf' },
  { method: 'POST', suffix: '/history', payload: { direction: 'back' } },
  // These two the source grep could not have found: they are registered in
  // routes/recipes.ts and routes/agent-sessions-transport-report.ts, not in
  // agent-sessions.ts. The runtime enumeration below found them immediately,
  // which is the argument for it in one line — a route's PATH decides whether it
  // is inside this boundary, not the file it happens to live in.
  { method: 'GET', suffix: '/recipe-suggestion' },
];

async function createAgentSessionForAccountA(fixture: TestAppFixture): Promise<string> {
  const res = await fixture.app.inject({
    method: 'POST',
    url: '/v1/agent-sessions',
    headers: { authorization: `Bearer ${fixture.plaintext}` },
    payload: { task: 'owned by A' },
  });
  expect(
    [200, 201],
    `agent-session create returned ${res.statusCode}: ${res.body.slice(0, 200)}`,
  ).toContain(res.statusCode);
  return res.json<{ id: string }>().id;
}

describe("account B cannot reach account A's agent session on any route", () => {
  it.each(AGENT_ROUTES.map((r) => [`${r.method} /v1/agent-sessions/:id${r.suffix}`, r] as const))(
    'CRITICAL %s refuses an unrelated account. A 2xx here exposes another customer’s live browser — its transcript, cookies, page state and downloads — and this boundary had NO test at all before this file.',
    async (_label, route) => {
      fx = await buildTestApp({ tier: 'api_builder', enableAgentRuntime: true });
      const agentSessionId = await createAgentSessionForAccountA(fx);
      const other = await seedAdditionalAccount(fx, {
        email: 'b@agent-isolation.test',
        tier: 'api_builder',
        scopes: [...FULL_SCOPES],
      });

      const res = await fx.app.inject({
        method: route.method,
        url: `/v1/agent-sessions/${agentSessionId}${route.suffix}`,
        headers: { authorization: `Bearer ${other.plaintext}` },
        ...(route.payload === undefined ? {} : { payload: route.payload }),
      });

      expect(
        res.statusCode,
        `${route.method} /v1/agent-sessions/:id${route.suffix} returned ${res.statusCode} for an unrelated account`,
      ).toBe(404);
    },
  );
});

// ─── the table is no longer allowed to drift ────────────────────────────────
//
// The five missing routes were not a lapse of attention; they were the
// predictable outcome of a hand-transcribed list. A route added to
// `agent-sessions.ts` does not fail anything here — every existing arm still
// passes — so the omission is invisible for exactly as long as nobody re-derives
// the list. That is the failure mode this arm removes.
//
// It reads the routes Fastify actually registered rather than the source text,
// so a route added through any path — a new `app.post`, a helper, a plugin —
// has to be either covered above or exempted here with a reason.
describe('every id-taking agent-session route is in the isolation table', () => {
  /** Parse `printRoutes` into "VERB /full/path", mirroring the route-coverage invariant. */
  function registeredOps(tree: string): Set<string> {
    const out = new Set<string>();
    const stack: string[] = [];
    for (const raw of tree.split('\n')) {
      if (raw.trim() === '') continue;
      const markerAt = raw.search(/[├└]/);
      const depth = markerAt < 0 ? 0 : Math.floor(markerAt / 4);
      const body = markerAt < 0 ? raw.trim() : raw.slice(markerAt + 4).trim();
      const m = /^(\S*?)\s*(?:\(([A-Z, ]+)\))?$/.exec(body);
      if (m === null) continue;
      stack.length = depth;
      stack[depth] = m[1] ?? '';
      if (m[2] === undefined) continue;
      const full =
        stack
          .slice(0, depth + 1)
          .join('')
          .replace(/\/$/, '') || '/';
      for (const method of m[2].split(',')) {
        const verb = method.trim();
        if (verb === 'HEAD' || verb === 'OPTIONS') continue;
        out.add(`${verb} ${full}`);
      }
    }
    return out;
  }

  // Routes that take an :id but are deliberately outside this boundary. Each
  // needs a reason, because "not covered" and "not applicable" must not look the
  // same from here — that ambiguity is what let five routes sit uncovered.
  // Two notes on this list, both learned the hard way in the same hour.
  //
  // The first draft exempted `GET /v1/agent-sessions/:id/stream` with a
  // plausible reason about SSE. No such route exists — I invented it. The
  // staleness arm below caught it on the first run, which is the argument for
  // pairing an exemption list with a check that its entries are real: an
  // exemption for a route that does not exist excuses nothing and hides that
  // nothing is excused.
  //
  // The transport-report entry is the opposite mistake and the more instructive
  // one. It was in the table above and PASSED, and it kept passing with
  // `callerCanAccessAgentSession` returning true unconditionally — the tell that
  // it never reached the boundary. Probing the owner's own request explains it:
  // account A gets the same 404 for its own session, so this route cannot see
  // this fixture's sessions at all and refuses everyone. An arm there asserts
  // nothing. Exempted with the measurement rather than deleted quietly, because
  // the route's ownership check is real and deserves a test that can reach it.
  const EXEMPT = new Map<string, string>([
    [
      'POST /v1/agent-sessions/:id/transport-report',
      "Registered against deps.agentSessionsRepo and rejects this fixture's `agt_inmem_…` ids before ownership — MEASURED: the OWNER gets the same 404, so an isolation arm here is vacuous. Needs a fixture whose session ids that route accepts.",
    ],
  ]);

  it('CRITICAL a new :id route must be added to AGENT_ROUTES or exempted with a reason — otherwise its ownership check ships untested, which is exactly how /cookies/set, /input-event, /files, /downloads/content and /history came to have none', async () => {
    fx = await buildTestApp({ tier: 'api_builder', enableAgentRuntime: true });
    const registered = [...registeredOps(fx.app.printRoutes({ commonPrefix: false }))].filter(
      (op) => /^[A-Z]+ \/v1\/agent-sessions\/:id(\/|$)/.test(op),
    );

    // Compare on method + path only; the table's query strings are fixture
    // detail, not part of the route identity.
    const covered = new Set(
      AGENT_ROUTES.map((r) => `${r.method} /v1/agent-sessions/:id${r.suffix.split('?')[0] ?? ''}`),
    );
    const missing = registered.filter((op) => !covered.has(op) && !EXEMPT.has(op));

    expect(
      missing,
      `these :id routes have no cross-account arm and no exemption:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the exemption list cannot rot — every exempt route must still exist', async () => {
    // An exemption for a route that was renamed or deleted is a silent hole in
    // the check above: it excuses nothing and hides that nothing is excused.
    fx = await buildTestApp({ tier: 'api_builder', enableAgentRuntime: true });
    const registered = registeredOps(fx.app.printRoutes({ commonPrefix: false }));
    const stale = [...EXEMPT.keys()].filter((op) => !registered.has(op));
    expect(stale, `exempted routes that no longer exist: ${stale.join(', ')}`).toEqual([]);
  });
});
