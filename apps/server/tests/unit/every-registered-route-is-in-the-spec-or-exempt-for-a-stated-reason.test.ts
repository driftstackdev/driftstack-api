// Every route the server registers under /v1 is either in the OpenAPI spec or
// is exempt for a STATED reason — and every exemption is re-checked both ways.
//
// `lib/openapi.ts` is hand-maintained (one `registerRoute` per method+path),
// so nothing ties it to what `routes/*.ts` actually register. A 2026-06-03
// spot-check found no undocumented customer route and recorded "NO automated
// route↔openapi coverage guard" as the open half. V-2130 measured it instead of
// spot-checking: 311 `app.<verb>` sites, 254 distinct (method, path) pairs, 234
// spec entries, 16 registered-but-undocumented — every one a deliberate class
// (internal fleet, inbound receivers, browser legs, GUI-client-only, public
// SSE, one smoke endpoint) that NOTHING pinned. The next GUI-only endpoint
// would have stayed silently undocumented, and the next customer endpoint too.
//
// The census is static text, not a booted app — the app needs every production
// dependency to build — so it carries its own completeness control: every
// `app.<verb>` occurrence must be accounted for (literal path, template path,
// or listed non-/v1), and the count must clear a floor.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(HERE, '..', '..', 'src');
const ROUTES_DIR = resolve(SERVER_SRC, 'routes');
const APP_TS = resolve(SERVER_SRC, 'lib', 'app.ts');
const OPENAPI_TS = resolve(SERVER_SRC, 'lib', 'openapi.ts');

/** `:id` and `{id}` both become `{}` — the two sides spell parameters differently. */
function normalize(path: string): string {
  return path.replace(/:[A-Za-z_]+/g, '{}').replace(/\{[A-Za-z_]+\}/g, '{}');
}

/** Every `app.<verb>` site. `\b` after the verb keeps `app.routeOptions` out. */
const VERB_SITE = /\bapp\.(get|post|put|patch|delete|route)\b/g;
/**
 * A literal registration, with an optional generic between verb and paren —
 * `app.delete<{ Params: { id: string } }>('/v1/sessions/:id'`. One level of
 * nested `<>` (`Record<string, string>`) is enough for every site today; a
 * deeper one lands in `unparsed`, which is asserted empty, so it cannot hide.
 */
