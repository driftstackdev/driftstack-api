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
//   node scripts/post-deploy-verify.mjs --base-url https://api.driftstack.dev \
//     --expected-driver mock --expected-agent-execution live
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
// #21 — execution-posture pins. Production deliberately runs DRIVER=mock (the
// real browser work happens on the fleet, not in-process), so a boot guard that
// REFUSED mock-in-production would brick every prod deploy. The honest place to
// state the expectation is here, per-environment, where a drift fails the deploy
// and auto-reverts instead of silently changing how customer sessions execute.
// Opt-in: unset means "not asserted", so every existing invocation is unchanged.
const expectedDriver = args['expected-driver'] ?? null;
const expectedAgentExecution = args['expected-agent-execution'] ?? null;
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
const UNAUTHORIZED_TYPE = 'https://errors.driftstack.dev/unauthorized';

// Deploy-verify transient-retry tuning. Hoisted here (not beside the
// fetch helpers further down) for the SAME temporal-dead-zone reason as
// FEATURE_UNAVAILABLE_TYPE above: the top-level `for (const fn of
// checks)` loop fires the fetch helpers before their definition site is
// reached at module eval, so these consts must be initialized first.
const VERIFY_MAX_ATTEMPTS = 4;
const VERIFY_TIMEOUT_MS = 15_000;
const VERIFY_BACKOFF_MS = 2_000;

// Each check returns { ok, name, detail }; the verifier collects all
// results and exits non-zero only at the end so a single failure
// doesn't mask a second one.
const checks = [
  checkHealth,
  checkVersionShape,
  expectedSha ? checkVersionMatchesSha : null,
  expectedDriver || expectedAgentExecution ? checkExecutionPosture : null,
  checkStatusEndpoint,
  checkStatusIncidentsList,
  checkStatusIncidentDetailRoute,
  checkAccountOauthLinksRoute,
  // 2026-05-20 — Slice 3+4+5 ARC 3 agent-sessions surface probes.
  // A regression that drops these from deploys returns 404 instead
  // of the expected 401.
  checkAgentSessionsModeRoute,
  checkAgentSessionsInputEventRoute,
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
  // Remaining posture checks stay because their underlying features
  // may be intentionally disabled on one environment and active on
  // another:
  //   - checkFleetEventsGateStub: WebSocket handler still not
  //     implemented (V-820 follow-up slice pending)
  //   - checkBillingPosture: accepts only the typed disabled stub or
  //     the typed active authentication boundary. This keeps staging
  //     and production independently deployable without allowing a
  //     missing route or malformed problem response to pass.
  //   - checkByokAnthropicGateStub: MFA_ENCRYPTION_KEY unset on
  //     staging (verified via earlier post-deploy-verify run);
  //     activates when the operator SSH-writes the key.
  checkFleetEventsGateStub,
  // Mirrors the activation-gate-pattern-cross-source-invariant
  // test's FEATURES table (apps/server/tests/unit/activation-
  // gate-pattern-cross-source-invariant.test.ts). Compile-time
  // test pins source-level shape; these checks pin the deployed
  // runtime shape.
  checkBillingPosture,
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
    if (['', 'unknown', '0.0.0'].includes(body.version.trim())) {
      return `/version contains placeholder build version "${body.version}"`;
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

async function checkExecutionPosture() {
  const wanted = [
    expectedDriver === null ? null : `driver=${expectedDriver}`,
    expectedAgentExecution === null ? null : `agent_execution=${expectedAgentExecution}`,
  ]
    .filter(Boolean)
    .join(' ');
  return jsonCheck(
    '/version',
    (body, status) => {
      if (status !== 200) return `expected 200, got ${status}`;
      // Both fields are reported by /version and both decide how a customer's
      // session actually runs, so a silent flip is invisible until sessions
      // behave differently. `driver` selects the in-process browser driver;
      // `agent_execution` reports whether the fleet control plane is wired
      // ("live") or the stub executor is answering ("simulated"). Prod running
      // "simulated" would hand customers synthetic per-intent successes.
      const driver = String(body?.driver ?? '');
      const execution = String(body?.agent_execution ?? '');
      if (expectedDriver !== null && driver !== expectedDriver) {
        return `/version driver "${driver}" does not match expected "${expectedDriver}"`;
      }
      if (expectedAgentExecution !== null && execution !== expectedAgentExecution) {
        return `/version agent_execution "${execution}" does not match expected "${expectedAgentExecution}"`;
      }
      return null;
    },
    `/version execution posture matches ${wanted}`,
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
    res = await fetchWithRetry(url);
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

async function checkAgentSessionsModeRoute() {
  // Slice 3 (Wave 29-NNN ARC 3) — POST /v1/agent-sessions/:id/mode
  // requires auth. An unauthed POST against a fake session id should
  // return 401 (auth gate fires before the session existence check).
  // 404 indicates the route wasn't registered (agent-sessions repo
  // not wired into AppDeps).
  const url = `${baseUrl}/v1/agent-sessions/ses_00000000-0000-0000-0000-000000000000/mode`;
  let res;
  try {
    res = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'manual' }),
    });
  } catch (err) {
    return {
      ok: false,
      name: '/v1/agent-sessions/:id/mode',
      detail: `fetch failed: ${err.message}`,
    };
  }
  if (res.status !== 401) {
    return {
      ok: false,
      name: '/v1/agent-sessions/:id/mode',
      detail: `expected 401 (route registered + auth-gated), got ${res.status}`,
    };
  }
  return {
    ok: true,
    name: '/v1/agent-sessions/:id/mode',
    detail: 'route registered (Slice 3 ARC 3) — 401 confirms requireAuth gate',
  };
}

