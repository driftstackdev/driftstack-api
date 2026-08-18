// What a path-parameterised route answers for an id that does not exist is a
// status its own contract documents — and a route that SUCCEEDS for a missing
// id does not also document a 404 it can never return.
//
// The same 46% blind spot as `templated-routes-refuse-anonymous-callers`: nine
// guards skip every templated operation, so `every-reached-status-is-documented`
// and `every-write-endpoint-errors-as-rfc7807` both stop at the `{`. This is the
// authenticated half. A synthetic id still needs no fixture data, because
// "resource missing" is a first-class outcome every one of these routes has to
// handle, and it is the outcome customers hit constantly — a stale id, a
// deleted profile, a copy-paste from another account.
//
// The second assertion is the one that found a real defect, and it points the
// opposite way from every other check in this repo. `DELETE /v1/admin/oauth/
// clients/{id}` documented `404 OAuth client not found` while its handler could
// not produce one: `revokeClient` returns void and both stores no-op on an
// unknown id, so an absent client answered 204 like any other. That is a
// deliberate idempotent delete — pinned as "the RFC-conformant idempotent-delete
// response" in routes-oauth-v667b-cross-source-invariant and asserted by the
// e2e suite — so the handler was right and the CONTRACT was fiction.
//
// It survived because the static guard asks the question in one direction only.
// `parameterised-routes-document-404` reports routes MISSING a 404 and keeps an
// exemption list of routes that cannot 404; this route was on neither, because
// it documented the 404 and so looked fine. A documented status nothing can
// return is not harmless: it is a branch every generated SDK models, an error
// path customers write handling for, and a promise the server silently breaks.
// The static guard cannot see it — knowing a handler CANNOT reach a status
// requires running it, which is what this file does.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './_helpers/build-test-app.js';

let fx: Awaited<ReturnType<typeof buildTestApp>>;
let spec: SpecDocument;

interface SpecDocument {
  paths?: Record<string, Record<string, Operation>>;
}
interface Operation {
  responses?: Record<string, { content?: Record<string, unknown> }>;
}

const METHODS = ['get', 'post', 'patch', 'put', 'delete'] as const;

/** A well-formed id that belongs to nobody. */
const SYNTHETIC_ID = '00000000-0000-4000-8000-0000000000ff';

/**
 * The server's own words for the id format it wanted.
 *
 * Most resources take a PREFIXED public id — `whk_<uuid>`, `prof_<uuid>`,
 * `inc_<uuid>` — and reject a bare uuid at parse time with a 400. Measured, a
 * bare uuid stopped 23 of the 43 templated GET/DELETE operations at that 400,
 * so 53% of them never reached the not-found path this file exists to check.
 * The sweep looked complete and was checking the id parser twice over.
 *
 * The prefix is DERIVED from the rejection rather than kept in a table here:
 * fourteen route files throw the same `Invalid id format. Expected "xxx_<uuid>"`
 * message, so the server names the format it wants and the probe follows it.
 * A hand-kept prefix map would go stale silently, and a route whose prefix
 * changed would quietly fall back to only ever testing its 400.
 */
// The quote is optional because the body is JSON and the message arrives
// escaped as `Expected \"whk_<uuid>\"`. Matching the unescaped spelling found
// nothing, the retry silently never fired, and every assertion still passed —
// a no-op that reads exactly like a clean result. The floor on `retried` below
// exists so that failure mode cannot come back quietly.
const EXPECTED_PREFIX = /Expected \\?"([a-z]+)_<uuid>/;

interface Probe {
  op: string;
  status: number;
  documented: boolean;
  documents404: boolean;
  problemShaped: boolean | null;
}

const probes: Probe[] = [];
const malformed: Probe[] = [];
let retried = 0;

/**
 * An id that is neither a bare uuid nor the prefixed form any route asks for.
 *
 * The sweep above deliberately sends a WELL-FORMED id that belongs to nobody, and
 * every other id-probing suite in this repo does the same — `SYNTHETIC_ID` here,
 * `nonexistentLike()` in the cross-account files, a never-created uuid in the
 * route tests. Nothing had ever sent a value the id parser cannot parse at all,
 * so a route that reaches its handler with unparseable input, or hands it to a
 * query, had no test anywhere.
 *
 * That gap has produced real defects twice: V-716 found a loose
 * `[0-9a-fA-F-]{36}` check letting a malformed id become a 500 on two routes, and
 * `findAccountIdFromCustomerOrRef` compares a caller-supplied string against a
 * `uuid` column where Postgres raises 22P02 rather than coercing.
 *
 * ⚠️ What this sweep can and cannot see. `buildTestApp` wires the IN-MEMORY repos,
 * which compare strings and never cast — so a Postgres cast error is invisible
 * here by construction. This checks the layer it can: parse, validate and handler
 * code reached with input the route was not written for. The database half needs
 * a real Postgres and belongs with the repo tests.
 */
const MALFORMED_ID = 'not-a-uuid';

