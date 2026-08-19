// V-1023 — every live /v1 route is authenticated, or is on a list somebody had to look at.
//
// V-1022 derived this for `/v1/admin`. This is the customer half, and it is the
// bigger surface: 246 live registrations, of which 212 carry one of the six auth
// mechanisms this codebase actually has and 34 are public on purpose.
//
// A route shipped without a gate does not fail anything today. It answers, and
// the account context it reads is whatever the caller supplied — which is the one
// class of defect where the absence of a test is the whole vulnerability.
//
// ── What it took to get a trustworthy number ────────────────────────────────
//
// Four scans, three wrong answers, and every wrong answer looked like a finding:
//
//   • Requiring the path on the same line as `app.get(` undercounts any route
//     that carries a type parameter. That is the `\s*`-before-the-quote lesson
//     the canonical matcher already encodes.
//   • Counting `preHandler` as authentication makes every rate-limited public
//     auth route look gated.
//   • Capturing trailing context per match advances the regex past registrations
//     inside that window, silently shrinking the population.
//   • Not excluding the `…DisabledRoutes` registrars reported 85 ungated routes,
//     including the BYOK key read/write/delete surface. Those registrars exist to
//     answer with a deployment-state signal when a feature is unconfigured, and
//     they re-register the same paths — so half the "ungated" set was a fallback
//     that returns FeatureUnavailableError to everyone.
//
// The mechanism list below is enumerated from `app.decorate` and from the
// preHandler helpers routes actually use, rather than guessed. That is why it
// includes `controlKeyOrAccountAuth` — the factory the fourteen session-scoped
// agent-sessions routes use, which no guessed regex had.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes');

