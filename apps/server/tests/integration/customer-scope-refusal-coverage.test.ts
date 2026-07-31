// Every customer-facing route that enforces a scope actually refuses a key
// lacking it — proved by CALLING each one.
//
// Companion to `admin-scope-refusal-coverage`, which covers the staff surface.
// Together they close the gap that measurement exposed: of 163 scope-enforcing
// routes, 13 had no refusal assertion anywhere in the suite, and the ones that
// did were concentrated on a handful of popular routes.
//
// The insufficient key is not hard-coded per route. It is CHOSEN by asking
// `scopesSatisfy` — the same predicate the middleware uses — for a candidate
// set that genuinely does not satisfy the requirement, and the choice is
// asserted before use. So if the scope hierarchy changes (a new broad verb, a
// new alias), this suite follows it instead of quietly testing the wrong thing.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { scopesSatisfy } from '../../src/lib/errors-helpers.js';
import { ApiKeyScopeSchema, type ApiKeyScope } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = resolve(HERE, '..', '..', 'src', 'routes');

const STAFF_SCOPE = 'driftstack_internal_admin';

interface ScopedRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  scope: ApiKeyScope;
  file: string;
}

function scopedRoutes(): ScopedRoute[] {
  const out: ScopedRoute[] = [];
  for (const file of readdirSync(ROUTES_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const src = readFileSync(resolve(ROUTES_DIR, file), 'utf8');
    const regs = [
      ...src.matchAll(/\bapp\.(get|post|put|patch|delete)\b[^(]*\(\s*['"`](\/v1\/[^'"`]+)['"`]/g),
    ];
    regs.forEach((m, i) => {
      const start = m.index + m[0].length;
      const end = i + 1 < regs.length ? regs[i + 1]!.index : Math.min(src.length, start + 2500);
      const raw = /requireScope\(\s*'([^']+)'/.exec(src.slice(start, end))?.[1];
      if (raw === undefined || raw === STAFF_SCOPE) return; // staff has its own suite
      // Parsed, not cast: a scope string in route source that is not a real
      // ApiKeyScope is itself a defect, and would otherwise be tested as if it
      // were valid.
      const scope = ApiKeyScopeSchema.parse(raw);
      out.push({
        method: m[1]!.toUpperCase() as ScopedRoute['method'],
        path: m[2]!,
        scope,
        file,
      });
    });
  }
  return out.sort((a, b) => `${a.path}${a.method}`.localeCompare(`${b.path}${b.method}`));
}

/**
 * A key that genuinely does NOT satisfy `required`, chosen via the real
 * predicate rather than assumed. Returns null when no candidate works, which
 * the caller turns into a loud failure instead of a silent skip.
 */
function insufficientScopesFor(required: ApiKeyScope): ApiKeyScope[] | null {
  const candidates: ApiKeyScope[][] = [
    ['read'] as ApiKeyScope[],
    ['write'] as ApiKeyScope[],
    ['read', 'write'] as ApiKeyScope[],
  ];
  return candidates.find((c) => !scopesSatisfy(c, required)) ?? null;
}

/**
 * Every optional subsystem the fixture can wire, ON.
 *
 * Not incidental. Routes whose feature is inactive answer 503 FeatureUnavailable
 * (or 404 when unregistered) BEFORE the scope gate, so a fixture with the
 * defaults silently tests nothing for them — 16 of these cases were passing
 * through an activation stub rather than a scope check until each subsystem was
 * switched on. Anything still unreachable is listed in NOT_ACTIVATABLE with its
 * reason rather than quietly asserting the wrong status.
 */
const ALL_SUBSYSTEMS_ON = {
  withOauthStore: true,
  enableAgentRuntime: true,
  enableByokAnthropic: true,
  livekit: {
    apiKey: 'scope-refusal-test-key',
    apiSecret: 'scope-refusal-test-secret',
    wsUrl: 'wss://livekit.driftstack.test',
  },
  oauthClient: {
    signingSecret: 'a'.repeat(32),
    callbackUrlBase: 'https://api.driftstack.test/v1/auth/oauth',
    dashboardOrigin: 'https://app.driftstack.test',
    google: { clientId: 'google-test-id', clientSecret: 'google-test-secret' },
    github: { clientId: 'github-test-id', clientSecret: 'github-test-secret' },
  },
} as const;

/** Params are irrelevant — the scope gate is a preHandler and runs first. */
function concreteUrl(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '00000000-0000-4000-8000-000000000000');
}

/**
 * Routes no in-memory fixture can activate, with the exact gating dependency.
 * The suite asserts each is still absent, so an exemption cannot become stale
 * cover for a regression.
 */
const NOT_ACTIVATABLE: Record<string, string> = {
  'POST /v1/agent-sessions/:id/livekit-token':
    'needs a real drizzleFleetNodesRepo (LK.3 gate), which in-memory fixtures skip',
};

/**
 * The customer scope surface, pinned — the load-bearing part of this file.
 *
 * Every case is generated from route source, so DELETING a `requireScope`
 * removes that route from its own table and the suite passes with one fewer
 * test. A scan cannot grade itself; this comparison is what sees a deletion.
 * A diff means a gate was dropped, or a route was added and needs a line here.
 */
const EXPECTED_SCOPED_ROUTES: readonly string[] = [
  'GET /v1/account/cost [read:billing]',
  'PATCH /v1/account/me [account_owner]',
  'GET /v1/account/me [read]',
  'DELETE /v1/account/me/avatar [account_owner]',
  'POST /v1/account/me/avatar [account_owner]',
  'GET /v1/account/me/billing-portal [admin:billing]',
  'PATCH /v1/account/me/bundled-llm-settings [account_owner]',
  'GET /v1/account/me/bundled-llm-settings [read]',
  'GET /v1/account/me/bundled-llm-status [read]',
  'DELETE /v1/account/me/byok-anthropic-key [account_owner]',
  'PUT /v1/account/me/byok-anthropic-key [account_owner]',
  'GET /v1/account/me/byok-anthropic-key [read]',
  'POST /v1/account/me/byok-anthropic-key/test [account_owner]',
  'GET /v1/account/me/oauth-links [read]',
  'GET /v1/account/me/organization [read:profiles]',
  'PUT /v1/account/me/organization [write:profiles]',
  'GET /v1/account/me/proxies [account_owner]',
  'POST /v1/account/me/proxies [account_owner]',
  'DELETE /v1/account/me/proxies/:id [account_owner]',
  'PUT /v1/account/me/proxies/:id [account_owner]',
  'POST /v1/account/me/proxies/:id/test [account_owner]',
  'DELETE /v1/account/mfa [account_owner]',
  'GET /v1/account/mfa [read]',
  'POST /v1/account/mfa/disable [account_owner]',
  'POST /v1/account/mfa/enroll [account_owner]',
  'POST /v1/account/mfa/recovery-codes/regenerate [account_owner]',
  'POST /v1/account/mfa/verify [account_owner]',
  'GET /v1/account/rate-limits [read]',
  'DELETE /v1/account/web-sessions [account_owner]',
  'GET /v1/account/web-sessions [read]',
  'DELETE /v1/account/web-sessions/:id [account_owner]',
  'GET /v1/agent-sessions [read:sessions]',
  'POST /v1/agent-sessions [write]',
  'GET /v1/agent-sessions/:id/downloads/content [read:sessions]',
  'GET /v1/agent-sessions/:id/gui-control-key [write]',
  'POST /v1/agent-sessions/:id/livekit-token [write]',
  'GET /v1/agent-sessions/:id/recipe-suggestion [read]',
  'POST /v1/agent-sessions/:id/resume [write]',
  'GET /v1/billing [read:billing]',
  'POST /v1/billing/checkout-session [admin:billing]',
  'POST /v1/billing/crypto-checkout [admin:billing]',
  'POST /v1/billing/crypto-checkout/quote [read:billing]',
  'GET /v1/billing/crypto-orders [read:billing]',
  'PATCH /v1/billing/crypto-orders/:order_id [admin:billing]',
  'GET /v1/billing/crypto-orders/:order_id [read:billing]',
  'POST /v1/billing/crypto-orders/:order_id/cancel [admin:billing]',
  'GET /v1/billing/crypto-orders/:order_id/receipt [read:billing]',
  'GET /v1/billing/crypto-orders/:order_id/receipt.pdf [read:billing]',
  'GET /v1/billing/crypto-orders/:order_id/receipt.txt [read:billing]',
  'POST /v1/billing/portal-session [admin:billing]',
  'POST /v1/legal/accept [account_owner]',
  'GET /v1/profile-snapshots [read:profiles]',
  'GET /v1/profile-snapshots/:id [read:profiles]',
  'DELETE /v1/profile-snapshots/:id [write:profiles]',
  'POST /v1/profile-snapshots/:id/restore [write:profiles]',
  'GET /v1/profiles [read:profiles]',
  'POST /v1/profiles [write:profiles]',
  'GET /v1/profiles/:id [read:profiles]',
  'DELETE /v1/profiles/:id [write:profiles]',
  'PATCH /v1/profiles/:id [write:profiles]',
  'POST /v1/profiles/:id/clone [write:profiles]',
  'GET /v1/profiles/:id/export [read:profiles]',
  'POST /v1/profiles/:id/launch [write:sessions]',
  'DELETE /v1/profiles/:id/purge [write:profiles]',
  'POST /v1/profiles/:id/restore [write:profiles]',
  'GET /v1/profiles/:id/snapshots [read:profiles]',
  'POST /v1/profiles/:id/snapshots [write:profiles]',
  'POST /v1/profiles/:id/transfer [write:profiles]',
  'POST /v1/profiles/:id/trim [write:profiles]',
  'POST /v1/profiles/import [write:profiles]',
  'GET /v1/profiles/trash [read:profiles]',
  'GET /v1/recipes [read]',
  'POST /v1/recipes [write]',
  'GET /v1/recipes/:id [read]',
  'DELETE /v1/recipes/:id [write]',
  'GET /v1/sessions [read:sessions]',
  'POST /v1/sessions [write:sessions]',
  'GET /v1/sessions/:id [read:sessions]',
  'DELETE /v1/sessions/:id [write:sessions]',
  'POST /v1/sessions/:id/capture [write:sessions]',
  'POST /v1/sessions/:id/extract [write:sessions]',
  'POST /v1/sessions/:id/gui-input [gui_control]',
  'POST /v1/sessions/:id/interact [write:sessions]',
  'POST /v1/sessions/:id/login [write:sessions]',
  'POST /v1/sessions/:id/navigate [write:sessions]',
  'GET /v1/sessions/:id/proxy [read:sessions]',
  'POST /v1/sessions/:id/proxy [write:sessions]',
  'POST /v1/sessions/:id/search [write:sessions]',
  'GET /v1/sessions/:id/state [read:sessions]',
  'POST /v1/sessions/:id/wait [write:sessions]',
  'POST /v1/team/invites [account_owner]',
  'GET /v1/team/invites [read]',
  'POST /v1/team/invites/accept [account_owner]',
  'GET /v1/team/members [read]',
  'DELETE /v1/team/members/:id [account_owner]',
  'GET /v1/team/owners [read]',
  'GET /v1/usage [read]',
  'GET /v1/usage/series [read]',
];

let fx: TestAppFixture | null = null;

afterEach(async () => {
  if (fx) await fx.cleanup();
  fx = null;
});

describe('customer routes refuse a key that lacks their scope', () => {
  const routes = scopedRoutes();

  it('the scan found the customer scope surface (a broken scan would make every case below vacuous)', () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  it('CRITICAL an insufficient key exists for every enforced scope, chosen via the real scopesSatisfy predicate. If a scope became satisfiable by every candidate, these cases would silently start asserting nothing.', () => {
    const unrepresentable = [...new Set(routes.map((r) => r.scope))]
      .filter((s) => insufficientScopesFor(s) === null)
      .sort();
    expect(unrepresentable, 'scope(s) with no insufficient-key candidate:').toEqual([]);
  });

  it('CRITICAL the set of scope-gated customer routes matches the pinned roster EXACTLY. Cases below are generated from route source, so deleting a gate would drop the route from its own table and the suite would pass with one fewer test. This comparison is the only thing that can see that.', () => {
    const found = routes.map((r) => `${r.method} ${r.path} [${r.scope}]`).sort();
    const expected = [...EXPECTED_SCOPED_ROUTES].sort();
    expect(
      expected.filter((r) => !found.includes(r)),
      'Route(s) that no longer enforce their scope, or whose scope changed:',
    ).toEqual([]);
    expect(
      found.filter((r) => !expected.includes(r)),
      'New scope-gated route(s) — add to EXPECTED_SCOPED_ROUTES; refusal coverage then applies automatically:',
    ).toEqual([]);
  });

  const exercised = routes.filter((r) => NOT_ACTIVATABLE[`${r.method} ${r.path}`] === undefined);
  const exempt = routes.filter((r) => NOT_ACTIVATABLE[`${r.method} ${r.path}`] !== undefined);

  it.each(exempt.map((r) => [`${r.method} ${r.path}`, r] as const))(
    '%s is genuinely unregistrable in-memory, so its exemption is still accurate',
    async (label, route) => {
      fx = await buildTestApp({ scopes: ['read'], ...ALL_SUBSYSTEMS_ON });
      const res = await fx.app.inject({
        method: route.method,
        url: concreteUrl(route.path),
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: {},
      });
      expect(
        res.statusCode,
        `${label} now responds ${res.statusCode} — drop its NOT_ACTIVATABLE entry so the refusal case covers it`,
      ).toBe(404);
    },
  );

  it.each(exercised.map((r) => [`${r.method} ${r.path} [${r.scope}]`, r] as const))(
    'CRITICAL %s refuses a key without its scope',
    async (_label, route) => {
      const scopes = insufficientScopesFor(route.scope);
      expect(scopes, `no insufficient-scope key for ${route.scope}`).not.toBeNull();
      if (scopes === null) return;
      // Guard against the assertion becoming vacuous: prove the chosen key
      // really does not satisfy the requirement before relying on it.
      expect(scopesSatisfy(scopes, route.scope)).toBe(false);

      fx = await buildTestApp({ scopes, ...ALL_SUBSYSTEMS_ON });
      const res = await fx.app.inject({
        method: route.method,
        url: concreteUrl(route.path),
        headers: { authorization: `Bearer ${fx.plaintext}` },
        ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { payload: {} }),
      });

      expect(
        res.statusCode,
        `${route.method} ${route.path} (${route.file}) requires '${route.scope}' but returned ${res.statusCode} for a [${scopes.join(', ')}] key`,
      ).toBe(403);
    },
  );
});