async function checkAgentSessionsInputEventRoute() {
  // Slice 4+5 (Wave 29-NNN ARC 3) — POST /v1/agent-sessions/:id/
  // input-event requires auth. Same probe pattern as /mode above.
  const url = `${baseUrl}/v1/agent-sessions/ses_00000000-0000-0000-0000-000000000000/input-event`;
  let res;
  try {
    res = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: { type: 'ping', timestamp: 0 } }),
    });
  } catch (err) {
    return {
      ok: false,
      name: '/v1/agent-sessions/:id/input-event',
      detail: `fetch failed: ${err.message}`,
    };
  }
  if (res.status !== 401) {
    return {
      ok: false,
      name: '/v1/agent-sessions/:id/input-event',
      detail: `expected 401 (route registered + auth-gated), got ${res.status}`,
    };
  }
  return {
    ok: true,
    name: '/v1/agent-sessions/:id/input-event',
    detail: 'route registered (Slice 4+5 ARC 3) — 401 confirms requireAuth gate',
  };
}

async function checkAccountOauthLinksRoute() {
  // V-667.C-followup — the route only registers when AppDeps.oauthClient
  // is fully configured (signingSecret + callbackUrlBase + >=1 provider —
  // see bootstrap.ts). That's a legitimate PER-ENVIRONMENT difference, not
  // a deploy regression: prod has real Google/GitHub OAuth app credentials
  // and correctly 401s; staging has never had OAuth app credentials
  // provisioned (no OAUTH_*/GOOGLE_*/GITHUB_* env vars) and correctly
  // 404s — the gate is doing exactly what it's designed to do. 2026-07-02:
  // this check hard-required 401 everywhere, so it failed staging deploys
  // on a pre-existing config gap unrelated to whatever was actually being
  // shipped, tripping the auto-revert. 401 (configured+protected) and 404
  // (deliberately unconfigured on this environment) are both healthy
  // outcomes; only a genuinely unexpected status (5xx, or a 200 that would
  // mean the route is unprotected) should fail the gate.
  const url = `${baseUrl}/v1/account/me/oauth-links`;
  let res;
  try {
    res = await fetchWithRetry(url);
  } catch (err) {
    return {
      ok: false,
      name: '/v1/account/me/oauth-links',
      detail: `fetch failed: ${err.message}`,
    };
  }
  if (res.status !== 401 && res.status !== 404) {
    return {
      ok: false,
      name: '/v1/account/me/oauth-links',
      detail: `expected 401 (configured) or 404 (not configured on this environment), got ${res.status}`,
    };
  }
  return {
    ok: true,
    name: '/v1/account/me/oauth-links',
    detail:
      res.status === 401
        ? 'route registered (V-667.C-followup) — 401 confirms requireAuth gate'
        : 'route not registered on this environment — OAuth client not configured here (expected on staging)',
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
    res = await fetchWithRetry(url);
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

async function checkBillingPosture() {
  // Billing is intentionally allowed to differ by environment. An
  // anonymous checkout request must reach exactly one honest boundary:
  // the typed 503 activation stub when Stripe is not configured, or the
  // typed 401 auth preHandler when BillingService is live. A 404, success,
  // or a mismatched problem type is deployment drift.
  const name = 'billing checkout-session gate';
  let got;
  try {
    got = await fetchJsonWithRetry(`${baseUrl}/v1/billing/checkout-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  } catch (err) {
    return {
      ok: false,
      name,
      detail: `request failed after ${VERIFY_MAX_ATTEMPTS.toString()} attempts: ${err.message}`,
    };
  }

  if (got.status === 401) {
    if (got.body?.type !== UNAUTHORIZED_TYPE) {
      return {
        ok: false,
        name,
        detail: `401 but expected type=${UNAUTHORIZED_TYPE}, got ${JSON.stringify(got.body?.type)}`,
      };
    }
    return {
      ok: true,
      name,
      detail: 'live posture: 401 Unauthorized confirms BillingService auth boundary',
    };
  }

  if (got.status === 503) {
    if (got.body?.type !== FEATURE_UNAVAILABLE_TYPE) {
      return {
        ok: false,
        name,
        detail: `503 but expected type=${FEATURE_UNAVAILABLE_TYPE}, got ${JSON.stringify(got.body?.type)}`,
      };
    }
    if (typeof got.body?.detail !== 'string' || got.body.detail.length < 8) {
      return {
        ok: false,
        name,
        detail: `503 body has empty/short detail (got ${JSON.stringify(got.body?.detail)})`,
      };
    }
    return {
      ok: true,
      name,
      detail: 'disabled posture: 503 FeatureUnavailable activation stub',
    };
  }

  return {
    ok: false,
    name,
    detail: `expected typed 503 (disabled) or typed 401 (active); got ${got.status}`,
  };
}

async function checkByokAnthropicGateStub() {
  // PUT /v1/account/me/byok-anthropic-key is the canonical write
  // endpoint for the BYOK customer-key storage feature. Gated on
  // MFA_ENCRYPTION_KEY being set (per Q1 verdict 2026-05-17 the
  // BYOK service reuses the MFA key for AES-256-GCM at-rest
  // encryption).
  //
  // 2026-05-21 — BYOK activation gate FLIPPED on after the env
  // template / prod / staging .env rename from MFA_AT_REST_KEY →
  // MFA_ENCRYPTION_KEY (commit 612b4c97). The verify check used to
  // assert 503 (disabled stub); flip expectation to 401 (auth-
  // gated active route). Same shape as the /v1/admin/cost/config
  // check above — anonymous request hits requireAuth before the
  // route handler runs.
  const url = `${baseUrl}/v1/account/me/byok-anthropic-key`;
  let res;
  try {
    res = await fetchWithRetry(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: 'sk-ant-noop-test' }),
    });
  } catch (err) {
    return {
      ok: false,
      name: 'AI-CHAT byok-anthropic gate',
      detail: `fetch failed: ${err.message}`,
    };
  }
  if (res.status !== 401) {
    return {
      ok: false,
      name: 'AI-CHAT byok-anthropic gate',
      detail: `expected 401 (auth-gated active route), got ${res.status}`,
    };
  }
  return {
    ok: true,
    name: 'AI-CHAT byok-anthropic gate',
    detail: 'route ACTIVE (MFA_ENCRYPTION_KEY wired) — 401 confirms requireAuth gate',
  };
}

// checkRecipesGateStub removed 2026-05-19 — recipesRepo wired (b165c8dd);
// gate is no longer stubbed.

async function checkFleetEventsGateStub() {
  // V-820 /v1/fleet/events has TWO valid postures depending on
  // FLEET_CONTROL_PLANE_ENABLED on the target env:
  //   - flag OFF (stub):  plain GET → 503 FeatureUnavailable.
  //   - flag ON  (live):  the WS-upgrade auth preHandler rejects an
  //     unauthenticated GET with 401 Unauthorized (problem+json) BEFORE
  //     the socket opens.
  // Both prove the route is correctly wired; only a different status is a
  // regression. Prod flipped the flag on 2026-06-18 (worker CP-connect) —
  // this check was a HARD 503 assert, so post-deploy-verify then failed on
  // EVERY deploy and the deploy-bridge auto-reverted to the last-good SHA
  // (the activation commit must update its gate-stub assertion, per the
  // checks-list comment above). Accept either posture so deploys land.
  const url = `${baseUrl}/v1/fleet/events`;
  let res;
  try {
    res = await fetchWithRetry(url, { method: 'GET' });
  } catch (err) {
    return { ok: false, name: 'V-820 fleet-events gate', detail: `fetch failed: ${err.message}` };
  }
  let parsed;
  try {
    parsed = await res.json();
  } catch (err) {
    return {
      ok: false,
      name: 'V-820 fleet-events gate',
      detail: `non-JSON body (status ${res.status}): ${err.message}`,
    };
  }
  if (res.status === 503) {
    if (parsed?.type !== FEATURE_UNAVAILABLE_TYPE) {
      return {
        ok: false,
        name: 'V-820 fleet-events gate',
        detail: `503 but expected type=${FEATURE_UNAVAILABLE_TYPE}, got ${JSON.stringify(parsed?.type)}`,
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
      detail: 'stub posture: 503 + FeatureUnavailable + populated detail as expected',
    };
  }
  if (res.status === 401) {
    if (parsed?.type !== UNAUTHORIZED_TYPE) {
      return {
        ok: false,
        name: 'V-820 fleet-events gate',
        detail: `401 but expected type=${UNAUTHORIZED_TYPE}, got ${JSON.stringify(parsed?.type)}`,
      };
    }
    return {
      ok: true,
      name: 'V-820 fleet-events gate',
      detail: 'live posture: 401 Unauthorized (auth preHandler rejects unauthenticated upgrade)',
    };
  }
  return {
    ok: false,
    name: 'V-820 fleet-events gate',
    detail: `expected 503 (stub) or 401 (live auth-gate); got ${res.status}`,
  };
}

async function featureGateStub(method, path, name, body) {
  const url = `${baseUrl}${path}`;
  let res;
  try {
    res = await fetchWithRetry(url, {
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
    res = await fetchWithRetry(url);
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
  let got;
  try {
    got = await fetchJsonWithRetry(url);
  } catch (err) {
    // After VERIFY_MAX_ATTEMPTS the fetch + body-read still threw — a
    // network reject or a "terminated" body stream (the large
    // /openapi.json can be cut off on a cold-started host). This is the
    // exhausted-retry case, not a one-shot blip.
    return {
      ok: false,
      name: displayName ?? path,
      detail: `request failed after ${VERIFY_MAX_ATTEMPTS.toString()} attempts: ${err.message}`,
    };
  }
  const err = predicate(got.body, got.status);
  if (err) return { ok: false, name: displayName ?? path, detail: err };
  return { ok: true, name: displayName ?? path };
}

// ── transient-resilient fetch (deploy-verify hardening, 2026-06-01) ──
// A single transient blip — a network reject, or a "terminated" body
// stream (the large /openapi.json is occasionally cut off on a
// cold-started host) — must NOT fail an otherwise-healthy deploy: that
// would trip the V-549.B auto-revert on a good SHA. The on-host /health
// poll in deploy-bridge.sh already retries 10×; this mirrors that for
// the public verify. We retry only on THROWN errors (network / aborted
// / terminated body) with a per-attempt timeout + linear backoff. A
// definitive wrong STATUS is NOT retried — that's a real check failure
// the predicate reports immediately on the final body.
// (VERIFY_* constants are hoisted to the top of the module — the
// top-level `for (const fn of checks)` loop fires these helpers before
// this declaration site is reached at module-eval time, so leaving the
// consts here would hit the temporal dead zone. Same fix as
// FEATURE_UNAVAILABLE_TYPE — see its declaration comment.)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns the Response; retries the fetch on a thrown network/abort
// error. Used by the status-only route-existence probes.
async function fetchWithRetry(url, opts = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= VERIFY_MAX_ATTEMPTS; attempt += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
    }, VERIFY_TIMEOUT_MS);
    try {
      return await fetch(url, { ...opts, signal: ac.signal });
    } catch (err) {
      lastErr = err;
      if (attempt < VERIFY_MAX_ATTEMPTS) await sleep(VERIFY_BACKOFF_MS * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// Returns { status, body }; retries fetch+json as a UNIT — the observed
// flake was res.json() throwing "terminated" AFTER fetch resolved, so
// the body read must be inside the retry.
async function fetchJsonWithRetry(url, opts = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= VERIFY_MAX_ATTEMPTS; attempt += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
    }, VERIFY_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...opts, signal: ac.signal });
      const body = await response.json();
      return { status: response.status, body };
    } catch (err) {
      lastErr = err;
      if (attempt < VERIFY_MAX_ATTEMPTS) await sleep(VERIFY_BACKOFF_MS * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
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