beforeAll(async () => {
  fx = await buildTestApp({
    scopes: ['read', 'write', 'account_owner', 'driftstack_internal_admin'],
    withOauthStore: true,
    enableAgentRuntime: true,
    enableByokAnthropic: true,
  });
  spec = (await fx.app.inject({ method: 'GET', url: '/openapi.json' })).json<SpecDocument>();

  for (const path of Object.keys(spec.paths ?? {})) {
    if (!path.startsWith('/v1/') || !path.includes('{')) continue;
    const routeUrl = path.replace(/\{([^}]+)\}/g, ':$1');
    const url = path.replace(/\{[^}]+\}/g, SYNTHETIC_ID);

    for (const method of METHODS) {
      const op = spec.paths?.[path]?.[method];
      if (op === undefined) continue;

      // Streams hold the connection open; requesting one hangs the sweep.
      const responses = Object.values(op.responses ?? {});
      if (responses.some((r) => r.content?.['text/event-stream'] !== undefined)) continue;
      // Derived from the live route table, never a hand-kept list: an
      // unregistered route 404s from the not-found handler and would be scored
      // as a route that answered 404 on its own.
      if (!fx.app.hasRoute({ method: method.toUpperCase(), url: routeUrl })) continue;

      const send = async (target: string) =>
        fx.app.inject({
          method: method.toUpperCase() as 'GET',
          url: target,
          headers: { authorization: `Bearer ${fx.plaintext}` },
          ...(method === 'get' || method === 'delete' ? {} : { payload: {} }),
        });

      let res = await send(url);
      // If the route rejected the bare uuid, take it at its word and ask again
      // in the format it named. Without this the probe never gets past the id
      // parser on any prefixed-id resource.
      if (res.statusCode === 400) {
        const prefix = EXPECTED_PREFIX.exec(res.body);
        if (prefix !== null) {
          retried += 1;
          res = await send(path.replace(/\{[^}]+\}/g, `${prefix[1]}_${SYNTHETIC_ID}`));
        }
      }

      let problemShaped: boolean | null = null;
      if (res.statusCode >= 400) {
        let body: Record<string, unknown> = {};
        try {
          body = res.json<Record<string, unknown>>();
        } catch {
          body = {};
        }
        problemShaped =
          String(res.headers['content-type'] ?? '').includes('application/problem+json') &&
          ['type', 'title', 'status'].every((k) => body[k] !== undefined);
      }

      probes.push({
        op: `${method.toUpperCase()} ${path}`,
        status: res.statusCode,
        documented: op.responses?.[String(res.statusCode)] !== undefined,
        documents404: op.responses?.['404'] !== undefined,
        problemShaped,
      });

      // Second probe, same operation: an id the parser cannot parse. No retry
      // here — a 400 is the CORRECT answer to unparseable input, so re-asking in
      // the prefixed format would only measure the parser twice.
      const bad = await send(path.replace(/\{[^}]+\}/g, MALFORMED_ID));
      let badShaped: boolean | null = null;
      if (bad.statusCode >= 400) {
        let body: Record<string, unknown> = {};
        try {
          body = bad.json<Record<string, unknown>>();
        } catch {
          body = {};
        }
        badShaped =
          String(bad.headers['content-type'] ?? '').includes('application/problem+json') &&
          ['type', 'title', 'status'].every((k) => body[k] !== undefined);
      }
      malformed.push({
        op: `${method.toUpperCase()} ${path}`,
        status: bad.statusCode,
        documented: op.responses?.[String(bad.statusCode)] !== undefined,
        documents404: op.responses?.['404'] !== undefined,
        problemShaped: badShaped,
      });
    }
  }
}, 180_000);

afterAll(async () => {
  await fx.app.close();
});

