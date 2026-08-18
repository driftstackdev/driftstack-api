// The reverse of `every-documented-endpoint-exists`: a route nobody wrote down.
//
// That guard checks one direction and says so in its header — every endpoint the
// docs promise is registered — and it records why it stopped there: "the reverse
// is a different question with different answers (health probes, internal fleet
// endpoints and the box's egress-echo diagnostic are all deliberately
// undocumented), and a naive version of it over-reports badly: it flagged
// /v1/agent-sessions, which appears in twelve docs pages."
//
// Both halves of that are right. The fix for the over-reporting is not a better
// prose matcher — it is to check the OPENAPI SPEC first, because the spec is the
// machine-readable contract and the SDKs are derived from it. Against the spec
// AND the backticked doc lines, 252 registered routes leave 17 written down
// nowhere. That is a set small enough to read.
//
// Fifteen are infrastructure or machine-to-machine and should stay that way:
// probes, /metrics, the spec endpoint itself, the internal atlas-priority pair,
// mac-node registration and control, the box's transport report, the two
// provider webhook receivers (documented by Stripe and NowPayments, not by us)
// and the OAuth redirect target (a browser lands on it; nobody calls it).
//
// TWO ARE NOT:
//
//   POST /v1/sessions/{id}/gui-input          gated by the `gui_control` scope
//   GET  /v1/agent-sessions/{id}/gui-control-key   mints a control+read credential
//
// Both are reachable with an ordinary customer key. `gui_control` is in
// ApiKeyScopeSchema, reference/scopes.md documents it, and V-788 established
// that nothing restricts who may request it — so a customer can hold a scope
// whose ONLY endpoint appears in neither the spec nor the docs, and no SDK
// exposes it because no SDK is generated for a path the spec does not contain.
//
// This does not add them to the spec. Publishing an endpoint is a product
// commitment — it is what the SDKs generate against and what the deprecation
// policy then covers — and `gui-control-key` in particular hands back a
// credential that the source comment describes as reaching five other routes
// with no scope check of its own (audit wxzlp9yiz, a P1 auth bypass). Deciding
// whether that is a public API is not a drift guard's call. Recording that the
// decision has not been made is.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..', '..', 'src');
const DOCS = resolve(HERE, '..', '..', '..', 'docs', 'src', 'pages');

/** `{id}` and `:id` both become `:p` so the three vocabularies compare. */
const norm = (p: string): string =>
  p
    .replace(/\{[^}]+\}/g, ':p')
    .replace(/:[A-Za-z_]+/g, ':p')
    .replace(/\/+$/, '');

/** A commented-out registration is not a route. */
const codeLines = (file: string): string =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

/**
 * Routes that are registered and appear in neither the spec nor the docs, and
 * why each one is not written down.
 *
 * `infra`   — probes and operational endpoints; no customer calls them.
 * `m2m`     — machine-to-machine, authenticated as a node or a provider.
 * `CUSTOMER` — reachable with a customer API key. Shouted, because this is the
 *             category where "undocumented" means a customer cannot use what
 *             they are entitled to and cannot review what their key can do.
 */
const UNDOCUMENTED_ROUTES = new Map<string, string>([
  ['GET /healthz', 'infra — liveness probe'],
  ['GET /metrics', 'infra — Prometheus scrape'],
  ['GET /openapi.json', 'infra — serves the spec; documenting it in the spec would be circular'],
  ['GET /ready', 'infra — readiness probe'],
  [
    'GET /v1/agent-sessions/:p/gui-control-key',
    'CUSTOMER — mints a control+read credential for the desktop client. Requires write + read:sessions on an ordinary key',
  ],
  ['GET /v1/auth/oauth-client/callback', 'm2m — the redirect target a browser lands on'],
  ['GET /v1/internal/atlas-priority/event/:p', 'm2m — internal capture orchestration'],
  ['GET /v1/internal/atlas-priority/queue', 'm2m — internal capture orchestration'],
  ['GET /v1/mac-nodes', 'm2m — fleet registration, node-authenticated'],
  ['POST /v1/agent-sessions/:p/transport-report', 'm2m — box to control plane telemetry'],
  ['POST /v1/internal/atlas-priority/event-status', 'm2m — internal capture orchestration'],
  ['POST /v1/internal/atlas-priority/probe-signature', 'm2m — internal capture orchestration'],
  ['POST /v1/mac-nodes', 'm2m — fleet registration, node-authenticated'],
  ['POST /v1/mac-nodes/:p/control', 'm2m — fleet control, node-authenticated'],
  [
    'POST /v1/sessions/:p/gui-input',
    'CUSTOMER — the only endpoint the gui_control scope reaches, and nothing restricts who may request that scope',
  ],
  ['POST /v1/webhooks/nowpayments', 'm2m — inbound provider webhook; NowPayments documents it'],
  ['POST /v1/webhooks/stripe', 'm2m — inbound provider webhook; Stripe documents it'],
]);

function registered(): Map<string, string> {
  const files = [
    ...readdirSync(resolve(SERVER, 'routes'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => resolve(SERVER, 'routes', f)),
    resolve(SERVER, 'lib', 'app.ts'),
  ];
  const out = new Map<string, string>();
  for (const file of files) {
    for (const m of codeLines(file).matchAll(
      /\bapp\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*[\r\n]?\s*'([^']+)'/g,
    )) {
      out.set(`${(m[1] ?? '').toUpperCase()} ${norm(m[2] ?? '')}`, file);
    }
  }
  return out;
}

