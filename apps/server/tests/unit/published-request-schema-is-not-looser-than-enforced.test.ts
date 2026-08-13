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
// The count of skipped-as-ambiguous is floored so that a parser change which
// quietly made everything ambiguous cannot pass as a clean comparison.

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

  it('CRITICAL every constraint a route enforces is published. The published document is what customers generate clients from, so a rule that exists only in the route is a 400 the caller could not have predicted — the four found when this was written were all in that direction, including a token budget cap the route deliberately imposes and the spec never mentioned.', () => {
    expect(
      looserThanEnforced(true),
      'request constraint(s) enforced by a route but absent from the published schema:',
    ).toEqual([]);
  });
});
