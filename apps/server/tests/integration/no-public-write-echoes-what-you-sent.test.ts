// Every unauthenticated write endpoint, swept for an echo of the caller's input.
//
// Last fire proved one route: `POST /v1/oauth/token` puts Zod's serialized issue list
// into `detail`, and `invalid_literal` / `invalid_enum_value` carry the submitted value
// verbatim. That guard covered one endpoint out of a surface nobody had enumerated.
//
// ── the surface, derived ──────────────────────────────────────────────────────
//
// Non-templated `/v1/**` POST/PUT/PATCH routes that do NOT answer 401 to an anonymous
// caller. `templated-routes-refuse-anonymous-callers` already proves the `{id}` half
// refuses everyone, so what remains is the flat public write surface: sixteen routes,
// almost all of them carrying a credential in the body — a password, a reset token, a
// refresh token, an MFA code, a client secret.
//
// ── measured, all sixteen, before a single assertion was written ──────────────
//
// Each route was sent a payload whose every value was a distinct marker, then the
// response body searched for those markers:
//
//   15 of 16   echo NOTHING. login, signup, verify-email, resend-verification,
//              refresh, logout, mfa/challenge, magic-link request + consume,
//              password-reset request + confirm, cli-authorize initiate + exchange,
//              oauth/introspect, status/subscribe.
//   1 of 16    `POST /v1/oauth/revoke` echoes `token_type_hint`, because it is the one
//              z.enum on the public surface and Zod's invalid_enum_value carries
//              `received`. Its domain is `access_token | refresh_token` — not a
//              credential.
//
// So there is no live leak, and this file does not claim one. What it is: the property
// was true by accident of which fields happen to be plain strings, and nothing was
// checking it across the surface where it matters most. One field changed to an enum or
// a literal is all it takes — which is precisely what the revoke route demonstrates,
// on the one field where it does not matter.
//
// The revoke echo is therefore the sweep's POSITIVE CONTROL as well as its exception.
// It proves the detection works end to end: a marker in the payload really is found in
// the body when the mechanism fires. Without it, sixteen "no echo" assertions could all
// be passing because the markers never reached a validator.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './_helpers/build-test-app.js';
import { registeredOps } from './_helpers/registered-ops.js';

let fx: Awaited<ReturnType<typeof buildTestApp>>;

/** Short, distinctive, and impossible to occur naturally in a problem body. */
const M = 'zqmarker';

interface PublicWrite {
  url: string;
  method: 'POST' | 'PUT' | 'PATCH';
  /** Every value is a marker, so an echo of ANY submitted field is visible. */
  payload: Record<string, unknown>;
  /**
   * Field names whose value this route is KNOWN to echo, with the reason. Empty for
   * every route but one — and an entry here is a claim that the field is not a
   * credential, which is the only thing that makes an echo acceptable.
   */
  echoes?: readonly string[];
}