/** `registerRoute(r, { method: 'post', path: '/v1/sessions', … })`. */
function inSpec(): Set<string> {
  const spec = readFileSync(resolve(SERVER, 'lib', 'openapi.ts'), 'utf8');
  const out = new Set<string>();
  for (const m of spec.matchAll(
    /method:\s*'(get|post|put|patch|delete)',\s*\n\s*path:\s*'([^']+)'/g,
  )) {
    out.add(`${(m[1] ?? '').toUpperCase()} ${norm(m[2] ?? '')}`);
  }
  return out;
}

/** The backticked `GET /v1/…` form the API pages use. */
function inDocs(): Set<string> {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, e.name);
      if (e.isDirectory()) walk(full, out);
      else out.push(full);
    }
    return out;
  };
  const src = walk(DOCS)
    .filter((f) => /\.(md|astro|mdx)$/.test(f))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  const out = new Set<string>();
  for (const m of src.matchAll(/`(GET|POST|PUT|PATCH|DELETE)\s+(\/v1\/[^`\s]*)`/g)) {
    out.add(`${m[1] ?? ''} ${norm(m[2] ?? '')}`);
  }
  return out;
}

const writtenDownNowhere = (): string[] => {
  const spec = inSpec();
  const docs = inDocs();
  return [...registered().keys()].filter((ep) => !spec.has(ep) && !docs.has(ep)).sort();
};

describe('a route in neither the spec nor the docs is a decision, not an oversight', () => {
  it('CRITICAL all three readers see something, and the spec reader in particular. This asserts a set equals a list, so a spec extractor that matched nothing would report every route as undocumented — and one that matched everything would report none. The first version of this scan found ZERO spec entries and duly reported 106 undocumented routes, a number that looked like a finding and was a bug.', () => {
    expect(registered().size, 'registered routes').toBeGreaterThan(240);
    expect(inSpec().size, 'endpoints declared in openapi.ts').toBeGreaterThan(200);
    expect(inDocs().size, 'endpoints named in a backticked doc line').toBeGreaterThan(140);
    expect(inSpec(), 'a known spec route is missing — the extractor is broken').toContain(
      'POST /v1/sessions',
    );
  });

  it('CRITICAL every route is in the spec, in the docs, or in this list with a reason. A new one is not necessarily wrong — probes and node-authenticated endpoints belong here — but it should be a sentence somebody wrote, not the default. If it is reachable with a customer key, say CUSTOMER, because that is the case where undocumented means unusable.', () => {
    const unrecorded = writtenDownNowhere().filter((ep) => !UNDOCUMENTED_ROUTES.has(ep));
    expect(unrecorded, 'route(s) written down nowhere and not recorded here:').toEqual([]);
  });

  it('CRITICAL every recorded entry is still an undocumented route. A stale entry means a route was published and this file still calls it undocumented — which is the good direction, and it should show up as a required edit rather than as a line nobody re-reads.', () => {
    const live = new Set(writtenDownNowhere());
    const stale = [...UNDOCUMENTED_ROUTES.keys()].filter((ep) => !live.has(ep)).sort();
    expect(stale, 'recorded route(s) that are now in the spec or the docs:').toEqual([]);
  });

  it('CRITICAL the customer-reachable set is still exactly these two. Fifteen infrastructure and machine-to-machine entries are the boring part of this roster; these two are the ones a paying customer can call and cannot look up. A third arriving is the signal, and it would otherwise be one more line among seventeen.', () => {
    const customerFacing = [...UNDOCUMENTED_ROUTES.entries()]
      .filter(([, why]) => why.startsWith('CUSTOMER'))
      .map(([ep]) => ep)
      .sort();
    expect(customerFacing, 'undocumented routes an ordinary customer key reaches:').toEqual([
      'GET /v1/agent-sessions/:p/gui-control-key',
      'POST /v1/sessions/:p/gui-input',
    ]);
  });

  it('CRITICAL gui_control still reaches exactly one endpoint, and it is the one recorded above. The roster entry claims that scope has a single undocumented endpoint; if a second appears, the entry stops being the whole truth and the customer-facing gap doubles without this file noticing.', () => {
    const gated: string[] = [];
    for (const f of readdirSync(resolve(SERVER, 'routes')).filter((x) => x.endsWith('.ts'))) {
      const src = codeLines(resolve(SERVER, 'routes', f));
      for (const m of src.matchAll(/requireScope\('gui_control'\)/g)) {
        const before = src.slice(0, m.index ?? 0);
        const routes = [
          ...before.matchAll(
            /\bapp\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*[\r\n]?\s*'([^']+)'/g,
          ),
        ];
        const last = routes[routes.length - 1];
        if (last) gated.push(`${(last[1] ?? '').toUpperCase()} ${norm(last[2] ?? '')}`);
      }
    }
    expect([...new Set(gated)].sort(), 'endpoints gated by the gui_control scope:').toEqual([
      'POST /v1/sessions/:p/gui-input',
    ]);
  });
});