const LITERAL = /^app\.(get|post|put|patch|delete)(?:<(?:[^()<>]|<[^()<>]*>)*>)?\(\s*'([^']+)'/;
/** A template-literal path — registered in a loop, e.g. per OAuth provider. */
const TEMPLATE = /^app\.(get|post|put|patch|delete)(?:<(?:[^()<>]|<[^()<>]*>)*>)?\(\s*`([^`]+)`/;

/**
 * Registered under /v1 and deliberately outside the published contract. The
 * reason is the key: an entry whose reason stops being true should be deleted,
 * and the arms below go red if its route is retired (stale exemption) or if it
 * becomes documented (exemption no longer needed).
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  // Fleet / internal — node- or operator-authenticated, not a customer surface.
  ['GET /v1/internal/atlas-priority/event/{}', 'internal fleet control plane'],
  ['GET /v1/internal/atlas-priority/queue', 'internal fleet control plane'],
  ['POST /v1/internal/atlas-priority/event-status', 'internal fleet control plane'],
  ['POST /v1/internal/atlas-priority/probe-signature', 'internal fleet control plane'],
  ['GET /v1/mac-nodes', 'fleet node registry (operator)'],
  ['POST /v1/mac-nodes', 'fleet node registry (operator)'],
  ['POST /v1/mac-nodes/{}/control', 'fleet node registry (operator)'],
  // Inbound receivers — the provider calls us; signature-authenticated.
  ['POST /v1/webhooks/stripe', 'inbound provider webhook receiver'],
  ['POST /v1/webhooks/nowpayments', 'inbound provider webhook receiver'],
  // Browser legs of interactive flows — reached by redirect, never by an SDK.
  ['GET /v1/auth/oauth-client/callback', 'browser leg of an interactive flow'],
  ['GET /v1/auth/oauth/{}/callback', 'browser leg of an interactive flow (per provider)'],
  ['POST /v1/oauth/authorize/complete', 'browser leg of an interactive flow'],
  // GUI-client-only — the desktop client's private endpoints.
  ['POST /v1/sessions/{}/gui-input', 'gui-client only'],
  ['GET /v1/agent-sessions/{}/gui-control-key', 'gui-client only'],
  ['POST /v1/agent-sessions/{}/transport-report', 'gui-client only'],
  // Public SSE — a stream, not a request/response the spec models.
  ['GET /v1/status/stream', 'public SSE stream'],
  // Customer-authenticated smoke endpoint. docs/reference/scopes.md mentions it,
  // the spec does not — adding it changes the published contract (an owner
  // call, W-10 class), so it is recorded here rather than decided here.
  ['GET /v1/whoami', 'auth smoke endpoint — documented in prose, not in the spec (owner call)'],
]);

/** Registered outside /v1 — infrastructure, never part of the contract. */
const NON_V1 = [
  'GET /health',
  'GET /healthz',
  'GET /metrics',
  'GET /openapi.json',
  'GET /ready',
  'GET /version',
];

interface Census {
  occurrences: number;
  /** normalized `METHOD /path` → first `file:line` */
  registered: Map<string, string>;
  unparsed: string[];
}

function routeFiles(): string[] {
  // No existsSync guard: if the routes directory moves this must throw, not
  // report an empty census.
  const files = readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => resolve(ROUTES_DIR, f));
  files.push(APP_TS);
  return files;
}

function isProseLine(src: string, idx: number): boolean {
  const start = src.lastIndexOf('\n', idx - 1) + 1;
  const end = src.indexOf('\n', idx);
  return /^\s*(\*|\/\/)/.test(src.slice(start, end === -1 ? src.length : end));
}

function censusOf(files: string[]): Census {
  const out: Census = { occurrences: 0, registered: new Map(), unparsed: [] };
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const name = file.slice(SERVER_SRC.length + 1);
    for (const m of src.matchAll(VERB_SITE)) {
      if (m.index === undefined || isProseLine(src, m.index)) continue;
      out.occurrences += 1;
      const at = `${name}:${src.slice(0, m.index).split('\n').length.toString()}`;
      const after = src.slice(m.index, m.index + 400);
      const lit = LITERAL.exec(after);
      const tpl = lit === null ? TEMPLATE.exec(after) : null;
      const hit = lit ?? tpl;
      if (hit === null) {
        out.unparsed.push(`${at} ${after.split('\n')[0] ?? ''}`);
        continue;
      }
      const rawPath = (hit[2] ?? '').replace(/\$\{[^}]*\}/g, '{}');
      const key = `${(hit[1] ?? '').toUpperCase()} ${normalize(rawPath)}`;
      if (!out.registered.has(key)) out.registered.set(key, at);
    }
  }
  return out;
}

function documentedPairs(spec: string): { pairs: Set<string>; pathEntries: number } {
  const pairs = new Set<string>();
  for (const m of spec.matchAll(/method:\s*'(\w+)',\s*\n\s*path:\s*'([^']+)'/g)) {
    pairs.add(`${(m[1] ?? '').toUpperCase()} ${normalize(m[2] ?? '')}`);
  }
  for (const m of spec.matchAll(/path:\s*'([^']+)',\s*\n\s*method:\s*'(\w+)'/g)) {
    pairs.add(`${(m[2] ?? '').toUpperCase()} ${normalize(m[1] ?? '')}`);
  }
  return { pairs, pathEntries: (spec.match(/^\s*path: '/gm) ?? []).length };
}

const census = censusOf(routeFiles());
const spec = documentedPairs(readFileSync(OPENAPI_TS, 'utf8'));
const registeredV1 = [...census.registered.keys()].filter((k) => k.includes(' /v1/'));

describe('every registered route is in the spec or exempt for a stated reason', () => {
  it('CRITICAL the census is complete: every app.<verb> site parsed, and enough of them', () => {
    expect(census.unparsed, 'registration sites the matcher could not read').toEqual([]);
    // Measured 311 / 254 / 234 on 2026-08-28; floors sit well under, so the
    // population may shrink but a broken walker or matcher cannot pass on air.
    expect(census.occurrences).toBeGreaterThan(280);
    expect(census.registered.size).toBeGreaterThan(230);
    expect(spec.pairs.size).toBeGreaterThan(210);
    // Every `path:` entry in the spec was paired with a `method:` — otherwise a
    // documented route could be missing from the comparison without a trace.
    expect(spec.pairs.size).toBe(spec.pathEntries);
  });

  it('CRITICAL every /v1 route registered by the server is documented or exempt for a stated reason', () => {
    const offenders = registeredV1
      .filter((k) => !spec.pairs.has(k) && !EXEMPT.has(k))
      .map((k) => `${k}  (${census.registered.get(k) ?? '?'})`);
    expect(
      offenders,
      `registered under /v1 but neither in lib/openapi.ts nor exempt:\n  ${offenders.join('\n  ')}\n` +
        `Either registerRoute() it in the spec, or add it to EXEMPT with the reason it is outside the contract.`,
    ).toEqual([]);
  });

  it('CRITICAL every exemption still names a registered, undocumented route — a stale one is deleted, not kept', () => {
    const retired = [...EXEMPT.keys()].filter((k) => !census.registered.has(k));
    expect(retired, 'exempt routes that are no longer registered').toEqual([]);
    const nowDocumented = [...EXEMPT.keys()].filter((k) => spec.pairs.has(k));
    expect(nowDocumented, 'exempt routes that are now in the spec (drop the exemption)').toEqual(
      [],
    );
  });

  it('CRITICAL the spec advertises no route the server does not register', () => {
    const phantom = [...spec.pairs].filter((k) => !census.registered.has(k)).sort();
    expect(phantom, 'documented in lib/openapi.ts but registered nowhere').toEqual([]);
  });

  it('the non-/v1 registrations are exactly the infrastructure endpoints', () => {
    const nonV1 = [...census.registered.keys()].filter((k) => !k.includes(' /v1/')).sort();
    expect(nonV1).toEqual(NON_V1);
  });

  it('the matchers read every registration shape and skip prose', () => {
    expect(LITERAL.exec("app.get('/v1/x', h)")?.[2]).toBe('/v1/x');
    expect(
      LITERAL.exec("app.delete<{ Params: { id: string } }>(\n  '/v1/sessions/:id',")?.[2],
    ).toBe('/v1/sessions/:id');
    expect(LITERAL.exec("app.get<{ Querystring: Record<string, string> }>('/v1/q')")?.[2]).toBe(
      '/v1/q',
    );
    expect(TEMPLATE.exec('app.get<{ Q: X }>(\n  `/v1/auth/oauth/${provider}/callback`,')?.[2]).toBe(
      '/v1/auth/oauth/${provider}/callback',
    );
    expect(normalize('/v1/a/:id/b/{name}')).toBe('/v1/a/{}/b/{}');
    expect([...'const u = app.routeOptions.url;'.matchAll(VERB_SITE)]).toHaveLength(0);
    expect(isProseLine("  // app.get('/v1/old') used to live here\nx", 5)).toBe(true);
    expect(isProseLine("  app.get('/v1/new', h)\nx", 5)).toBe(false);
  });
});