const PUBLIC_WRITES: readonly PublicWrite[] = [
  { url: '/v1/auth/login', method: 'POST', payload: { email: `${M}1@x`, password: `${M}2` } },
  { url: '/v1/auth/signup', method: 'POST', payload: { email: `${M}3@x`, password: `${M}4` } },
  { url: '/v1/auth/verify-email', method: 'POST', payload: { token: `${M}5` } },
  { url: '/v1/auth/resend-verification', method: 'POST', payload: { email: `${M}6@x` } },
  { url: '/v1/auth/refresh', method: 'POST', payload: { refresh_token: `${M}7` } },
  { url: '/v1/auth/logout', method: 'POST', payload: { refresh_token: `${M}8` } },
  {
    url: '/v1/auth/mfa/challenge',
    method: 'POST',
    payload: { challenge_token: `${M}9`, code: `${M}10` },
  },
  { url: '/v1/auth/magic-link/request', method: 'POST', payload: { email: `${M}11@x` } },
  { url: '/v1/auth/magic-link/consume', method: 'POST', payload: { token: `${M}12` } },
  { url: '/v1/auth/password-reset/request', method: 'POST', payload: { email: `${M}13@x` } },
  {
    url: '/v1/auth/password-reset/confirm',
    method: 'POST',
    payload: { token: `${M}14`, password: `${M}15` },
  },
  { url: '/v1/auth/cli-authorize/initiate', method: 'POST', payload: { device_name: `${M}16` } },
  { url: '/v1/auth/cli-authorize/exchange', method: 'POST', payload: { device_code: `${M}17` } },
  {
    url: '/v1/oauth/introspect',
    method: 'POST',
    payload: { token: `${M}18`, client_id: `${M}19`, client_secret: `${M}20` },
  },
  {
    url: '/v1/oauth/revoke',
    method: 'POST',
    payload: {
      token: `${M}21`,
      client_id: `${M}22`,
      client_secret: `${M}23`,
      token_type_hint: `${M}24`,
    },
    // The one z.enum on the public write surface. Zod's invalid_enum_value carries
    // `received`, so the value comes back — and its domain is
    // `access_token | refresh_token`, which is a hint about which table to look in,
    // not a secret. Named rather than filtered so "we accept this echo" is a
    // statement someone can disagree with.
    echoes: ['token_type_hint'],
  },
  { url: '/v1/status/subscribe', method: 'POST', payload: { email: `${M}25` } },
  // /v1/oauth/token is covered by a-public-4xx-must-not-echo-a-credential-value, which
  // drives its three credential fields individually and pins the grant_type echo. It is
  // exempted below rather than duplicated here.
];

/**
 * Public writes deliberately outside this sweep.
 *
 * The capability-gated ones answer 503 from a feature check that runs BEFORE any body
 * parsing, so they cannot echo a field they never read — and that is asserted, not
 * assumed, because a route that started parsing would silently leave the sweep.
 */
const EXEMPT = new Map<string, string>([
  [
    'POST /v1/oauth/token',
    'covered field-by-field in a-public-4xx-must-not-echo-a-credential-value, including the grant_type echo',
  ],
  ['PUT /v1/account/me/byok-anthropic-key', 'capability-gated 503 before body parsing'],
  ['POST /v1/account/me/byok-anthropic-key/test', 'capability-gated 503 before body parsing'],
  ['POST /v1/agent-sessions', 'capability-gated 503 before body parsing'],
  ['POST /v1/recipes', 'capability-gated 503 before body parsing'],
  ['POST /v1/internal/atlas-priority/probe-signature', 'capability-gated 503 before body parsing'],
  ['POST /v1/internal/atlas-priority/event-status', 'capability-gated 503 before body parsing'],
]);

interface Probe {
  op: string;
  status: number;
  echoed: string[];
}

const probes: Probe[] = [];

beforeAll(async () => {
  fx = await buildTestApp({ withOauthStore: true });
  for (const w of PUBLIC_WRITES) {
    const res = await fx.app.inject({ method: w.method, url: w.url, payload: w.payload });
    probes.push({
      op: `${w.method} ${w.url}`,
      status: res.statusCode,
      echoed: Object.entries(w.payload)
        .filter(([, v]) => typeof v === 'string' && res.body.includes(v))
        .map(([k]) => k),
    });
  }
}, 120_000);

afterAll(async () => {
  await fx.app.close();
});

