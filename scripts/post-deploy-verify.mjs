#!/usr/bin/env node
// Post-deploy sanity check. Hits a series of public endpoints on the
// target and asserts they return the expected status code + a few
// invariants on the response body. Runs orthogonally to the bare
// /health curl deploy-bridge.sh already does — that proves "boot
// succeeded", this proves "boot wired the expected routes + the
// new SHA + the env flags an operator cares about."
//
// Usage:
//   node scripts/post-deploy-verify.mjs --base-url https://staging.driftstack.dev
//   node scripts/post-deploy-verify.mjs --base-url https://api.driftstack.dev --expected-sha 5822e21
//
// Non-zero exit on any check failure so the CI / deploy-bridge can
// gate prod rollout on staging verification.

import process from 'node:process';

const args = parseArgs(process.argv.slice(2));
const baseUrl = (args['base-url'] ?? '').replace(/\/+$/, '');
if (!baseUrl) {
  console.error('error: --base-url <origin> is required');
  process.exit(2);
}
const expectedSha = args['expected-sha'] ?? null;
const jsonOut = args.json === 'true';

// Module-load-time constant. Referenced inside the activation-gate
// check helpers below. Must be declared BEFORE the top-level `for
// (const fn of checks)` loop fires those helpers — otherwise the
// temporal dead zone triggers `ReferenceError: Cannot access
// FEATURE_UNAVAILABLE_TYPE before initialization` and the entire
// post-deploy-verify aborts misleadingly (auto-revert then fires on
// what was actually a successful deploy). 2026-05-19 incident:
// `bash scripts/deploy-bridge.sh staging` for the scheduled-jobs fix
// (1b2001c8) tripped this twice before being root-caused.
const FEATURE_UNAVAILABLE_TYPE = 'https://errors.driftstack.dev/feature-unavailable';

// Each check returns { ok, name, detail }; the verifier collects all
// results and exits non-zero only at the end so a single failure
// doesn't mask a second one.
const checks = [
  checkHealth,
  checkVersionShape,
  expectedSha ? checkVersionMatchesSha : null,
  checkStatusEndpoint,
  checkStatusIncidentsList,
  checkStatusIncidentDetailRoute,
  checkAccountOauthLinksRoute,
  checkAdminCostConfigRoute,
  checkOpenapi,
  checkUnknownPath404,
  // Activation-gate posture invariants (Wave 1119+).
  // Each gated route registers a 503 FeatureUnavailable stub when
  // its AppDeps service is omitted from bootstrap. Without these
  // checks, a regression that forgets the `else` branch in app.ts
  // would leave the routes unregistered (404) and no existing
  // smoke would catch it.
  //
  // Removed 2026-05-19 because the corresponding features are now
  // activated on prod+staging — keeping the assertion would FAIL on
  // every deploy with a misleading "expected 503; got 401" signal
  // even though the routes are correctly wired. Per the script's own
  // comment block: "intentional signal to the operator that the
  // activation commit must also remove this assertion." That
  // remove-on-activation discipline got skipped at the time the gates
  // flipped, so this commit cleans them up retroactively:
  //   - checkEgressSessionProxyGateStub: EG-API-1.6+ wired (commit
  //     b165c8dd activation-gate sweep)
  //   - checkEgressSavedProxiesGateStub: same EG-API arc
  //   - checkAgentSessionsGateStub: AI-A.c agent_sessions repo wired
  //     (6f2cdcb8); Q.1 route activation 1fc40421
  //   - checkRecipesGateStub: AI-B4 recipesRepo wired (b165c8dd)
  //
  // Remaining gate checks stay because their underlying features are
  // still legitimately gated:
  //   - checkFleetEventsGateStub: WebSocket handler still not
  //     implemented (V-820 follow-up slice pending)
  //   - checkBillingGateStub: Stripe LIVE awaits BV-KvK closure
  //     2026-05-21 (project_stripe_live_post_bv_kvk memory rule)
  //   - checkByokAnthropicGateStub: MFA_ENCRYPTION_KEY unset on
  //     staging (verified via earlier post-deploy-verify run);
  //     activates when the operator SSH-writes the key.
  checkFleetEventsGateStub,
  // Mirrors the activation-gate-pattern-cross-source-invariant
  // test's FEATURES table (apps/server/tests/unit/activation-
  // gate-pattern-cross-source-invariant.test.ts). Compile-time
  // test pins source-level shape; these checks pin the deployed
  // runtime shape. When a gate genuinely flips on (founder
  // intentionally activates), the corresponding check fails —
  // intentional signal to the operator that the activation
  // commit must also remove this assertion.
  checkBillingGateStub,
  checkByokAnthropicGateStub,
].filter(Boolean);

