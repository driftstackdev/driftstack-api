// The request constraints in the published OpenAPI document are the constraints
// the routes actually enforce.
//
// `lib/openapi.ts` hand-writes a zod schema for every request body and query,
// and the route files hand-write the schema that actually runs. They are two
// copies of the same contract, and nothing compared them. When the published one
// is LOOSER, a customer generating a client from the spec — or reading the docs
// built from it — sends a value the document permits and receives a 400 for a
// rule they had no way to know about.
//
// Four were diverging when this was written, all in the same direction:
//
//   /v1/agent-sessions  token_budget           spec omitted max(10_000_000)
//   /v1/agent-sessions  driftstack_session_id  spec omitted max(100)
//   /v1/agent-sessions  geolocation.accuracy   spec omitted max(100_000)
//   /v1/admin/accounts  email_contains         spec omitted min(1), max(254)
//
// The accuracy one shows how these happen: `latitude` and `longitude` publish
// their `min`/`max` correctly on the very next lines, and only `accuracy` lost
// its bound. The route's comment explains why the token budget is capped —
// "can't trigger pathological accounting math with an implausibly large value" —
// so the constraint is deliberate and simply was not published.
//
// The REQUEST/RESPONSE distinction is the entire reason this comparison is
// trustworthy, and it is load-bearing rather than decorative. A first pass
// matched on field name alone and produced nine findings, of which FIVE were
// response fields: `region` is `z.string().nullable()` in an egress echo
// response and `z.string().min(1).max(64)` in a node registration request, and
// those are both correct. A response is describing what the server returns, not
// restricting what a caller may send, so a looser response chain is not drift.
// The classifier is verified below by asserting it still removes findings — if
// it ever collapsed and called everything a request, this file would start
// reporting those five again, and the assertion catches that rather than
// trusting the filter to keep working.
//
// Only fields declared exactly once on each side are compared. A name used with
// two different chains in the same file is a different question — which
// endpoint's copy is authoritative — and guessing would manufacture findings.
//
// COVERAGE, measured rather than assumed, and lower than it first looked. Of 43
// published request field names, 34 have a same-named declaration in a route
// file, but only 22 are unambiguous on BOTH sides and therefore actually
// compared — roughly half. The first floor written here said 34 and failed,
// which is the useful kind of failure: name-matching and comparability are
// different questions, and the gap between them was invisible until asserted.
//
//   22  compared
//    9  no route-side declaration this parser can see — four are structural
//       wrappers (`params`, `query`, `schema`, `event`, which are
//       `z.object({...})` containers rather than fields) and five are written
//       across several lines or declared elsewhere (`initial_url`, `value`)
//    4  the document declares the name with more than one chain
//       (`days`, `limit`, `cursor`, `description`)
//    8  a route declares the name with more than one chain (`email`,
//       `account_id`, `client_id`, `format`, `status`, `mode`, `mime`,
//       `payment_id`)
//
// The ambiguous twelve are not a parser weakness so much as a real question this
// file declines to guess at: the same field name means different things on
// different endpoints, and picking one chain to compare would manufacture
// findings. Both numbers are floored, because a comparison that quietly covers
// less reads exactly like one that finds nothing.
//
// Two blind spots worth naming rather than leaving to be discovered. `.refine()`
// is not treated as a narrowing constraint: it carries an arbitrary predicate
// that OpenAPI cannot express anyway, so `initial_url`'s http/https restriction
// is enforced and unpublishable rather than a drift. And a multi-line chain is
// invisible on both sides — `value` in the platform-secret body is one, which is
// why its published `max` was a hardcoded 8192 sitting beside a
// `PLATFORM_SECRET_VALUE_MAX_UTF8_BYTES` of 8192; that literal now derives from
// the constant, so there is one fewer copy for this file to fail to check.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(HERE, '..', '..', 'src');
const OPENAPI = resolve(SERVER_SRC, 'lib', 'openapi.ts');
const ROUTES = resolve(SERVER_SRC, 'routes');