describe('no public write echoes what you sent', () => {
  it('CRITICAL the sweep really ran, with credentials in every payload. Every assertion below reports an ABSENCE, so a sweep whose requests never reached a validator would satisfy all of them having proved nothing — which is the failure mode that makes an all-clear on a security property worthless.', () => {
    expect(probes.length, 'public write routes probed').toBe(PUBLIC_WRITES.length);
    expect(probes.length, 'the table shrank below the measured surface').toBeGreaterThanOrEqual(16);
    // A wall of 401/503 would mean nothing was parsed. Measured: 15 of 16 answer 400.
    expect(
      probes.filter((p) => p.status === 400).length,
      'routes that reached body validation — a sweep of 401s or 503s parses nothing',
    ).toBeGreaterThanOrEqual(14);
  });

  it('CRITICAL the detection works: the ONE route known to echo really does. This is the positive control. Sixteen no-echo assertions could all pass because the markers never got near a validator; the revoke route firing proves a marker in the payload is genuinely found in the body when the mechanism is active.', () => {
    const revoke = probes.find((p) => p.op === 'POST /v1/oauth/revoke');
    expect(revoke, 'the revoke probe is missing').toBeDefined();
    expect(
      revoke?.echoed,
      'the revoke route stopped echoing token_type_hint — the detection is no longer demonstrated, so every no-echo arm here may be vacuous',
    ).toEqual(['token_type_hint']);
  });

  it('CRITICAL no public write echoes a field it is not named for. A password, a reset token, a refresh token, an MFA code or a client secret coming back in an unauthenticated 400 is the leak error-handler-4xx-does-not-echo-submitted-values states the doctrine for — and that file builds its own tiny Fastify app, so it never touched these routes.', () => {
    const unexpected: string[] = [];
    for (const w of PUBLIC_WRITES) {
      const p = probes.find((x) => x.op === `${w.method} ${w.url}`);
      const allowed = new Set(w.echoes ?? []);
      for (const field of p?.echoed ?? []) {
        if (!allowed.has(field)) unexpected.push(`${w.method} ${w.url} echoed ${field}`);
      }
    }
    expect(unexpected, 'public write(s) echoing an un-named submitted field:').toEqual([]);
  });

  it('CRITICAL no public write answers 5xx to a malformed body. A 500 on the unauthenticated surface is both an availability problem and an information one: it means input the route was not written for reached something that threw rather than something that refused.', () => {
    expect(
      probes.filter((p) => p.status >= 500).map((p) => `${p.op} -> ${String(p.status)}`),
      'public write(s) answering 5xx to a marker payload:',
    ).toEqual([]);
  });

  it('CRITICAL a new unauthenticated write must join the table or be exempted. The surface was never enumerated before this file, which is how one endpoint ended up guarded and fifteen did not — and a route added tomorrow fails nothing on its own.', async () => {
    const flat = [...registeredOps(fx.app.printRoutes({ commonPrefix: false }))].filter(
      (op) => /^(POST|PUT|PATCH) \/v1\//.test(op) && !op.includes(':'),
    );
    expect(flat.length, 'the route census parsed as empty').toBeGreaterThanOrEqual(20);

    const open: string[] = [];
    for (const op of flat) {
      const [method, url] = op.split(' ');
      const res = await fx.app.inject({
        method: method as 'POST',
        url: url as string,
        payload: {},
      });
      if (res.statusCode !== 401) open.push(op);
    }
    expect(
      open.length,
      'no unauthenticated writes found — every route 401d, so this arm would pass on an empty set',
    ).toBeGreaterThanOrEqual(16);

    const covered = new Set(PUBLIC_WRITES.map((w) => `${w.method} ${w.url}`));
    const missing = open.filter((op) => !covered.has(op) && !EXEMPT.has(op));
    expect(
      missing,
      `unauthenticated write(s) with no echo probe and no exemption:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  }, 120_000);

  it('the exemption list cannot rot — every route it names must still be registered, and the capability-gated ones must still answer before parsing. An exemption for a route that started reading bodies is a hole shaped exactly like the one this file closes.', async () => {
    const registered = registeredOps(fx.app.printRoutes({ commonPrefix: false }));
    const gone = [...EXEMPT.keys()].filter((op) => !registered.has(op));
    expect(gone, `exempted but no longer registered:\n  ${gone.join('\n  ')}`).toEqual([]);

    for (const [op, reason] of EXEMPT) {
      if (!reason.includes('503')) continue;
      const [method, url] = op.split(' ');
      const res = await fx.app.inject({
        method: method as 'POST',
        url: url as string,
        payload: { probe: `${M}exempt` },
      });
      expect(res.statusCode, `${op} is exempted as a pre-parse 503 but answered differently`).toBe(
        503,
      );
      expect(
        res.body,
        `${op} echoed a submitted value despite its pre-parse exemption`,
      ).not.toContain(`${M}exempt`);
    }
  }, 120_000);
});
