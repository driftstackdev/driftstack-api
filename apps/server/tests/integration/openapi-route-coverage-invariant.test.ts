// Every registered route is in the OpenAPI spec, or is exempt with a reason.
//
// `openapi.test.ts` pins the spec's path list by exact equality, which catches
// a path being added to or removed from the SPEC. It cannot catch the opposite
// and more likely mistake: registering a route in `routes/*.ts` and never
// touching `lib/openapi.ts`. The spec is unchanged, the pinned roster is
// unchanged, and the whole suite stays green — while the SDK generator, which
// reads the spec, never learns the endpoint exists. The customer-visible result
// is an endpoint the API serves and no SDK can call.
//
// This is not speculative. Three tests in `openapi.test.ts` exist because of
// exactly this drift, each closing one endpoint after the fact: "GET
// /v1/agent-sessions (list) is documented alongside POST (the GET method was
// missing once)", the same for `/v1/admin/incidents`, and "admin create/append
// endpoints document 201 ... the spec said 200 once". Each was found by someone
// noticing. This makes the general case fail instead.
//
// Measured when written: 210 registered paths, 194 in the spec, and every one
// of the 16 differences is deliberate — listed below with its reason. Zero spec
// paths lack a route, so no SDK method points at a 404 today.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { generateOpenApiSpec, _clearSpecCache } from '../../src/lib/openapi.js';

const SERVER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/**
 * Routes deliberately absent from the public spec, each with the reason. An
 * entry is a claim that no customer should be able to call this through an
 * SDK — not a place to park an endpoint someone forgot to document.
 */
const NOT_PUBLIC_API: Record<string, string> = {
  '/v1/internal/atlas-priority/event-status': 'Internal control-plane surface; not customer API.',
  '/v1/internal/atlas-priority/event/{id}': 'Internal control-plane surface; not customer API.',
  '/v1/internal/atlas-priority/probe-signature':
    'Internal control-plane surface; not customer API.',
  '/v1/internal/atlas-priority/queue': 'Internal control-plane surface; not customer API.',
  '/v1/mac-nodes': 'Fleet-node registration; the harness is the only caller.',
  '/v1/mac-nodes/{id}/control': 'Fleet-node control; the harness is the only caller.',
  '/v1/webhooks/stripe': 'Provider ingress. Stripe calls it, signature-verified; no SDK method.',
  '/v1/webhooks/nowpayments': 'Provider ingress. NowPayments IPN; no SDK method.',
  '/v1/auth/oauth/${provider}/callback':
    'Template-literal registration; the identity provider redirects a BROWSER here.',
  '/v1/auth/oauth-client/callback': 'Browser redirect target in the OAuth client flow, not an API.',
  '/v1/oauth/authorize/complete': 'Browser consent-form POST, not an API call.',
  '/v1/status/stream': 'Unauthenticated SSE stream; a long-lived event stream, not a JSON method.',
  '/v1/sessions/{id}/gui-input': 'Desktop-client input transport, authorized by GUI control key.',
  '/v1/agent-sessions/{id}/gui-control-key': 'Mints the desktop control key; desktop-only surface.',
  '/v1/agent-sessions/{id}/transport-report': 'Desktop client telemetry; desktop-only surface.',
  '/v1/whoami':
    'Answers "which key am I holding and what can it do" for interactive/CLI debugging. ' +
    'Documented on the docs site; deliberately not an SDK method.',
};

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Fastify writes `:id`; OpenAPI writes `{id}`. Compare in OpenAPI's spelling. */
function toSpecPath(p: string): string {
  return p.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}').replace(/\/$/, '');
}

/**
 * Every `/v1/*` path registered anywhere under `src`, not just `src/routes`.
 * `/v1/whoami` is registered in `lib/app.ts`, so a scan limited to the routes
 * directory would silently exempt it — the same blind spot that would let any
 * route registered outside that directory skip this check entirely.
 */
function registeredPaths(): string[] {
  const found = new Set<string>();
  for (const file of tsFilesUnder(SERVER_SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(
      /\bapp\.(get|post|put|patch|delete)\b[^(]*\(\s*['"`](\/v1\/[^'"`]+)['"`]/g,
    )) {
      found.add(toSpecPath(m[2]!));
    }
  }
  return [...found].sort();
}

describe('every registered route is in the OpenAPI spec or exempt with a reason', () => {
  _clearSpecCache();
  const spec = generateOpenApiSpec();
  const specPaths = new Set(Object.keys(spec.paths ?? {}));
  const registered = registeredPaths();

  it('CRITICAL the scan found the route surface and the spec. Either coming back empty would make every check below vacuously true.', () => {
    expect(registered.length, 'registered /v1 paths').toBeGreaterThan(150);
    expect(specPaths.size, 'paths in the generated spec').toBeGreaterThan(150);
    expect(registered, 'a known route must survive the scan').toContain('/v1/sessions');
    expect([...specPaths], 'a known documented path must be in the spec').toContain('/v1/sessions');
  });

  it('CRITICAL no registered route is missing from the spec without a stated reason. The SDK generator reads the spec, so an undocumented route is an endpoint the API serves that no SDK can call — the drift that already cost three endpoints, each found only when someone noticed.', () => {
    const undocumented = registered.filter(
      (p) => !specPaths.has(p) && NOT_PUBLIC_API[p] === undefined,
    );
    expect(
      undocumented.sort(),
      'route(s) registered but absent from the OpenAPI spec — document them in lib/openapi.ts, or add them to NOT_PUBLIC_API with a reason:',
    ).toEqual([]);
  });

  it('CRITICAL no spec path lacks a route. A documented endpoint nothing registers means every SDK generated from this spec ships a method that 404s.', () => {
    const reg = new Set(registered);
    const phantom = [...specPaths].filter(
      (p) => p.startsWith('/v1/') && !reg.has(p) && !p.includes('${'),
    );
    expect(phantom.sort(), 'spec path(s) with no registered route:').toEqual([]);
  });

  it('CRITICAL the exemption list may only SHRINK — a route that becomes documented must leave it, and an entry naming a route that no longer exists must go too. An allowlist that only grows is a mute button with extra steps.', () => {
    const nowDocumented = Object.keys(NOT_PUBLIC_API)
      .filter((p) => specPaths.has(p))
      .sort();
    expect(
      nowDocumented,
      'these are in the spec now — remove them from NOT_PUBLIC_API so they stay checked:',
    ).toEqual([]);

    const reg = new Set(registered);
    const stale = Object.keys(NOT_PUBLIC_API)
      .filter((p) => !reg.has(p))
      .sort();
    expect(stale, 'exemption(s) for routes that are no longer registered:').toEqual([]);
  });
});