/** Canonical registration matcher: optional type argument, whitespace before the quote. */
const REGISTRATION =
  /app\.(get|post|put|patch|delete)\s*(?:<[^(]*>)?\s*\(\s*['"`](\/v1\/[^'"`]*)['"`]/g;

/**
 * Every authentication mechanism in this server.
 *
 * `requireAuth` / `requireScope` / `requireAuthEventSource` are app decorators;
 * `requireOwner` gates the platform-owner surface; `requireInternalAuth` gates
 * the internal fleet endpoints; `controlKeyOrAccountAuth` is the per-session
 * factory used by the agent-session control routes. Rate-limit gates
 * (`app.rateLimit`, `loginGate`, `subscribeGate`, the `status*Gate`s) are
 * deliberately NOT here — throttling is not authentication, and treating it as
 * such is what made an earlier version of this scan report every public auth
 * route as protected.
 */
const AUTH_MECHANISM =
  /\brequireAuth\b|\brequireAuthEventSource\b|\brequireScope\b|\brequireOwner\b|\brequireInternalAuth\b|\bcontrolKeyOrAccountAuth\b/;

/**
 * Routes that answer without an authenticated caller, and why.
 *
 * "Public" here means the ROUTING layer applies no gate. Several of these
 * authenticate inside the handler instead, which is noted per group — that is a
 * real difference: the credential is checked, just not by a preHandler.
 */
const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  // The authentication gate itself. These ARE the login surface, so requiring a
  // session to reach them would be circular. `mfa/step-up` is deliberately NOT
  // here: it re-asserts MFA for a session that is already authenticated (V-1021).
  'POST /v1/auth/signup',
  'POST /v1/auth/verify-email',
  'POST /v1/auth/resend-verification',
  'POST /v1/auth/login',
  'POST /v1/auth/mfa/challenge',
  'POST /v1/auth/magic-link/request',
  'POST /v1/auth/magic-link/consume',
  'POST /v1/auth/password-reset/request',
  'POST /v1/auth/password-reset/confirm',
  'POST /v1/auth/refresh',
  'POST /v1/auth/logout',
  // Browser and CLI sign-in flows: the caller is proving identity, not using it.
  'POST /v1/auth/cli-authorize/initiate',
  'POST /v1/auth/cli-authorize/exchange',
  'POST /v1/auth/oauth-client/start',
  'GET /v1/auth/oauth-client/callback',
  'GET /v1/auth/oauth/${provider}/callback',
  'POST /v1/auth/oauth-client/confirm-merge',
  // RFC 6749 / 7662 endpoints. The CLIENT authenticates in the request body with
  // client_secret, which is checked in the handler rather than by a preHandler.
  'GET /v1/oauth/authorize',
  'POST /v1/oauth/token',
  'POST /v1/oauth/introspect',
  'POST /v1/oauth/revoke',
  // The public status site. No Driftstack account is involved.
  'GET /v1/status',
  'GET /v1/status/stream',
  'GET /v1/status/sla',
  'GET /v1/status/incidents',
  'GET /v1/status/incidents/:id',
  'POST /v1/status/subscribe',
  'GET /v1/status/subscribe/confirm',
  'GET /v1/status/subscribe/unsubscribe',
  // Provider callbacks. Authenticated by HMAC signature over the raw body, in
  // the handler — an unsigned request is rejected there, not at the gate.
  'POST /v1/webhooks/stripe',
  'POST /v1/webhooks/nowpayments',
  // Static catalogue; no account data.
  'GET /v1/archetypes',
  // Egress reachability probe: echoes what the server saw, reads nothing.
  'GET /v1/egress/echo',
  // Authenticated, but at the websocket HTTP-upgrade phase by an inline
  // preHandler calling authenticateFleetUpgrade — a bad token throws before the
  // socket opens. Listed rather than detected because the options slice below
  // stops at the first async arrow, which for this route IS the preHandler.
  'GET /v1/fleet/events',
]);

/**
 * Mutating routes whose only scope is read-only, with the reason.
 *
 * `POST` does not imply a write. The quote route computes a price preview from
 * the authoritative pricing table and its own header states the response is
 * stateless with no DB write — minting an order is a different endpoint. It is
 * POST because it takes a body, so requiring a write scope would hand every
 * price-checking integration the ability to open orders.
 */
const READ_SCOPED_MUTATIONS: ReadonlySet<string> = new Set([
  'POST /v1/billing/crypto-checkout/quote',
]);

const READ_ONLY = (scope: string): boolean => scope === 'read' || scope.startsWith('read:');

interface Registration {
  readonly key: string;
  readonly file: string;
  readonly gated: boolean;
  /** Scope literals the route's options require, in order. */
  readonly scopes: readonly string[];
}

/** Live registrations only — the `…DisabledRoutes` fallbacks re-register the same paths. */
function liveRegistrations(): Registration[] {
  const out: Registration[] = [];
  for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(resolve(ROUTES, file), 'utf8');
    const fns = [...src.matchAll(/^export function (\w+)/gm)].map(
      (m) => [m.index, m[1] as string] as const,
    );
    const owner = (pos: number): string => {
      let cur = '(top)';
      for (const [at, name] of fns) {
        if (at <= pos) cur = name;
        else break;
      }
      return cur;
    };
    const ms = [...src.matchAll(REGISTRATION)];
    for (const [i, m] of ms.entries()) {
      if (/Disabled/.test(owner(m.index))) continue;
      const start = m.index + m[0].length;
      const end = i + 1 < ms.length ? (ms[i + 1]?.index ?? src.length) : src.length;
      const segment = src.slice(start, end);
      // Options only: stop at the route handler so a mechanism named in a body
      // does not read as one applied to the route.
      const handlerAt = segment.search(/async\s*\(\s*(?:request|req|socket|_)/);
      const options = handlerAt > 0 ? segment.slice(0, handlerAt) : segment.slice(0, 500);
      out.push({
        key: `${(m[1] ?? '').toUpperCase()} ${m[2] ?? ''}`,
        file,
        gated: AUTH_MECHANISM.test(options),
        scopes: [...options.matchAll(/requireScope\(\s*'([^']+)'/g)].map((x) => x[1] as string),
      });
    }
  }
  return out;
}

describe('V-1023 every live /v1 route is gated or listed public', () => {
  const routes = liveRegistrations();

  it('CRITICAL the scan reaches the route surface and the detector discriminates. A matcher that found nothing, or one that treated any preHandler as authentication, would make the arm below pass for a server with an ungated customer route on it — and an earlier version of this scan did exactly that.', () => {
    expect(routes.length, 'live /v1 registrations').toBeGreaterThanOrEqual(240);
    expect(routes.filter((r) => r.gated).length, 'gated routes').toBeGreaterThanOrEqual(200);

    // Authentication counts; throttling does not.
    expect(AUTH_MECHANISM.test("{ preHandler: [app.requireAuth, app.rateLimit('global')] }")).toBe(
      true,
    );
    expect(AUTH_MECHANISM.test('{ preHandler: [controlKeyOrAccountAuth(deps)] }')).toBe(true);
    expect(AUTH_MECHANISM.test("{ preHandler: [app.rateLimit('global')] }")).toBe(false);
    expect(AUTH_MECHANISM.test('{ preHandler: [loginGate] }')).toBe(false);
  });

  it('CRITICAL no /v1 route answers without authentication unless it is on the public list. This is the one defect class where a missing test IS the vulnerability: an ungated route does not fail, it answers, and it reads whatever account context the caller supplied.', () => {
    const ungated = routes
      .filter((r) => !r.gated && !PUBLIC_ROUTES.has(r.key))
      .map((r) => `${r.key}  (${r.file})`)
      .sort();
    expect(
      ungated,
      'these routes carry no authentication mechanism and are not listed as deliberately public — ' +
        'add a gate, or add them to PUBLIC_ROUTES with the reason they answer anonymously:',
    ).toEqual([]);
  });

  it('CRITICAL the public list holds no stale entry. A route that was retired, or that has since been gated, would sit here reading as a considered decision while silently pre-approving whatever next lands on that path.', () => {
    const live = new Set(routes.map((r) => r.key));
    const gone = [...PUBLIC_ROUTES].filter((k) => !live.has(k)).sort();
    expect(gone, 'listed as public but no longer registered:').toEqual([]);

    const nowGated = routes
      .filter((r) => r.gated && PUBLIC_ROUTES.has(r.key))
      .map((r) => r.key)
      .sort();
    expect(
      nowGated,
      'these now carry an auth mechanism — good, but delete them from PUBLIC_ROUTES so the list ' +
        'keeps meaning "answers anonymously":',
    ).toEqual([]);
  });

  it("CRITICAL no mutating route is satisfied by a read-only scope alone. A POST, PUT, PATCH or DELETE that accepts `read` lets a key issued for reporting change state — the gate is present, so V-1023's other arms stay green, and only the STRENGTH of it is wrong. One route is listed, and it is a stateless price preview whose own header says it writes nothing.", () => {
    const weak = routes
      .filter(
        (r) =>
          /^(POST|PUT|PATCH|DELETE) /.test(r.key) &&
          r.scopes.length > 0 &&
          r.scopes.every(READ_ONLY) &&
          !READ_SCOPED_MUTATIONS.has(r.key),
      )
      .map((r) => `${r.key}  requires ${r.scopes.join(' + ')}  (${r.file})`)
      .sort();
    expect(
      weak,
      'these mutating routes accept a read-only scope — require a write/admin scope, or list them ' +
        'with the reason they change nothing:',
    ).toEqual([]);

    // The listed exception must still exist and still be read-scoped.
    const live = new Map(routes.map((r) => [r.key, r] as const));
    for (const key of READ_SCOPED_MUTATIONS) {
      const r = live.get(key);
      expect(
        r,
        `${key} is listed as a read-scoped mutation but is no longer registered`,
      ).toBeDefined();
      expect(
        r?.scopes.every(READ_ONLY),
        `${key} now requires a write scope — delete it from READ_SCOPED_MUTATIONS`,
      ).toBe(true);
    }
  });
});