let allOk = true;
const results = [];
for (const fn of checks) {
  const r = await fn();
  results.push(r);
  if (!r.ok) allOk = false;
}

if (jsonOut) {
  console.log(
    JSON.stringify(
      {
        base_url: baseUrl,
        expected_sha: expectedSha,
        ok: allOk,
        pass: results.filter((r) => r.ok).length,
        fail: results.filter((r) => !r.ok).length,
        checks: results,
      },
      null,
      2,
    ),
  );
} else {
  for (const r of results) {
    if (r.ok) {
      console.log(`OK  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    } else {
      console.error(`FAIL ${r.name} — ${r.detail}`);
    }
  }
}
process.exit(allOk ? 0 : 1);

async function checkHealth() {
  return jsonCheck('/health', (body, status) => {
    if (status !== 200) return `expected 200, got ${status}`;
    if (body?.ok !== true) return `expected {ok:true}, got ${JSON.stringify(body)}`;
    return null;
  });
}

async function checkVersionShape() {
  return jsonCheck('/version', (body, status) => {
    if (status !== 200) return `expected 200, got ${status}`;
    const required = ['version', 'git_sha', 'started_at', 'node_version', 'driver'];
    for (const k of required) {
      if (typeof body?.[k] !== 'string') return `/version missing string field "${k}"`;
    }
    return null;
  });
}

async function checkVersionMatchesSha() {
  return jsonCheck(
    '/version',
    (body, status) => {
      if (status !== 200) return `expected 200, got ${status}`;
      const actual = String(body?.git_sha ?? '');
      // Allow either a prefix-match or full-equality (deploy-bridge writes
      // the short SHA; operator might pass the long one or vice-versa).
      if (!actual.startsWith(expectedSha) && !expectedSha.startsWith(actual)) {
        return `/version git_sha "${actual}" does not match expected "${expectedSha}"`;
      }
      return null;
    },
    '/version git_sha matches --expected-sha',
  );
}

async function checkStatusEndpoint() {
  return jsonCheck('/v1/status', (body, status) => {
    if (status !== 200) return `expected 200, got ${status}`;
    if (typeof body?.overall_status !== 'string') return '/v1/status missing overall_status';
    if (!Array.isArray(body?.components)) return '/v1/status missing components[]';
    // V-545.A — recent_incidents is now a populated PublicIncidentSummary
    // array (was a never[] placeholder pre-4e2c199). Empty array is
    // valid (no public incidents); array of objects with the expected
    // keys is valid. Anything else (string, undefined, object) is drift.
    if (!Array.isArray(body?.recent_incidents)) return '/v1/status missing recent_incidents[]';
    return null;
  });
}

async function checkStatusIncidentsList() {
  return jsonCheck('/v1/status/incidents', (body, status) => {
    if (status !== 200) return `expected 200, got ${status}`;
    if (!Array.isArray(body?.data)) return '/v1/status/incidents missing data[]';
    return null;
  });
}

async function checkStatusIncidentDetailRoute() {
  // V-545.A — verifies the route is REGISTERED (returns the route
  // handler's NotFoundError shape) and not an Astro/CDN 404. Uses an
  // intentionally-not-existing id; we expect the 404 response body to
  // include the RFC 7807 "Incident ... not found." detail, not a
  // generic HTML 404 page.
  const url = `${baseUrl}/v1/status/incidents/inc_00000000-0000-0000-0000-000000000000`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    return { ok: false, name: '/v1/status/incidents/:id', detail: `fetch failed: ${err.message}` };
  }
  if (res.status !== 404) {
    return {
      ok: false,
      name: '/v1/status/incidents/:id',
      detail: `expected 404, got ${res.status}`,
    };
  }
  const ctype = res.headers.get('content-type') ?? '';
  if (!ctype.includes('json')) {
    return {
      ok: false,
      name: '/v1/status/incidents/:id',
      detail: `404 not from the route handler (content-type=${ctype})`,
    };
  }
  const body = await res.json();
  if (!String(body?.detail ?? '').includes('not found')) {
    return {
      ok: false,
      name: '/v1/status/incidents/:id',
      detail: `404 body missing 'not found' detail (got: ${JSON.stringify(body).slice(0, 120)})`,
    };
  }
  return {
    ok: true,
    name: '/v1/status/incidents/:id',
    detail: 'route registered (V-545.A) — 404 carries ProblemJson detail',
  };
}

async function checkAccountOauthLinksRoute() {
  // V-667.C-followup — verifies /v1/account/me/oauth-links is
  // registered (returns 401 without auth, not 404). 404 would
  // indicate AppDeps.oauthLinksRepo wasn't passed; 401 means the
  // route is mounted and protected as designed.
  const url = `${baseUrl}/v1/account/me/oauth-links`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    return {
      ok: false,
      name: '/v1/account/me/oauth-links',
      detail: `fetch failed: ${err.message}`,
    };
  }
  if (res.status !== 401) {
    return {
      ok: false,
      name: '/v1/account/me/oauth-links',
      detail: `expected 401 (route registered + auth-gated), got ${res.status}`,
    };
  }
  return {
    ok: true,
    name: '/v1/account/me/oauth-links',
    detail: 'route registered (V-667.C-followup) — 401 confirms requireAuth gate',
  };
}

async function checkAdminCostConfigRoute() {
  // V-541.B — /v1/admin/cost/config is admin-scoped (requireScope
  // 'driftstack_internal_admin'). An unauthed request returns 401
  // when registered + auth-gated. 404 would indicate AppDeps.cost-
  // monitoring service isn't wired.
  const url = `${baseUrl}/v1/admin/cost/config`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    return { ok: false, name: '/v1/admin/cost/config', detail: `fetch failed: ${err.message}` };
  }
  if (res.status === 404) {
    return {
      ok: false,
      name: '/v1/admin/cost/config',
      detail: '404 — cost-monitoring service not wired into AppDeps',
    };
  }
  if (res.status !== 401) {
    return {
      ok: false,
      name: '/v1/admin/cost/config',
      detail: `expected 401 (auth-gated), got ${res.status}`,
    };
  }
  return {
    ok: true,
    name: '/v1/admin/cost/config',
    detail: 'route registered (V-541.B) — 401 confirms admin scope gate',
  };
}

async function checkOpenapi() {
  return jsonCheck('/openapi.json', (body, status) => {
    if (status !== 200) return `expected 200, got ${status}`;
    if (!body?.paths || typeof body.paths !== 'object') return '/openapi.json missing .paths';
    const required = [
      '/v1/status/incidents',
      // V-545.A — detail endpoint shows up post-aa0d65c0; pre-that
      // deploys would surface as a /openapi-out-of-date signal here.
      '/v1/status/incidents/{id}',
    ];
    for (const p of required) {
      if (!body.paths[p]) return `/openapi.json missing path "${p}"`;
    }
    return null;
  });
}

// Activation-gate posture checks — each gated feature returns the
// SAME problem-type URI when the route's AppDeps service is omitted
// from bootstrap. We assert: status === 503 AND
// type === `https://errors.driftstack.dev/feature-unavailable`.
//
// These checks intentionally do NOT auth — the route handler runs
// the activation-gate stub BEFORE the requireAuth preHandler in
// disabled posture, so an anonymous request gets 503 + problem-doc.
// If a regression flips the gate, the check fails with the actual
// (wrong) status / type — caller sees the drift at deploy time.
// (FEATURE_UNAVAILABLE_TYPE hoisted to the top of the module to avoid
// the temporal dead zone — see the constant's declaration site.)

// 4 activated-gate check fns removed 2026-05-19 — see the `const checks`
// declaration site for the activation commits + remaining-gate roster.

async function checkBillingGateStub() {
  // POST /v1/billing/checkout-session is one of the four billing
  // routes the activation gate covers. The disabled stub returns
  // 503 + FeatureUnavailable until the deploy has all three Stripe
  // env vars (STRIPE_SECRET_KEY + DRIFTSTACK_TIER_PRICE_IDS +
  // STRIPE_TRIAL_PACK_PRICE_ID) and bootstrap wires BillingService.
  return featureGateStub(
    'POST',
    '/v1/billing/checkout-session',
    'billing checkout-session gate',
    {},
  );
}

async function checkByokAnthropicGateStub() {
  // PUT /v1/account/me/byok-anthropic-key is the canonical write
  // endpoint for the BYOK customer-key storage feature. Gated on
  // MFA_ENCRYPTION_KEY being set (per Q1 verdict 2026-05-17 the
  // BYOK service reuses the MFA key for AES-256-GCM at-rest
  // encryption). When unset, the route returns 503 + the typed
  // "BYOK Anthropic key storage is not enabled" detail.
  return featureGateStub(
    'PUT',
    '/v1/account/me/byok-anthropic-key',
    'AI-CHAT byok-anthropic gate',
    { api_key: 'sk-ant-noop-test' },
  );
}

// checkRecipesGateStub removed 2026-05-19 — recipesRepo wired (b165c8dd);
// gate is no longer stubbed.

async function checkFleetEventsGateStub() {
  // V-820 /v1/fleet/events is a GET (WebSocket upgrade in the wired
  // posture; plain GET in the stub posture). Body irrelevant; we
  // just need to provoke the route handler.
  const url = `${baseUrl}/v1/fleet/events`;
  let res;
  try {
    res = await fetch(url, { method: 'GET' });
  } catch (err) {
    return { ok: false, name: 'V-820 fleet-events gate', detail: `fetch failed: ${err.message}` };
  }
  if (res.status !== 503) {
    return {
      ok: false,
      name: 'V-820 fleet-events gate',
      detail: `expected 503 (FeatureUnavailable stub); got ${res.status}`,
    };
  }
  let parsed;
  try {
    parsed = await res.json();
  } catch (err) {
    return {
      ok: false,
      name: 'V-820 fleet-events gate',
      detail: `non-JSON 503 body: ${err.message}`,
    };
  }
  if (parsed?.type !== FEATURE_UNAVAILABLE_TYPE) {
    return {
      ok: false,
      name: 'V-820 fleet-events gate',
      detail: `expected type=${FEATURE_UNAVAILABLE_TYPE}, got ${JSON.stringify(parsed?.type)}`,
    };
  }
  if (typeof parsed?.detail !== 'string' || parsed.detail.length < 8) {
    return {
      ok: false,
      name: 'V-820 fleet-events gate',
      detail: `503 body has empty/short detail (got ${JSON.stringify(parsed?.detail)})`,
    };
  }
  return {
    ok: true,
    name: 'V-820 fleet-events gate',
    detail: '503 + problem-type FeatureUnavailable + populated detail as expected',
  };
}

async function featureGateStub(method, path, name, body) {
  const url = `${baseUrl}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, name, detail: `fetch failed: ${err.message}` };
  }
  // Per the activation-gate contract, this MUST be 503. A 200 means
  // the route went live without our intending it (founder didn't
  // flip the gate); a 404 means the route doesn't register at all
  // (broken else branch in app.ts); a 401/403 means an auth hook
  // ran ahead of the stub (route wiring drift).
  if (res.status !== 503) {
    return {
      ok: false,
      name,
      detail: `expected 503 (FeatureUnavailable stub); got ${res.status}`,
    };
  }
  let parsed;
  try {
    parsed = await res.json();
  } catch (err) {
    return { ok: false, name, detail: `non-JSON 503 body: ${err.message}` };
  }
  if (parsed?.type !== FEATURE_UNAVAILABLE_TYPE) {
    return {
      ok: false,
      name,
      detail: `expected type=${FEATURE_UNAVAILABLE_TYPE}, got ${JSON.stringify(parsed?.type)}`,
    };
  }
  // Detail string powers the dashboard's user-facing message. An
  // empty detail surfaces as a blank toast; treat as gate-drift.
  // Matches the activation-gate-pattern-cross-source-invariant
  // compile-time check.
  if (typeof parsed?.detail !== 'string' || parsed.detail.length < 8) {
    return {
      ok: false,
      name,
      detail: `503 body has empty/short detail (got ${JSON.stringify(parsed?.detail)}); dashboard would render a blank toast`,
    };
  }
  return {
    ok: true,
    name,
    detail: `503 + problem-type FeatureUnavailable + populated detail as expected`,
  };
}

async function checkUnknownPath404() {
  // Sanity: an unknown path returns 404 (not 500). Confirms Fastify
  // error handler is wired and the server didn't fall into a panic
  // mode that maps every miss to 5xx.
  const url = `${baseUrl}/this-path-should-never-exist-${Date.now()}`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    return { ok: false, name: 'unknown-path 404', detail: `fetch failed: ${err.message}` };
  }
  if (res.status !== 404) {
    return { ok: false, name: 'unknown-path 404', detail: `expected 404, got ${res.status}` };
  }
  return { ok: true, name: 'unknown-path 404', detail: 'Fastify default 404 fires' };
}

async function jsonCheck(path, predicate, displayName) {
  const url = `${baseUrl}${path}`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    return { ok: false, name: displayName ?? path, detail: `fetch failed: ${err.message}` };
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    return {
      ok: false,
      name: displayName ?? path,
      detail: `response body not JSON: ${err.message}`,
    };
  }
  const err = predicate(body, res.status);
  if (err) return { ok: false, name: displayName ?? path, detail: err };
  return { ok: true, name: displayName ?? path };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (typeof v === 'string' && !v.startsWith('--')) {
        out[k] = v;
        i += 1;
      } else {
        out[k] = 'true';
      }
    }
  }
  return out;
}