describe('templated routes answer a documented status for a nonexistent id', () => {
  it('CRITICAL the sweep probed the real templated population with real credentials. Every assertion below reports an ABSENCE, so a sweep that resolved nothing — or whose token was rejected everywhere — would satisfy them having proved nothing.', () => {
    // MEASURED: 102 templated operations reached. The distribution matters as
    // much as the count — a token that stopped authenticating would show as a
    // wall of 401s while every absence assertion still passed.
    expect(probes.length, 'templated operations probed with credentials').toBeGreaterThanOrEqual(
      95,
    );
    expect(
      probes.filter((p) => p.status === 401).length,
      'operations that rejected the credential — a handful of admin surfaces do by design, a wall of them means the fixture token broke',
    ).toBeLessThanOrEqual(5);
    // MEASURED: 61 operations reach a real not-found path, up from 27 before
    // the probe started honouring the prefixed-id format the server asks for.
    expect(
      probes.filter((p) => p.status === 404).length,
      'operations that reached a real not-found path',
    ).toBeGreaterThanOrEqual(50);

    // The retry is the reason that number is 61 and not 27, and it failed
    // SILENTLY once already: the first version matched an unescaped quote that
    // never appears in a JSON body, so it fired zero times and every assertion
    // here still passed. A no-op that reads as a clean result is the whole
    // failure mode this file exists to prevent, so the retry has to prove it
    // ran. MEASURED at 57.
    expect(
      retried,
      'operations that were re-probed in the id format the server named — zero means the prefix was never parsed and this sweep is only testing the id parser',
    ).toBeGreaterThanOrEqual(40);
  });

  it('CRITICAL every status returned for a nonexistent id is documented. A status the server returns but the contract omits is one no generated SDK models, and "the id was not found" is the single most common error a customer meets.', () => {
    expect(
      probes.filter((p) => !p.documented).map((p) => `${p.op} -> ${String(p.status)}`),
      'templated route(s) returning an undocumented status for a missing id:',
    ).toEqual([]);
  });

  it('CRITICAL no route that SUCCEEDS for a nonexistent id also documents 404. This is the direction the static guard cannot see: it reports routes MISSING a 404, so a route documenting one it can never return looks correct. DELETE /v1/admin/oauth/clients/{id} sat that way — an idempotent delete promising a not-found branch every SDK modelled and the server never sent.', () => {
    expect(
      probes
        .filter((p) => p.status >= 200 && p.status < 300 && p.documents404)
        .map((p) => `${p.op} answers ${String(p.status)} for a missing id yet documents 404`),
      'route(s) documenting an unreachable 404:',
    ).toEqual([]);
  });

  it('CRITICAL every error a templated route returns is RFC 7807. The sibling sweep drives writes with a bad payload but skips every templated path, so these bodies — the ones a customer meets on a stale id — had never been shape-checked.', () => {
    expect(
      probes.filter((p) => p.problemShaped === false).map((p) => `${p.op} -> ${String(p.status)}`),
      'templated route(s) whose error body is not application/problem+json with type/title/status:',
    ).toEqual([]);
  });

  it('CRITICAL the malformed sweep ran over the same population. It shares the loop with the sweep above, so a change that skipped it would leave every absence assertion below satisfied on an empty set — the same no-op-reads-as-clean failure the retry floor exists for.', () => {
    expect(malformed.length, 'operations probed with an unparseable id').toBe(probes.length);
    expect(malformed.length, 'the malformed sweep collected nothing').toBeGreaterThanOrEqual(95);
  });

  // ⚠️ The first version of this arm asserted `status >= 500` and FAILED on
  // `GET` and `POST /v1/sessions/{id}/proxy` -> 503. Measured before writing it up:
  // the WELL-FORMED sweep gets 503 from those two as well, and both document it.
  // It is the deployment's capability gate ahead of the id — customer-configurable
  // egress has no backend here — not a crash on bad input, and the
  // cross-account-session-isolation suite already exempts the same pair for the
  // same reason. A blunt 5xx ban would have reported a deliberate, contract-declared
  // answer as a defect.
  //
  // So the property splits in two, and both halves are worth having: a 500 is never
  // a contract no matter what the spec says, and any OTHER 5xx has to at least be
  // declared.
  it('CRITICAL an unparseable id never produces a 500. Every id-probing suite in this repo sends a well-formed id that belongs to nobody, so nothing had ever asked what happens when the parser cannot parse at all — and that exact gap produced V-716, where a loose id check turned a malformed id into a 500 on two routes. A 500 is the server telling the customer they broke it, on input a customer sends by pasting the wrong thing.', () => {
    expect(
      malformed.filter((p) => p.status === 500).map((p) => `${p.op} -> ${String(p.status)}`),
      'templated route(s) answering 500 for an unparseable id:',
    ).toEqual([]);
  });

  it('CRITICAL any other 5xx for a malformed id is at least documented. A 503 from a capability gate is a deliberate answer and stays allowed; an UNDECLARED 5xx is the shape of something escaping rather than being decided.', () => {
    expect(
      malformed
        .filter((p) => p.status >= 500 && !p.documented)
        .map((p) => `${p.op} -> ${String(p.status)}`),
      'templated route(s) answering an undocumented 5xx for an unparseable id:',
    ).toEqual([]);
  });

  it('CRITICAL a malformed id gets a documented status too. A route that answers 400 for garbage input while documenting only 404 leaves every generated SDK without a branch for the most common client mistake there is.', () => {
    expect(
      malformed.filter((p) => !p.documented).map((p) => `${p.op} -> ${String(p.status)}`),
      'templated route(s) returning an undocumented status for an unparseable id:',
    ).toEqual([]);
  });

  it('CRITICAL a malformed id gets an RFC 7807 body. This is the response a customer meets after a copy-paste error, and it is the one most likely to be handled by code rather than read by a person.', () => {
    expect(
      malformed
        .filter((p) => p.problemShaped === false)
        .map((p) => `${p.op} -> ${String(p.status)}`),
      'templated route(s) whose malformed-id error body is not application/problem+json:',
    ).toEqual([]);
  });
});