/** zod calls that NARROW what is accepted. `.optional()`/`.nullable()` widen. */
const NARROWERS =
  /\.(max|min|length|regex|email|uuid|url|int|positive|nonnegative|gte|lte|gt|lt)\(([^)]*)\)/g;

const constraintsOf = (chain: string): Set<string> =>
  new Set([...chain.matchAll(NARROWERS)].map((m) => `${m[1]!}(${m[2]!})`));

const FIELD_LINE = /^\s*([a-z_][a-z0-9_]*)\s*:\s*(z\.[^\n]*?),\s*$/;

interface Decl {
  chain: string;
  request: boolean;
}

/**
 * Field declarations in the OpenAPI document, each tagged by the section it sits
 * in. The section is the nearest preceding `request:` / `responses:` key, which
 * is how the document is structured throughout.
 */
function publishedFields(): Map<string, Decl[]> {
  const out = new Map<string, Decl[]>();
  let request = false;
  for (const line of readFileSync(OPENAPI, 'utf8').split('\n')) {
    if (/^\s*request:\s*\{/.test(line)) request = true;
    else if (/^\s*responses:\s*\{/.test(line)) request = false;
    const m = FIELD_LINE.exec(line);
    if (m === null) continue;
    const list = out.get(m[1]!) ?? [];
    list.push({ chain: m[2]!, request });
    out.set(m[1]!, list);
  }
  return out;
}

/** Field declarations across the route files, with the file they came from. */
function enforcedFields(): Map<string, { chain: string; file: string }[]> {
  const out = new Map<string, { chain: string; file: string }[]>();
  for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
    for (const line of readFileSync(resolve(ROUTES, file), 'utf8').split('\n')) {
      const m = FIELD_LINE.exec(line);
      if (m === null) continue;
      const list = out.get(m[1]!) ?? [];
      list.push({ chain: m[2]!, file });
      out.set(m[1]!, list);
    }
  }
  return out;
}

/**
 * Field names where a published request declaration and an enforced declaration
 * are BOTH unambiguous, so the two can actually be compared.
 *
 * This is the comparison's coverage, and it is floored below. A field that
 * becomes uncomparable — a one-line chain reformatted across several lines —
 * silently reduces this file to checking less, which reads exactly like a clean
 * run.
 */
function comparablePairs(): { name: string; pub: string; run: string; file: string }[] {
  const published = publishedFields();
  const enforced = enforcedFields();
  const out: { name: string; pub: string; run: string; file: string }[] = [];
  for (const [name, decls] of published) {
    const chains = new Set(decls.filter((d) => d.request).map((d) => d.chain));
    const enc = enforced.get(name);
    if (enc === undefined || chains.size !== 1) continue;
    const encChains = new Set(enc.map((e) => e.chain));
    if (encChains.size !== 1) continue;
    out.push({ name, pub: [...chains][0]!, run: [...encChains][0]!, file: enc[0]!.file });
  }
  return out;
}

/**
 * Constraints a route enforces that the document does not publish.
 *
 * `requestOnly` is the real comparison; passing false is used only to prove the
 * request/response filter removes something.
 */
function looserThanEnforced(requestOnly: boolean): string[] {
  const published = publishedFields();
  const enforced = enforcedFields();
  const findings: string[] = [];
  for (const [name, decls] of published) {
    const relevant = requestOnly ? decls.filter((d) => d.request) : decls;
    const chains = new Set(relevant.map((d) => d.chain));
    const enc = enforced.get(name);
    if (enc === undefined || chains.size !== 1) continue;
    const encChains = new Set(enc.map((e) => e.chain));
    if (encChains.size !== 1) continue;
    const pub = [...chains][0]!;
    const run = [...encChains][0]!;
    const pc = constraintsOf(pub);
    const missing = [...constraintsOf(run)].filter((c) => !pc.has(c));
    if (missing.length === 0) continue;
    findings.push(
      `${name} [routes/${enc[0]!.file}]: the spec omits ${missing.join(', ')} — published ${pub}, enforced ${run}`,
    );
  }
  return findings.sort();
}

/**
 * The other direction: constraints the document PUBLISHES that no route
 * enforces — a validation customers are promised and never receive.
 */
function stricterThanEnforced(): string[] {
  return comparablePairs()
    .flatMap((p) => {
      const rc = constraintsOf(p.run);
      const extra = [...constraintsOf(p.pub)].filter((c) => !rc.has(c));
      return extra.length === 0
        ? []
        : [
            `${p.name} [routes/${p.file}]: the spec promises ${extra.join(', ')} but the route does not enforce it — published ${p.pub}, enforced ${p.run}`,
          ];
    })
    .sort();
}

describe('the published request schema is not looser than the enforced one', () => {
  it('CRITICAL both documents parsed into real field declarations. The comparison reports disagreement, so a parse that recovered nothing would agree with nothing and report every request field verified having read none of them.', () => {
    const published = publishedFields();
    const enforced = enforcedFields();

    // MEASURED: 297 published field names, 98 across the route files.
    expect(published.size, 'field names parsed from the OpenAPI document').toBeGreaterThanOrEqual(
      250,
    );
    expect(enforced.size, 'field names parsed from the route files').toBeGreaterThanOrEqual(80);

    const requestSide = [...published.values()].flat().filter((d) => d.request).length;
    const responseSide = [...published.values()].flat().filter((d) => !d.request).length;
    expect(requestSide, 'declarations classified as request-side').toBeGreaterThan(0);
    expect(responseSide, 'declarations classified as response-side').toBeGreaterThan(0);
  });

  it('CRITICAL the request/response classifier still removes findings. It is what makes this comparison honest — matching on field name alone reported nine, of which five were response fields whose looser chains are correct. A classifier that collapsed to "everything is a request" would silently reinstate those five, and this is the assertion that notices.', () => {
    const all = looserThanEnforced(false);
    const requestOnly = looserThanEnforced(true);

    // MEASURED: 5 response-side pairs differ and are correctly excluded.
    expect(
      all.length,
      'findings before the request/response filter — a floor on the filter having work to do',
    ).toBeGreaterThan(requestOnly.length);
  });

  it('CRITICAL the comparison still covers the request surface it did. MEASURED at 22 of 43 published request field names actually compared — the rest have no visible route-side declaration or are declared with more than one chain, which this file will not guess between. Reformatting a one-line chain silently shrinks what is checked, and a comparison covering less reads exactly like a comparison finding nothing.', () => {
    const pairs = comparablePairs();
    const publishedRequestNames = new Set(
      [...publishedFields()]
        .filter(([, decls]) => decls.some((d) => d.request))
        .map(([name]) => name),
    );

    expect(
      pairs.length,
      'published request fields with an unambiguous enforced counterpart',
    ).toBeGreaterThanOrEqual(22);
    expect(
      publishedRequestNames.size,
      'published request field names in total',
    ).toBeGreaterThanOrEqual(43);
  });

  it('CRITICAL the document does not promise a validation the route skips. The reverse of the arm below and the more dangerous direction to get wrong quietly: a published max that nothing enforces is a limit customers are told about and rely on, while the server accepts anything. MEASURED at zero.', () => {
    expect(
      stricterThanEnforced(),
      'constraint(s) the published schema promises but no route enforces:',
    ).toEqual([]);
  });

  it('CRITICAL every constraint a route enforces is published. The published document is what customers generate clients from, so a rule that exists only in the route is a 400 the caller could not have predicted — the four found when this was written were all in that direction, including a token budget cap the route deliberately imposes and the spec never mentioned.', () => {
    expect(
      looserThanEnforced(true),
      'request constraint(s) enforced by a route but absent from the published schema:',
    ).toEqual([]);
  });
});
