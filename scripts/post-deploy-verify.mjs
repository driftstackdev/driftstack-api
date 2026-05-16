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
  checkOpenapi,
  checkUnknownPath404,
].filter(Boolean);

let allOk = true;
for (const fn of checks) {
  const r = await fn();
  if (r.ok) {
    console.log(`OK  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  } else {
    console.error(`FAIL ${r.name} — ${r.detail}`);
    allOk = false;
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
